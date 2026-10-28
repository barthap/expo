// An in-memory origin private file system for jest: jsdom and happy-dom have no OPFS. It follows
// the WHATWG File System spec and the MDN pages for the calls the store makes, and throws the same
// `DOMException` names:
// - `getDirectoryHandle()` / `getFileHandle()`: `TypeError` for an invalid name, `NotFoundError`
//   for a missing child (without `create`) or a removed handle, `TypeMismatchError` for the other
//   kind.
// - `removeEntry()`: `NotFoundError`, `InvalidModificationError` for a directory with children
//   without `recursive`.
// - `createWritable()`: writes go to a copy that replaces the file data on `close()`. `abort()`
//   drops the copy. `mode: 'exclusive'` throws `NoModificationAllowedError` while another writable
//   of the file is open; the default `'siloed'` mode allows many, but not next to an exclusive one.
//   `close()` and `abort()` release the lock. A `write()` that rejects inside the stream also
//   releases it, because a later `abort()` on the errored stream never reaches the sink; no test
//   depends on that case.
// Not modelled: permissions (`NotAllowedError`), quota (`QuotaExceededError`; tests inject it),
// `isSameEntry()`, `resolve()`, `move()`, and sync access handles.

type Entry = FakeFile | FakeDirectory;

type FakeFile = {
  kind: 'file';
  data: Uint8Array;
  lastModified: number;
  removed: boolean;
  // The lock that open writables hold: how many siloed ones, or one exclusive one.
  lock: { exclusive: boolean; writers: number };
};

type FakeDirectory = {
  kind: 'directory';
  children: Map<string, Entry>;
  removed: boolean;
};

/** Returns the time for `lastModified`. Tests pass a counter so the values are known. */
export type Clock = () => number;

function notFound(message: string): DOMException {
  return new DOMException(message, 'NotFoundError');
}

// The WHATWG "valid file name" rule: not empty, not `.` or `..`, and no path separator.
function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`Name is not allowed: "${name}"`);
  }
}

function markRemoved(entry: Entry): void {
  entry.removed = true;
  if (entry.kind === 'directory') {
    entry.children.forEach(markRemoved);
  }
}

async function bytesOf(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  throw new TypeError('The data is not a string, BufferSource, or Blob.');
}

type WriteCommand =
  | { type: 'write'; data: unknown; position?: number }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number };

// WebIDL matches a `Blob` (which has a `type` too) and a BufferSource before the `WriteParams`
// dictionary.
function isCommand(chunk: unknown): chunk is WriteCommand {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    !(chunk instanceof Blob) &&
    !(chunk instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(chunk) &&
    'type' in chunk
  );
}

export class FakeWritableFileStream extends WritableStream {
  constructor(file: FakeFile, keepExistingData: boolean, clock: Clock) {
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        file.lock.writers -= 1;
        file.lock.exclusive = false;
      }
    };
    let buffer = keepExistingData ? file.data.slice() : new Uint8Array(0);
    let position = 0;
    const writeAt = (bytes: Uint8Array) => {
      const end = position + bytes.byteLength;
      if (end > buffer.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(bytes, position);
      position = end;
    };
    const applyChunk = async (chunk: unknown) => {
      if (!isCommand(chunk)) {
        writeAt(await bytesOf(chunk));
      } else if (chunk.type === 'write') {
        if (chunk.position !== undefined) {
          position = chunk.position;
        }
        writeAt(await bytesOf(chunk.data));
      } else if (chunk.type === 'seek') {
        position = chunk.position;
      } else {
        const truncated = new Uint8Array(chunk.size);
        truncated.set(buffer.subarray(0, chunk.size));
        buffer = truncated;
        position = Math.min(position, chunk.size);
      }
    };
    super({
      async write(chunk: unknown) {
        try {
          await applyChunk(chunk);
        } catch (error) {
          release();
          throw error;
        }
      },
      close() {
        release();
        if (file.removed) {
          throw notFound('The file was removed while it was written.');
        }
        file.data = buffer;
        file.lastModified = clock();
      },
      abort() {
        release();
      },
    });
  }

  // Like the browser, these write through a writer and release it, so `close()` and `pipeTo()`
  // still work afterwards.
  async write(data: unknown): Promise<void> {
    const writer = this.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  seek(position: number): Promise<void> {
    return this.write({ type: 'seek', position });
  }

  truncate(size: number): Promise<void> {
    return this.write({ type: 'truncate', size });
  }
}

export class FakeFileHandle {
  readonly kind = 'file';

  constructor(
    readonly name: string,
    private readonly entry: FakeFile,
    private readonly clock: Clock
  ) {}

