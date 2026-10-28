import { requireNativeModule } from 'expo-modules-core';

import type {
  BlobPart,
  ExpoBlobModule,
  FileRangeReference,
  FileSinkReference,
  NativeBlob,
  ReactNativeBlobReference,
} from './ExpoBlob.types';
import {
  DEFAULT_CHUNK_SIZE,
  isBlobLike,
  isReactNativeBlob,
  isTypedArray,
  normalizedContentType,
  preprocessOptions,
} from './utils';

const NativeBlobModule = requireNativeModule<ExpoBlobModule>('ExpoBlob');

/**
 * Copies the bytes of a React Native built-in `Blob` out of React Native's native blob store
 * into a native Blob, which the constructor then takes as an ordinary Blob part. The copy is
 * made right away, so the new Blob does not depend on the React Native Blob afterwards:
 * `close()` or garbage collection of it cannot change our bytes.
 */
const copyReactNativeBlob = (blobPart: any): NativeBlob => {
  let data: any;
  try {
    data = blobPart.data;
  } catch {
    // React Native's `data` getter throws once `close()` released the bytes
    throw new TypeError(
      'A closed React Native Blob cannot be passed to the Blob constructor, because close() ' +
        'released its bytes. Create the Blob before closing the React Native Blob.'
    );
  }
  // React Native always sets all three fields. A missing one must not reach native code,
  // where it would default to 0 and silently copy the wrong bytes.
  if (typeof data.offset !== 'number' || typeof data.size !== 'number') {
    throw new TypeError(
      `The React Native Blob with id '${data.blobId}' has a malformed handle: ` +
        'its offset and size must be numbers.'
    );
  }
  const reference: ReactNativeBlobReference = {
    blobId: data.blobId,
    // Slices of a React Native Blob share its blobId and point at a range of its bytes
    offset: data.offset,
    size: data.size,
  };
  return NativeBlobModule.fromReactNativeBlob(reference);
};

/**
 * A Blob part that provides this method reads its bytes from a range of a file, for example
 * `expo-file-system`'s `File`. The method returns a `FileRangeReference`. `Symbol.for` lets other
 * packages implement it without importing `expo/blob`.
 */
const FILE_RANGE: unique symbol = Symbol.for('expo.blob.fileRange');

// The Blob that a stream returned by `Blob.stream()` reads from
const STREAM_SOURCE: unique symbol = Symbol.for('expo.blob.streamSource');

/**
 * A `WritableStream` that has this property writes to a file from its start, for example the
 * result of `File.writableStream()` from `expo-file-system`. Its value is a `FileSinkReference`.
 */
const FILE_SINK: unique symbol = Symbol.for('expo.blob.fileSink');

type FileRangeSource = { [FILE_RANGE]: () => FileRangeReference };

// The largest size of a file-backed part: Blob sizes are signed 32-bit integers on Android
const MAX_FILE_RANGE_SIZE = 2 ** 31 - 1;

const isFileRangeSource = (value: unknown): value is FileRangeSource =>
  value != null &&
  typeof value === 'object' &&
  typeof (value as Partial<FileRangeSource>)[FILE_RANGE] === 'function';

/**
 * Creates a native Blob with one part that reads the referenced range of a file on every read,
 * which the constructor then takes as an ordinary Blob part. The file is not read here.
 */
const createFileRangeBlob = (source: FileRangeSource): NativeBlob => {
  // Typed as partial: the method comes from another package and is checked before use
  const reference: Partial<FileRangeReference> | null | undefined = source[FILE_RANGE]();
  const uri = reference?.uri;
  const offset = reference?.offset;
  const size = reference?.size;
  // Native code would read a missing field as 0 and read the wrong bytes without any error
  if (
    typeof uri !== 'string' ||
    typeof offset !== 'number' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0
  ) {
    throw new TypeError(
      'A file-backed Blob part returned a malformed file range: it needs a string uri and ' +
        'non-negative integer offset and size.'
    );
  }
  if (size > MAX_FILE_RANGE_SIZE) {
    throw new RangeError(
      `The file range of '${uri}' is ${size} bytes long, but a Blob can hold at most ` +
        `${MAX_FILE_RANGE_SIZE} bytes of a file. Use file.slice() to take a smaller range.`
    );
  }
  return NativeBlobModule.fromFileRange({ uri, offset, size });
};

