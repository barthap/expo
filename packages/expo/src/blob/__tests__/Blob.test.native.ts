import { Blob } from '..';

describe('Blob', () => {
  it('builds a Blob from string parts', async () => {
    const blob = new Blob(['hello ', 'world'], { type: 'text/plain' });

    expect(blob.size).toBe(11);
    expect(blob.type).toBe('text/plain');
    await expect(blob.text()).resolves.toBe('hello world');
  });

  it('builds a Blob from binary parts', async () => {
    const blob = new Blob([new Uint8Array([104, 105]), new TextEncoder().encode('!')]);

    expect(blob.size).toBe(3);
    await expect(blob.text()).resolves.toBe('hi!');
  });

  // `instanceof` goes through `Blob[Symbol.hasInstance]`, so the class must keep matching
  // its own instances after the move into the `expo` package.
  it('matches its own instances with instanceof', () => {
    expect(new Blob(['a']) instanceof Blob).toBe(true);
    expect({} instanceof Blob).toBe(false);
  });

  // Duck-typed Blob-like values (for example `expo-file-system`'s `File`) must keep
  // passing `instanceof`, because that is what lets them be used as fetch bodies.
  it('matches Blob-like objects with instanceof', () => {
    const blobLike = {
      size: 1,
      type: 'text/plain',
      text: async () => 'a',
      arrayBuffer: async () => new ArrayBuffer(1),
      slice: () => blobLike,
    };

    expect(blobLike instanceof Blob).toBe(true);
  });
});
