import { Blob, isBlobLike } from '..';

describe('Blob[Symbol.hasInstance]', () => {
  it('matches real Blob instances', () => {
    expect(new Blob(['hello']) instanceof Blob).toBe(true);
  });

  it('matches duck-typed Blob-like objects', () => {
    const fileLike = {
      arrayBuffer: async () => new ArrayBuffer(0),
      slice: () => fileLike,
      text: async () => '',
      size: 0,
      type: 'text/plain',
    };
    expect(isBlobLike(fileLike)).toBe(true);
    expect(fileLike instanceof Blob).toBe(true);
  });

  describe('subclasses', () => {
    // A subclass inherits the static `Symbol.hasInstance`. Duck-typing must not leak into it:
    // `instanceof Sub` has to keep meaning "was built by Sub", otherwise a plain Blob or any
    // Blob-like object would claim to be an instance of a class it knows nothing about.
    class Sub extends Blob {}

    it('does not report a plain Blob as an instance of a subclass', () => {
      expect(new Blob(['hello']) instanceof Sub).toBe(false);
    });

    it('does not report a Blob-like object as an instance of a subclass', () => {
      const fileLike = {
        arrayBuffer: async () => new ArrayBuffer(0),
        slice: () => fileLike,
        text: async () => '',
        size: 0,
        type: 'text/plain',
      };
      expect(fileLike instanceof Sub).toBe(false);
    });

    it('reports a subclass instance as an instance of both the subclass and Blob', () => {
      const sub = new Sub(['hello']);
      expect(sub instanceof Sub).toBe(true);
      expect(sub instanceof Blob).toBe(true);
    });
  });

  describe("expo-file-system's File", () => {
    // `File.type` is typed as `string` but the native getters return `nil`/`null` when the
    // file extension maps to no known MIME type — see `FileSystemFile.swift` `var type: String?`
    // and `FileSystemFile.kt` `val type: String?`.
    const fileWithNullType = {
      arrayBuffer: async () => new ArrayBuffer(0),
      slice: () => fileWithNullType,
      text: async () => '',
      size: 12,
      type: null,
    };

    it('accepts a null type', () => {
      expect(isBlobLike(fileWithNullType)).toBe(true);
      expect(fileWithNullType instanceof Blob).toBe(true);
    });
  });
});