// The reference of a file sink with a `file://` URI, or null for any other destination. Other
// schemes, such as a `content://` URI on Android, go through the JS path, which writes them through
// their own handle.
const fileSinkReference = (destination: WritableStream<Uint8Array>): FileSinkReference | null => {
  // Typed as partial: the property comes from another package and is checked before use
  const reference: Partial<FileSinkReference> | null | undefined = (
    destination as { [FILE_SINK]?: Partial<FileSinkReference> | null }
  )[FILE_SINK];
  const uri = reference?.uri;
  const offset = reference?.offset;
  return typeof uri === 'string' && uri.startsWith('file://') && typeof offset === 'function'
    ? { uri, offset }
    : null;
};

// The native copy writes from the start of the file, so it may run only while nothing was written
// through the sink, which would otherwise be overwritten.
const isAtFileStart = (sink: FileSinkReference): boolean => {
  try {
    return sink.offset() === 0;
  } catch {
    return false;
  }
};

// The native copy writes the whole Blob at once, so it cannot honour options that stop a pipe
// halfway or keep the destination open. Options that are not an object are left to the standard
// `pipeTo`, which decides whether to reject them.
const hasPipeOptions = (options: StreamPipeOptions | undefined): boolean =>
  options !== undefined &&
  (typeof options !== 'object' ||
    options === null ||
    !!options.preventClose ||
    !!options.preventAbort ||
    !!options.preventCancel ||
    options.signal != null);

/**
 * Pipes a stream that has not been read yet into a file sink by copying its Blob natively. Locks,
 * closes, and cancels the streams in the same way as `ReadableStream.prototype.pipeTo`.
 */
