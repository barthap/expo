// Jest mock for the ExpoBlob native module, resolved automatically by jest-expo's
// requireNativeModule mock. Provides an in-memory implementation of the native Blob
// SharedObject so the JS wrapper class (and the global Blob override in the expo
// package) works in unit tests.

type NativeBlobPart = string | Uint8Array | Blob;

/**
 * Reads the whole content of a file for a file-backed Blob part, or throws when the file is
 * missing. The mock has no file system of its own: a package with an in-memory file system mock
 * (such as expo-file-system) registers its reader under this key.
 */
const FILE_READER_KEY = Symbol.for('expo.blob.mockFileReader');
type MockFileReader = (uri: string) => Uint8Array;

function readMockFile(uri: string): Uint8Array {
  const reader = (globalThis as { [FILE_READER_KEY]?: MockFileReader })[FILE_READER_KEY];
  if (!reader) {
    throw new Error(`No mock file reader is registered, so '${uri}' cannot be read`);
  }
  return reader(uri);
}

class Blob {
  readonly size: number;
  readonly type: string;
  // Returns the current bytes. In-memory parts are fixed; file-backed parts read the file on
  // every call, like the native implementation.
  private readonly _read: () => Uint8Array;

  constructor(blobParts: NativeBlobPart[] = [], options?: { type?: string }) {
    const readers = blobParts.map((part): (() => Uint8Array) => {
      if (typeof part === 'string') {
        const encoded = new TextEncoder().encode(part);
        return () => encoded;
      }
      if (part instanceof Blob) {
        return part._read;
      }
      if (ArrayBuffer.isView(part)) {
        const view = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
        return () => view;
      }
      throw new TypeError(`Unsupported native BlobPart: ${typeof part}`);
    });
    this._read = () => concat(readers.map((read) => read()));
    this.size = blobParts.reduce((sum, part) => {
      if (typeof part === 'string') {
        return sum + new TextEncoder().encode(part).length;
      }
      return sum + (part instanceof Blob ? part.size : part.byteLength);
    }, 0);
    this.type = options?.type ?? '';
  }

  slice(start = 0, end = this.size, contentType = ''): Blob {
    const relativeStart = start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size);
    const relativeEnd = end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size);
    return createBlob(
      Math.max(relativeEnd - relativeStart, 0),
      () => this._read().slice(relativeStart, relativeEnd),
      contentType
    );
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    // A copy, like the native implementation: callers must not be able to mutate the blob
    // through the array they get back.
    return this._read().slice();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this._read());
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function createBlob(size: number, read: () => Uint8Array, type: string): Blob {
  const blob = new Blob([], { type });
  // @ts-expect-error: writing readonly fields of the mock
  blob.size = size;
  // @ts-expect-error: writing readonly fields of the mock
  blob._read = read;
  return blob;
}

// In-memory stand-in for React Native's native blob store (RCTBlobManager / BlobModule)
const reactNativeBlobStore = new Map<string, Uint8Array>();
let nextBlobId = 0;

function store(blob: Blob): string {
  const blobId = `mock-blob-${nextBlobId++}`;
  // A copy, like the native implementation: the store must not alias the blob's bytes.
  reactNativeBlobStore.set(blobId, blob['_read']().slice());
  return blobId;
}

function release(blobId: string): void {
  // Like React Native's `remove`, an unknown id is a no-op.
  reactNativeBlobStore.delete(blobId);
}

function fromReactNativeBlob(reference: { blobId: string; offset: number; size: number }): Blob {
  const stored = reactNativeBlobStore.get(reference.blobId);
  if (!stored) {
    throw new Error(
      `Blob with id '${reference.blobId}' could not be resolved from the React Native blob store`
    );
  }
  const { offset, size } = reference;
  // Like the native implementation: `slice` would clamp a bad range instead of failing
  if (offset < 0 || size < 0 || offset + size > stored.length) {
    throw new Error(
      `The range of the React Native Blob with id '${reference.blobId}' lies outside of its bytes in the React Native blob store`
    );
  }
  // A copy, like the native implementation: the Blob must not depend on the store entry
  return new Blob([stored.slice(offset, offset + size)]);
}

function fromFileRange(reference: { uri: string; offset: number; size: number }): Blob {
  const { uri, offset, size } = reference;
  // Like the native implementation: the file is read on every read, not here
  return createBlob(size, () => readMockFile(uri).slice(offset, offset + size), '');
}

export { Blob, store, release, fromReactNativeBlob, fromFileRange, reactNativeBlobStore };
export default { Blob, store, release, fromReactNativeBlob, fromFileRange, reactNativeBlobStore };