  async getFile(): Promise<globalThis.File> {
    if (this.entry.removed) {
      throw notFound(`The file "${this.name}" was removed.`);
    }
    return new globalThis.File([this.entry.data.slice()], this.name, {
      lastModified: this.entry.lastModified,
    });
  }

  async createWritable(
    options: { keepExistingData?: boolean; mode?: 'exclusive' | 'siloed' } = {}
  ): Promise<FakeWritableFileStream> {
    if (this.entry.removed) {
      throw notFound(`The file "${this.name}" was removed.`);
    }
    const { lock } = this.entry;
    const exclusive = options.mode === 'exclusive';
    if (lock.exclusive || (exclusive && lock.writers > 0)) {
      throw new DOMException(
        `The file "${this.name}" is locked by another writer.`,
        'NoModificationAllowedError'
      );
    }
    lock.writers += 1;
    lock.exclusive = exclusive;
    return new FakeWritableFileStream(this.entry, !!options.keepExistingData, this.clock);
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory';

  constructor(
    readonly name: string,
    private readonly entry: FakeDirectory,
    private readonly clock: Clock
  ) {}

  #child(name: string): Entry | undefined {
    checkName(name);
    if (this.entry.removed) {
      throw notFound(`The directory "${this.name}" was removed.`);
    }
    return this.entry.children.get(name);
  }

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<FakeDirectoryHandle> {
    let child = this.#child(name);
    if (child?.kind === 'file') {
      throw new DOMException(`"${name}" is a file.`, 'TypeMismatchError');
    }
    if (!child) {
      if (!options.create) {
        throw notFound(`"${name}" was not found.`);
      }
      child = { kind: 'directory', children: new Map(), removed: false };
      this.entry.children.set(name, child);
    }
    return new FakeDirectoryHandle(name, child, this.clock);
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    let child = this.#child(name);
    if (child?.kind === 'directory') {
      throw new DOMException(`"${name}" is a directory.`, 'TypeMismatchError');
    }
    if (!child) {
      if (!options.create) {
        throw notFound(`"${name}" was not found.`);
      }
      child = {
        kind: 'file',
        data: new Uint8Array(0),
        lastModified: this.clock(),
        removed: false,
        lock: { exclusive: false, writers: 0 },
      };
      this.entry.children.set(name, child);
    }
    return new FakeFileHandle(name, child, this.clock);
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const child = this.#child(name);
    if (!child) {
      throw notFound(`"${name}" was not found.`);
    }
    if (child.kind === 'directory' && child.children.size > 0 && !options.recursive) {
      throw new DOMException(`"${name}" is not empty.`, 'InvalidModificationError');
    }
    this.entry.children.delete(name);
    markRemoved(child);
  }

  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    if (this.entry.removed) {
      throw notFound(`The directory "${this.name}" was removed.`);
    }
    // A copy, so removing entries while iterating does not skip any.
    for (const [name, child] of [...this.entry.children]) {
      yield [
        name,
        child.kind === 'file'
          ? new FakeFileHandle(name, child, this.clock)
          : new FakeDirectoryHandle(name, child, this.clock),
      ];
    }
  }

  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) {
      yield name;
    }
  }

  async *values(): AsyncGenerator<FakeDirectoryHandle | FakeFileHandle> {
    for await (const [, handle] of this.entries()) {
      yield handle;
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

/**
 * Creates an empty fake OPFS. `getDirectory` stands in for `navigator.storage.getDirectory()` and
 * counts its calls; `root` is the same directory, for tests that set up or inspect entries.
 */
export function createFakeOpfs(clock: Clock = () => Date.now()) {
  const root = new FakeDirectoryHandle(
    '',
    { kind: 'directory', children: new Map(), removed: false },
    clock
  );
  const getDirectory = jest.fn(async () => root as unknown as FileSystemDirectoryHandle);
  return { root, getDirectory };
}

/** A clock that returns 1, 2, 3, and so on. */
export function counterClock(): Clock {
  let time = 0;
  return () => ++time;
}

/** Writes `content` to `names` under `directory`, creating the directories on the way. */
export async function putFile(
  directory: FakeDirectoryHandle,
  names: string[],
  content: string
): Promise<void> {
  const fileName = names[names.length - 1]!;
  let handle = directory;
  for (const name of names.slice(0, -1)) {
    handle = await handle.getDirectoryHandle(name, { create: true });
  }
  const writable = await (await handle.getFileHandle(fileName, { create: true })).createWritable();
  await writable.write(content);
  await writable.close();
}
