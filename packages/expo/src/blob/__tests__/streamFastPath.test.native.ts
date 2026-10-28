import { Blob } from '../index';

const FILE_SINK = Symbol.for('expo.blob.fileSink');
const MOCK_FILE_WRITER = Symbol.for('expo.blob.mockFileWriter');

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

// Stands in for the in-memory file system that expo-file-system's mock registers
const files = new Map<string, Uint8Array>();
// Every call of the native copy, as seen by the mock file writer
const nativeWrites: { uri: string; bytes: Uint8Array }[] = [];

// Writes from the start of the file without truncating it, like `File.writableStream()`
function writeAt(uri: string, position: number, bytes: Uint8Array): void {
  const prior = files.get(uri);
  if (!prior) {
    throw new Error(`Unable to write the Blob to '${uri}'`);
  }
  const merged = new Uint8Array(Math.max(prior.length, position + bytes.length));
  merged.set(prior, 0);
  merged.set(bytes, position);
  files.set(uri, merged);
}

function nativeWriter(uri: string, bytes: Uint8Array): void {
  nativeWrites.push({ uri, bytes });
  writeAt(uri, 0, bytes);
}

/**
 * Shaped like the stream `File.writableStream()` from expo-file-system returns: chunks are written
 * through a handle that starts at the beginning of the file, and the stream is tagged as a file sink.
 */
// `tag: null` leaves the stream untagged. The default tag reports the position of the handle.
function createFileSink(uri: string, tag?: unknown) {
  const sink = {
    position: 0,
    chunks: [] as Uint8Array[],
    closed: 0,
    aborted: [] as unknown[],
  };
  tag = tag === undefined ? { uri, offset: () => sink.position } : tag;
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      sink.chunks.push(chunk);
      writeAt(uri, sink.position, chunk);
      sink.position += chunk.length;
    },
    close() {
      sink.closed++;
    },
    abort(reason) {
      sink.aborted.push(reason);
    },
  });
  if (tag !== null) {
    Object.defineProperty(stream, FILE_SINK, { value: tag });
  }
  return { stream, sink };
}

// Fails the test if the stream reads the Blob through JS: `stream()` reads every chunk with `slice()`
function forbidJsReads(blob: Blob): jest.Mock {
  const slice = jest.fn(() => {
    throw new Error('The Blob was read through JS');
  });
  blob.slice = slice as unknown as Blob['slice'];
  return slice;
}

