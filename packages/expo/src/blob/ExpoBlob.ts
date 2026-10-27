import { requireNativeModule } from 'expo-modules-core';

import type {
  BlobPart,
  ExpoBlobModule,
  FileRangeReference,
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
    let getBlobBytes: (() => Promise<Uint8Array>) | null = this.bytes.bind(this);
    let offset = 0;
    let cachedBytes: Uint8Array | null = null;

    return new ReadableStream({
      type: 'bytes',
      async pull(controller: ReadableByteStreamController) {
        if (!cachedBytes) {
          if (!getBlobBytes) {
            throw new Error('Cannot read from a closed stream');
          }
          cachedBytes = await getBlobBytes();
          getBlobBytes = null;
        }

        if (offset >= cachedBytes.length) {
          controller.close();
          cachedBytes = null;
          return;
        }

        if (controller.byobRequest?.view) {
          const view: Uint8Array = new Uint8Array(
            controller.byobRequest.view.buffer,
            controller.byobRequest.view.byteOffset,
            controller.byobRequest.view.byteLength
          );
          const end = Math.min(offset + view.byteLength, cachedBytes.length);
          const chunk = cachedBytes.subarray(offset, end);
          view.set(chunk, 0);
          controller.byobRequest.respond(chunk.length);
          offset = end;
          if (offset >= cachedBytes.length) {
            controller.close();
            cachedBytes = null;
          }
          return;
        }

        const chunkSize = DEFAULT_CHUNK_SIZE;
        const end = Math.min(offset + chunkSize, cachedBytes.length);
        controller.enqueue(cachedBytes.subarray(offset, end) as ArrayBufferView<ArrayBuffer>);
        offset = end;
      },
    });
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
