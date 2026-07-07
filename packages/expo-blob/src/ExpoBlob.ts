import { requireNativeModule } from 'expo';

import type { BlobPart, ExpoBlobModule } from './ExpoBlob.types';
import {
  DEFAULT_CHUNK_SIZE,
  isBlobLike,
  isTypedArray,
  normalizedContentType,
  preprocessOptions,
} from './utils';

const NativeBlobModule = requireNativeModule<ExpoBlobModule>('ExpoBlob');

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
  if (isBlobLike(blobPart)) {
    throw new TypeError(
      'Blob-like objects (such as expo-file-system File) cannot be passed to the Blob ' +
        'constructor directly, because their bytes cannot be read synchronously. ' +
        'Read the data first, for example: new Blob([await file.bytes()]).'
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

    const processedBlobParts: BlobPart[] = [];

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