describe('Blob.stream().pipeTo() into a file sink', () => {
  const uri = 'file:///mock/document/out.bin';
  let originalPipeTo: ReadableStream['pipeTo'];

  beforeEach(() => {
    (globalThis as any)[MOCK_FILE_WRITER] = nativeWriter;
    files.set(uri, new Uint8Array(0));
    originalPipeTo = ReadableStream.prototype.pipeTo;
  });

  afterEach(() => {
    delete (globalThis as any)[MOCK_FILE_WRITER];
    files.clear();
    nativeWrites.length = 0;
    jest.restoreAllMocks();
  });

  it('copies the Blob natively once, without reading it through JS', async () => {
    const blob = new Blob(['hello ', encode('world')]);
    const stream = blob.stream();
    const slice = forbidJsReads(blob);
    const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
    const { stream: destination, sink } = createFileSink(uri);

    await stream.pipeTo(destination);

    expect(nativeWrites).toHaveLength(1);
    expect(nativeWrites[0]!.uri).toBe(uri);
    expect(decode(files.get(uri))).toBe('hello world');
    expect(slice).not.toHaveBeenCalled();
    expect(pipeTo).not.toHaveBeenCalled();
    // Only the empty chunk that waits for earlier writes reaches the sink
    expect(sink.chunks.map((chunk) => chunk.length)).toEqual([0]);
  });

  it('closes the destination and ends the stream after the copy, like pipeTo', async () => {
    const stream = new Blob(['abc']).stream();
    const { stream: destination, sink } = createFileSink(uri);

    await stream.pipeTo(destination);

    // Closing the sink closes the file handle of File.writableStream()
    expect(sink.closed).toBe(1);
    expect(sink.aborted).toEqual([]);
    expect(stream.locked).toBe(false);
    expect(destination.locked).toBe(false);
    const { done } = await stream.getReader().read();
    expect(done).toBe(true);
  });

  it('keeps both streams locked while the native copy runs', async () => {
    const stream = new Blob(['abc']).stream();
    const { stream: destination } = createFileSink(uri);
    let lockedDuringCopy: boolean[] = [];
    let getReaderError: unknown = null;
    (globalThis as any)[MOCK_FILE_WRITER] = (target: string, bytes: Uint8Array) => {
      lockedDuringCopy = [stream.locked, destination.locked];
      try {
        stream.getReader();
      } catch (error) {
        getReaderError = error;
      }
      nativeWriter(target, bytes);
    };

    await stream.pipeTo(destination);

    expect(lockedDuringCopy).toEqual([true, true]);
    expect(getReaderError).toBeInstanceOf(TypeError);
  });

  it('aborts the destination, cancels the stream, and rejects when the native copy fails', async () => {
    const failure = new Error('disk full');
    (globalThis as any)[MOCK_FILE_WRITER] = () => {
      throw failure;
    };
    const stream = new Blob(['abc']).stream();
    const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
    const { stream: destination, sink } = createFileSink(uri);

    await expect(stream.pipeTo(destination)).rejects.toBe(failure);

    expect(sink.aborted).toEqual([failure]);
    expect(sink.closed).toBe(0);
    // No second attempt through JS: the native copy may already have written some bytes
    expect(pipeTo).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    const { done } = await stream.getReader().read();
    expect(done).toBe(true);
  });

  it('writes from the start of the file and keeps bytes past the end of the Blob', async () => {
    files.set(uri, encode('0123456789'));
    const { stream: destination } = createFileSink(uri);

    await new Blob(['abc']).stream().pipeTo(destination);

    // The same bytes the JS path leaves: File.writableStream() does not truncate the file
    expect(decode(files.get(uri))).toBe('abc3456789');
  });

  describe('falls back to the standard pipeTo, and the bytes still arrive', () => {
    async function expectJsPath(
      pipe: (
        stream: ReadableStream<Uint8Array>,
        destination: WritableStream<Uint8Array>
      ) => Promise<void>,
      options: { tag?: unknown; expected?: string } = {}
    ) {
      const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
      const blob = new Blob(['hello world']);
      const { stream: destination } = createFileSink(uri, options.tag);

      await pipe(blob.stream(), destination);

      expect(nativeWrites).toHaveLength(0);
      expect(pipeTo).toHaveBeenCalled();
      expect(decode(files.get(uri))).toBe(options.expected ?? 'hello world');
    }

    it('for a destination without the file sink tag', async () => {
      await expectJsPath((stream, destination) => stream.pipeTo(destination), { tag: null });
    });

    it('for a plain WritableStream', async () => {
      const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
      const chunks: Uint8Array[] = [];
      await new Blob(['hello']).stream().pipeTo(
        new WritableStream({
          write: (chunk) => {
            chunks.push(chunk);
          },
        })
      );
      expect(nativeWrites).toHaveLength(0);
      expect(pipeTo).toHaveBeenCalled();
      expect(decode(chunks[0])).toBe('hello');
    });

    it('for a malformed tag or a uri that is not file://', async () => {
      await expectJsPath((stream, destination) => stream.pipeTo(destination), { tag: {} });
      files.set(uri, new Uint8Array(0));
      await expectJsPath((stream, destination) => stream.pipeTo(destination), {
        tag: { uri: 'content://media/external/file/1' },
      });
    });

    it('for a tag without an offset, or one that is not 0 or unknown', async () => {
      // An offset other than 0 means the handle already wrote bytes that the copy would overwrite
      for (const offset of [undefined, () => 10, () => null]) {
        files.set(uri, new Uint8Array(0));
        await expectJsPath((stream, destination) => stream.pipeTo(destination), {
          tag: { uri, offset },
        });
      }
    });

    it('for a destination that was written to before the pipe, keeping those bytes', async () => {
      const { stream: destination } = createFileSink(uri);
      const writer = destination.getWriter();
      await writer.write(encode('header:'));
      writer.releaseLock();

      await expectJsPath((stream) => stream.pipeTo(destination), {
        expected: 'header:hello world',
      });
    });

    it('for a write that lands only after the pipe started, keeping those bytes', async () => {
      // The chunk is still queued when pipeTo is called, so the offset is 0 at that point
      const { stream: destination } = createFileSink(uri);
      const writer = destination.getWriter();
      const header = writer.write(encode('header:'));
      writer.releaseLock();

      await expectJsPath((stream) => stream.pipeTo(destination), {
        expected: 'header:hello world',
      });
      await header;
    });

    it('for options that are not an object, rejecting like pipeTo', async () => {
      const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
      const { stream: destination } = createFileSink(uri);

      await expect(
        new Blob(['hello']).stream().pipeTo(destination, 5 as unknown as StreamPipeOptions)
      ).rejects.toThrow(TypeError);

      expect(pipeTo).toHaveBeenCalled();
      expect(nativeWrites).toHaveLength(0);
    });

    it.each(['preventClose', 'preventAbort', 'preventCancel'] as const)(
      'for the %s option',
      async (option) => {
        await expectJsPath((stream, destination) => stream.pipeTo(destination, { [option]: true }));
      }
    );

    it('for a signal, which the native copy cannot honour', async () => {
      await expectJsPath((stream, destination) =>
        stream.pipeTo(destination, { signal: new AbortController().signal })
      );
    });

    it('for a stream that has already been read', async () => {
      // `slice(6)` is read by the first pull, so only the rest may reach the file
      const pipeTo = jest.spyOn(ReadableStream.prototype, 'pipeTo');
      const blob = new Blob(['hello ', 'world']);
      const stream = blob.stream();
      const reader = stream.getReader({ mode: 'byob' });
      await reader.read(new Uint8Array(6));
      reader.releaseLock();
      const { stream: destination } = createFileSink(uri);

      await stream.pipeTo(destination);

      expect(nativeWrites).toHaveLength(0);
      expect(pipeTo).toHaveBeenCalled();
      expect(decode(files.get(uri))).toBe('world');
    });

    it('for a cancelled stream, which must not write anything', async () => {
      const stream = new Blob(['hello']).stream();
      await stream.cancel();
      const { stream: destination, sink } = createFileSink(uri);

      await stream.pipeTo(destination);

      expect(nativeWrites).toHaveLength(0);
      expect(files.get(uri)).toHaveLength(0);
      expect(sink.closed).toBe(1);
    });

    it('for a locked stream or destination, rejecting like pipeTo', async () => {
      const stream = new Blob(['hello']).stream();
      const { stream: destination } = createFileSink(uri);
      const reader = stream.getReader();
      await expect(stream.pipeTo(destination)).rejects.toThrow(TypeError);
      reader.releaseLock();

      const writer = destination.getWriter();
      await expect(stream.pipeTo(destination)).rejects.toThrow(TypeError);
      writer.releaseLock();
      expect(nativeWrites).toHaveLength(0);
    });

    it('for pipeThrough, which runs the internal pipe algorithm', async () => {
      const blob = new Blob(['hello world']);
      const slice = jest.spyOn(blob, 'slice');
      const { stream: destination } = createFileSink(uri);

      await blob.stream().pipeThrough(new TransformStream()).pipeTo(destination);

      expect(nativeWrites).toHaveLength(0);
      expect(slice).toHaveBeenCalled();
      expect(decode(files.get(uri))).toBe('hello world');
    });
  });

  it('rejects without writing when the destination is already closed', async () => {
    const stream = new Blob(['hello']).stream();
    const { stream: destination } = createFileSink(uri);
    await destination.close();

    await expect(stream.pipeTo(destination)).rejects.toThrow(TypeError);

    expect(nativeWrites).toHaveLength(0);
    expect(files.get(uri)).toHaveLength(0);
  });

  it('shadows the prototype pipeTo with an own, non-enumerable property', () => {
    const stream = new Blob(['hello']).stream();
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'pipeTo');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor?.enumerable).toBe(false);
    expect(stream.pipeTo).not.toBe(originalPipeTo);
  });
});