const pipeToFileSink = async (
  stream: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  blob: NativeBlob,
  sink: FileSinkReference,
  options: StreamPipeOptions | undefined
): Promise<void> => {
  const reader = stream.getReader();
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    writer = destination.getWriter();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  let writtenBefore = false;
  try {
    try {
      await writer.ready;
      // Waits for chunks written before the pipe started, and rejects when the destination is
      // closed or errored, so the file is not written behind a stream that has ended.
      await writer.write(new Uint8Array(0));
      // A chunk written without `await` before the pipe reaches the file only now
      writtenBefore = !isAtFileStart(sink);
      if (!writtenBefore) {
        await NativeBlobModule.writeToFile(blob, sink.uri);
      }
    } catch (error) {
      // No retry through JS: the native copy may already have written some bytes
      await writer.abort(error).catch(() => {});
      await reader.cancel(error).catch(() => {});
      throw error;
    }
    if (!writtenBefore) {
      try {
        // Closes the file handle of the destination, as `pipeTo` does without `preventClose`
        await writer.close();
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      // Every byte is in the file, so the stream ends closed without being read
      await reader.cancel();
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
  if (writtenBefore) {
    // Nothing was read from the stream yet, so the standard pipe writes the whole Blob after them
    await ReadableStream.prototype.pipeTo.call(stream, destination, options);
  }
};

/**
 * Defines `pipeTo` on a stream returned by `Blob.stream()`. Piping into a file sink, such as
 * `File.writableStream()` from `expo-file-system`, copies the Blob to the file natively instead of
 * moving every chunk through JS. Anything the native copy cannot reproduce goes through the
 * standard `pipeTo`. `pipeThrough()` is not covered: the Streams spec has it run the internal pipe
 * algorithm, not this property, so `blob.stream().pipeThrough(t).pipeTo(sink)` takes the JS path.
 */
const installFileSinkPipe = (
  stream: ReadableStream<Uint8Array>,
  blob: NativeBlob,
  isConsumed: () => boolean
): void => {
  const pipeTo: ReadableStream<Uint8Array>['pipeTo'] = function (
    this: ReadableStream<Uint8Array>,
    destination,
    options
  ) {
    const sink = this === stream && destination != null ? fileSinkReference(destination) : null;
    if (
      sink == null ||
      hasPipeOptions(options) ||
      isConsumed() ||
      stream.locked ||
      destination.locked ||
      !isAtFileStart(sink)
    ) {
      return ReadableStream.prototype.pipeTo.call(this, destination, options);
    }
    return pipeToFileSink(stream, destination, blob, sink, options);
  };
  Object.defineProperty(stream, 'pipeTo', { value: pipeTo, writable: true, configurable: true });
};

const inputMapping = (blobPart: BlobPart) => {
  if (blobPart instanceof ArrayBuffer) {
    return new Uint8Array(blobPart);
  }
  if (isTypedArray(blobPart)) {
    return blobPart;
  }
  // Prototype chain check instead of `instanceof Blob`: `Symbol.hasInstance` below also
  // matches duck-typed Blob-like objects, but only actual native Blob instances can be
  // passed to the native constructor.
  if (Object.prototype.isPrototypeOf.call(NativeBlobModule.Blob.prototype, blobPart)) {
    return blobPart;
  }
  // Checked before the generic Blob-like case below, which React Native Blobs also match
  if (isReactNativeBlob(blobPart)) {
    return copyReactNativeBlob(blobPart);
  }
  // Checked before the generic Blob-like case below, which expo-file-system's File also matches
  if (isFileRangeSource(blobPart)) {
    return createFileRangeBlob(blobPart);
  }
  if (isBlobLike(blobPart)) {
    throw new TypeError(
      'Blob-like objects cannot be passed to the Blob constructor directly, because their ' +
        'bytes cannot be read synchronously. Read the data first, for example: ' +
        'new Blob([await blobLike.bytes()]).'
    );
  }
  return String(blobPart);
};

export class Blob extends NativeBlobModule.Blob {
  static [Symbol.hasInstance](instance: any): boolean {
    // Subclasses inherit this method, but duck-typing must not apply to them: `instanceof Sub`
    // has to keep meaning "built by Sub". Fall back to the ordinary prototype-chain check,
    // which does not look up `Symbol.hasInstance` again and so cannot recurse.
    if (this !== Blob) {
      return Function.prototype[Symbol.hasInstance].call(this, instance);
    }
    // Real Blob instances (checked without `instanceof` to avoid recursing into this method)
    if (Object.prototype.isPrototypeOf.call(Blob.prototype, instance)) {
      return true;
    }
    // Duck-typed Blob-like implementations, such as expo-file-system's File
    return isBlobLike(instance);
  }

  constructor(blobParts?: BlobPart[] | Iterable<BlobPart>, options?: BlobPropertyBag) {
    if (!new.target) {
      throw new TypeError("Blob constructor requires 'new' operator");
    }

    const processedBlobParts: (BlobPart | NativeBlob)[] = [];

    if (blobParts === undefined) {
      super([], preprocessOptions(options));
    } else if (blobParts === null || typeof blobParts !== 'object') {
      throw TypeError('Blob constructor requires blobParts to be a non-null object or undefined');
    } else {
      for (const blobPart of blobParts) {
        processedBlobParts.push(inputMapping(blobPart));
      }
      super(processedBlobParts, preprocessOptions(options));
    }
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const normalizedType = normalizedContentType(contentType);
    const slicedBlob = super.slice(start, end, normalizedType);
    Object.setPrototypeOf(slicedBlob, Blob.prototype);
    return slicedBlob as Blob;
  }

  stream(): ReadableStream {
    // Reads one chunk at a time through `slice()`, so streaming a file-backed Blob reads only a
    // chunk-sized range of the file per pull instead of the whole Blob up front.
    const readChunk = (start: number, end: number) => this.slice(start, end).bytes();
    const size = this.size;
    let offset = 0;
    // Set by the first pull or a cancel. A native copy must start from the first byte.
    let consumed = false;

    const stream = new ReadableStream({
      type: 'bytes',
      cancel() {
        consumed = true;
      },
      async pull(controller: ReadableByteStreamController) {
        consumed = true;
        const view = controller.byobRequest?.view;
        if (offset >= size) {
          controller.close();
          controller.byobRequest?.respond(0);
          return;
        }
        const chunkSize = view ? view.byteLength : DEFAULT_CHUNK_SIZE;
        const end = Math.min(offset + chunkSize, size);
        const chunk = await readChunk(offset, end);
        // A file-backed part returns fewer bytes when the file got shorter since the Blob was
        // created. Nothing more can be read then, so the stream ends early.
        if (chunk.length === 0) {
          offset = size;
          controller.close();
          controller.byobRequest?.respond(0);
          return;
        }
        offset = chunk.length < end - offset ? size : offset + chunk.length;

        if (view) {
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(chunk, 0);
          controller.byobRequest!.respond(chunk.length);
        } else {
          controller.enqueue(chunk);
        }
        if (offset >= size) {
          controller.close();
        }
      },
    });
    // Lets a consumer of the stream, such as a native file sink, read the Blob directly
    Object.defineProperty(stream, STREAM_SOURCE, { value: this });

    installFileSinkPipe(stream, this, () => consumed);
    return stream;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return super.bytes().then(
      (bytes: Uint8Array) =>
        // The Blob spec requires we always return a new ArrayBuffer even when its bounds match the TypedArray's
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
  }

  toString(): string {
    return '[object Blob]';
  }

  get [Symbol.toStringTag](): string {
    return 'Blob';
  }

  // Changed the length property to match that of the default js implementation
  static get length() {
    return 0;
  }
}
