// Jest mock for the ExpoBlob native module, resolved automatically by jest-expo's
// requireNativeModule mock. Provides an in-memory implementation of the native Blob
// SharedObject so the JS wrapper class (and the global Blob override in the expo
// package) works in unit tests.

type NativeBlobPart = string | Uint8Array | Blob;

class Blob {
  readonly size: number;
  readonly type: string;
  private readonly _bytes: Uint8Array;

  constructor(blobParts: NativeBlobPart[] = [], options?: { type?: string }) {
    const chunks = blobParts.map((part) => {
      if (typeof part === 'string') {
        return new TextEncoder().encode(part);
      }
      if (part instanceof Blob) {
        return part._bytes;
      }
      if (ArrayBuffer.isView(part)) {
        return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      }
      throw new TypeError(`Unsupported native BlobPart: ${typeof part}`);
    });
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this._bytes = bytes;
    this.size = bytes.length;
    this.type = options?.type ?? '';
  }

  slice(start = 0, end = this.size, contentType = ''): Blob {
    const sliced = new Blob([], { type: contentType });
    // @ts-expect-error: writing readonly fields of the mock
    sliced._bytes = this._bytes.slice(start, end);
    // @ts-expect-error: writing readonly fields of the mock
    sliced.size = sliced._bytes.length;
    return sliced;
  }

  async bytes(): Promise<Uint8Array> {
    // A copy, like the native implementation: callers must not be able to mutate the blob
    // through the array they get back.
    return this._bytes.slice();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this._bytes);
  }
}

// In-memory stand-in for React Native's native blob store (RCTBlobManager / BlobModule)
const reactNativeBlobStore = new Map<string, Uint8Array>();
let nextBlobId = 0;

function store(blob: Blob): string {
  const blobId = `mock-blob-${nextBlobId++}`;
  // A copy, like the native implementation: the store must not alias the blob's bytes.
  reactNativeBlobStore.set(blobId, blob['_bytes'].slice());
  return blobId;
}

function release(blobId: string): void {
  // Like React Native's `remove`, an unknown id is a no-op.
  reactNativeBlobStore.delete(blobId);
}

export { Blob, store, release, reactNativeBlobStore };
export default { Blob, store, release, reactNativeBlobStore };
