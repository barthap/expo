import { Blob } from '../index';

const FILE_RANGE = Symbol.for('expo.blob.fileRange');
const MOCK_FILE_READER = Symbol.for('expo.blob.mockFileReader');

const encode = (text: string) => new TextEncoder().encode(text);

// Stands in for the in-memory file system that expo-file-system's mock registers
const files = new Map<string, Uint8Array>();

function readFile(uri: string): Uint8Array {
  const bytes = files.get(uri);
  if (!bytes) {
    throw new Error(`Unable to read the file-backed Blob part from '${uri}'`);
  }
  return bytes;
}

/**
 * Shaped like expo-file-system's `File`: Blob-like, so `instanceof Blob` matches it, and it
 * provides the file range method that lets the Blob constructor take it without reading it.
 */
function createFileLike(reference: unknown) {
  return {
    arrayBuffer: async () => new ArrayBuffer(0),
    bytes: async () => new Uint8Array(0),
    slice() {
      return this;
    },
    text: async () => '',
    size: 0,
    type: 'text/plain',
    [FILE_RANGE]: () => reference,
  };
}

describe('file range as a Blob constructor part', () => {
  const uri = 'file:///mock/document/data.txt';

  beforeEach(() => {
    (globalThis as any)[MOCK_FILE_READER] = readFile;
    files.set(uri, encode('hello world'));
  });

  afterEach(() => {
    delete (globalThis as any)[MOCK_FILE_READER];
    files.clear();
  });

  it('reads the referenced range of the file', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 6, size: 5 }) as any]);

    expect(blob.size).toBe(5);
    expect(await blob.text()).toBe('world');
  });

  it('mixes file ranges with in-memory parts', async () => {
    const blob = new Blob(['<', createFileLike({ uri, offset: 0, size: 5 }) as any, encode('>')]);

    expect(blob.size).toBe(7);
    expect(await blob.text()).toBe('<hello>');
  });

  it('reads the file when the Blob is read, not when it is constructed', async () => {
    // A file-backed part fixes its size at construction, but has no snapshot of the bytes.
    // Reading the bytes up front would defeat the point of a lazy slice of a large file.
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 5 }) as any]);

    files.set(uri, encode('HELLO WORLD'));

    expect(await blob.text()).toBe('HELLO');
  });

  it('keeps the size and returns fewer bytes when the file got shorter', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 6, size: 5 }) as any]);

    files.set(uri, encode('hello wo'));

    expect(blob.size).toBe(5);
    expect(await blob.text()).toBe('wo');
  });

  it('rejects reads after the file was deleted', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 5 }) as any]);

    files.delete(uri);

    await expect(blob.text()).rejects.toThrow(/Unable to read the file-backed Blob part/);
  });

  it('slices a file range without reading it', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 11 }) as any]);

    const slice = blob.slice(6, 9);
    files.set(uri, encode('hello WORLD'));

    expect(slice.size).toBe(3);
    expect(await slice.text()).toBe('WOR');
  });

  it.each([
    ['a missing uri', { offset: 0, size: 1 }],
    ['a non-integer offset', { uri, offset: 1.5, size: 1 }],
    ['a negative offset', { uri, offset: -1, size: 1 }],
    ['a missing size', { uri, offset: 0 }],
    ['a negative size', { uri, offset: 0, size: -1 }],
    ['no reference at all', undefined],
  ])('throws a TypeError for %s', (_, reference) => {
    // Native code would read a missing field as 0 and read the wrong bytes without any error
    expect(() => new Blob([createFileLike(reference) as any])).toThrow(TypeError);
    expect(() => new Blob([createFileLike(reference) as any])).toThrow(/malformed file range/);
  });

  it('throws a RangeError for a range over 2^31 - 1 bytes', () => {
    // Blob sizes are signed 32-bit integers on Android. The error has to say how to get a
    // smaller range instead of failing in native argument conversion.
    const reference = { uri, offset: 0, size: 2 ** 31 };

    expect(() => new Blob([createFileLike(reference) as any])).toThrow(RangeError);
    expect(() => new Blob([createFileLike(reference) as any])).toThrow(/file\.slice\(\)/);
  });

  it('accepts a range of 2^31 - 1 bytes at an offset past 2^31', () => {
    // A small slice far into a file larger than 2 GiB is the main use of file ranges
    const reference = { uri, offset: 2 ** 33, size: 2 ** 31 - 1 };

    const blob = new Blob([createFileLike(reference) as any]);

    expect(blob.size).toBe(2 ** 31 - 1);
  });

  it('still throws for Blob-like objects without a file range', () => {
    const { [FILE_RANGE]: _, ...blobLike } = createFileLike({ uri, offset: 0, size: 1 });

    expect(() => new Blob([blobLike as any])).toThrow(/Blob-like objects cannot be passed/);
  });
});

describe('Blob.stream() of a file range', () => {
  const uri = 'file:///mock/document/large.bin';
  const CHUNK = 64 * 1024;
  let reads = 0;

  beforeEach(() => {
    reads = 0;
    (globalThis as any)[MOCK_FILE_READER] = (fileUri: string) => {
      reads++;
      return readFile(fileUri);
    };
    files.set(
      uri,
      new Uint8Array(3 * CHUNK + 100).map((_, i) => i % 251)
    );
  });

  afterEach(() => {
    delete (globalThis as any)[MOCK_FILE_READER];
    files.clear();
  });

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(value);
    }
  }

  it('reads the file one chunk per pull instead of all at once', async () => {
    // Streaming a slice of a large file must not load the whole slice into memory first.
    // Each chunk reads the file once, and no chunk is larger than 64 KiB.
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 3 * CHUNK + 100 }) as any]);

    const chunks = await readAll(blob.stream());

    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK, CHUNK, CHUNK, 100]);
    expect(reads).toBe(4);
    expect(Buffer.concat(chunks).equals(Buffer.from(files.get(uri)!))).toBe(true);
  });

  it('ends early when the file got shorter', async () => {
    // Without the early end, the stream would keep pulling empty chunks forever
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 3 * CHUNK + 100 }) as any]);
    files.set(uri, files.get(uri)!.slice(0, CHUNK + 10));

    const chunks = await readAll(blob.stream());

    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK, 10]);
  });

  it('errors when the file was deleted', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 0, size: 10 }) as any]);
    files.delete(uri);

    await expect(readAll(blob.stream())).rejects.toThrow(
      /Unable to read the file-backed Blob part/
    );
  });

  it('fills BYOB reads up to the size of the view', async () => {
    const blob = new Blob([createFileLike({ uri, offset: 5, size: 20 }) as any]);
    const reader = blob.stream().getReader({ mode: 'byob' });

    const first = await reader.read(new Uint8Array(16));
    const second = await reader.read(new Uint8Array(16));
    const last = await reader.read(new Uint8Array(16));

    expect(Array.from(first.value!)).toEqual(Array.from(files.get(uri)!.slice(5, 21)));
    expect(Array.from(second.value!)).toEqual(Array.from(files.get(uri)!.slice(21, 25)));
    expect(last.done).toBe(true);
  });

  it('keeps a reference to the source Blob', () => {
    const blob = new Blob(['abc']);

    expect((blob.stream() as any)[Symbol.for('expo.blob.streamSource')]).toBe(blob);
  });
});
