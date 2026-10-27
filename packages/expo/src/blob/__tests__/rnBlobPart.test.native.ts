import { reactNativeBlobStore } from '../../../mocks/ExpoBlob';
import { Blob } from '../index';

/**
 * Mirrors the shape of React Native's built-in `Blob` (`react-native/Libraries/Blob/Blob.js`),
 * as produced by XHR with `responseType: 'blob'`: only a `{ blobId, offset, size }` handle into
 * React Native's blob store, with `data`, `size` and `type` getters that throw after `close()`.
 */
function createReactNativeBlob(data: { blobId: string; offset: number; size: number }) {
  return {
    _data: data as typeof data | null,
    get data() {
      if (!this._data) {
        throw new Error('Blob has been closed and is no longer available');
      }
      return this._data;
    },
    get size(): number {
      return this.data.size;
    },
    get type(): string {
      return '';
    },
    slice() {
      return this;
    },
    close() {
      this._data = null;
    },
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe('React Native Blob as a Blob constructor part', () => {
  const blobId = 'rn-owned-blob';

  beforeEach(() => {
    reactNativeBlobStore.set(blobId, encode('hello world'));
  });

  afterEach(() => {
    reactNativeBlobStore.delete(blobId);
  });

  it('copies the bytes from the React Native blob store', async () => {
    const rnBlob = createReactNativeBlob({ blobId, offset: 0, size: 11 });

    const blob = new Blob([rnBlob as any]);

    expect(blob.size).toBe(11);
    expect(await blob.text()).toBe('hello world');
  });

  it('reads only the range of a sliced React Native Blob', async () => {
    // RN slices share the blobId of the source and differ only in offset and size
    const rnSlice = createReactNativeBlob({ blobId, offset: 6, size: 3 });

    const blob = new Blob(['<', rnSlice as any, '>']);

    expect(await blob.text()).toBe('<wor>');
  });

  it('throws a TypeError for a handle without a numeric offset', () => {
    // Native code would read a missing field as 0 and copy the wrong bytes without any error.
    // (A missing size never gets here: the `size` getter reads it, and the Blob check needs a number.)
    const malformed = createReactNativeBlob({ blobId, offset: undefined as any, size: 5 });

    expect(() => new Blob([malformed as any])).toThrow(TypeError);
    expect(() => new Blob([malformed as any])).toThrow(/rn-owned-blob.*malformed handle/);
  });

  it('throws for a range past the end of the stored bytes', () => {
    // The store holds 11 bytes; copying a clamped range would silently return fewer bytes
    const rnBlob = createReactNativeBlob({ blobId, offset: 6, size: 10 });

    expect(() => new Blob([rnBlob as any])).toThrow(/range.*rn-owned-blob.*outside/);
  });

  it('keeps its bytes after the store entry is removed', async () => {
    // The donor can be closed or garbage collected at any time after construction; both remove
    // its entry from React Native's store. The new Blob must not read from that entry later.
    const blob = new Blob([createReactNativeBlob({ blobId, offset: 0, size: 11 }) as any]);

    reactNativeBlobStore.delete(blobId);

    expect(await blob.text()).toBe('hello world');
    expect(await blob.slice(0, 5).text()).toBe('hello');
  });

  it('throws a TypeError for a closed React Native Blob', () => {
    const rnBlob = createReactNativeBlob({ blobId, offset: 0, size: 11 });
    rnBlob.close();

    // A closed blob has no bytes left to copy; the error has to say so instead of surfacing the
    // getter's internal error or a native lookup failure.
    expect(() => new Blob([rnBlob as any])).toThrow(TypeError);
    expect(() => new Blob([rnBlob as any])).toThrow(/closed React Native Blob/);
  });

  it('throws a descriptive error when the id is not in the store', () => {
    const rnBlob = createReactNativeBlob({ blobId: 'unknown-id', offset: 0, size: 1 });

    expect(() => new Blob([rnBlob as any])).toThrow(/unknown-id.*React Native blob store/);
  });
});
