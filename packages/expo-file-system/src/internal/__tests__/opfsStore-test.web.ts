/**
 * @jest-environment node
 */
// The store runs against the in-memory fake in `fakeOpfs.ts`, because jsdom has no OPFS. The
// Node environment has the WHATWG `DOMException`, `File`, and streams that browsers have.
import { OpfsStore, getOpfsStore } from '../opfsStore';
import { OPFS_UNAVAILABLE_MESSAGE } from '../opfsSupport';
import {
  FakeFileHandle,
  counterClock,
  createFakeOpfs,
  putFile,
  type FakeDirectoryHandle,
  type FakeWritableFileStream,
} from './fakeOpfs';

// Only `getOpfsStore()` reads it; every other test builds an `OpfsStore` over the fake.
jest.mock('../opfsSupport', () => ({
  ...jest.requireActual('../opfsSupport'),
  isOpfsAvailable: jest.fn(() => false),
}));

function setUp() {
  const opfs = createFakeOpfs(counterClock());
  return { ...opfs, store: new OpfsStore(opfs.getDirectory) };
}

async function rootOf(opfs: FakeDirectoryHandle, root: 'cache' | 'document') {
  const base = await opfs.getDirectoryHandle('expo-file-system', { create: true });
  return base.getDirectoryHandle(root, { create: true });
}

// Makes every new writable fail in `method` with `error`, so a test sees what the store does when
// a real OPFS call fails that way. The writable stays real: its lock and `abort()` still work.
function failWritables(method: 'write' | 'seek', error: unknown) {
  const createWritable = FakeFileHandle.prototype.createWritable;
  const aborts: jest.SpyInstance[] = [];
  const spy = jest
    .spyOn(FakeFileHandle.prototype, 'createWritable')
    .mockImplementation(async function (this: FakeFileHandle, options) {
      const writable: FakeWritableFileStream = await createWritable.call(this, options);
      jest.spyOn(writable, method).mockRejectedValue(error);
      aborts.push(jest.spyOn(writable, 'abort'));
      return writable;
    });
  return { aborts, restore: () => spy.mockRestore() };
}

// A stream that stays open until the test ends it, so a write through it holds its writable open.
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return { stream, controller };
}

// Lets every pending fake OPFS call finish; they all settle in microtasks.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function textAt(opfs: FakeDirectoryHandle, names: string[]): Promise<string> {
  let handle = opfs;
  for (const name of names.slice(0, -1)) {
    handle = await handle.getDirectoryHandle(name);
  }
  return (await (await handle.getFileHandle(names[names.length - 1]!)).getFile()).text();
}

describe('OpfsStore layout', () => {
  // The entries live under fixed names, apart from the expo-sqlite pool directory.
  it('stores `file:///cache/...` and `file:///document/...` under `expo-file-system/<root>`', async () => {
    const { root, store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'in cache');
    await store.writeFile('file:///document/a.txt', 'in document');
    expect(await textAt(root, ['expo-file-system', 'cache', 'a.txt'])).toBe('in cache');
    expect(await textAt(root, ['expo-file-system', 'document', 'a.txt'])).toBe('in document');
  });

  it('decodes percent-encoded names, so the OPFS name is the one the user wrote', async () => {
    const { root, store } = setUp();
    await store.writeFile('file:///cache/a%20b.txt', 'x');
    expect(await textAt(root, ['expo-file-system', 'cache', 'a b.txt'])).toBe('x');
  });

  // `Paths.cache` and `Paths.document` always exist, like on native.
  it('creates the base directory and the roots on first use', async () => {
    const { store } = setUp();
    expect(await store.stat('file:///document/')).toEqual({
      kind: 'directory',
      size: null,
      lastModified: null,
    });
    expect(await store.list('file:///cache/')).toEqual([]);
  });

  it.each([
    'file:///cache/../document/a.txt',
    'file:///cache//a.txt',
    'file:///cache/a.txt?x=1',
    'file:///bundle/a.txt',
    'https://example.com/a.txt',
  ])('rejects %s with ERR_INVALID_PATH before any OPFS call', async (uri) => {
    const { getDirectory, store } = setUp();
    for (const call of [
      () => store.stat(uri),
      () => store.readFile(uri),
      () => store.writeFile(uri, 'x'),
      () => store.createDirectory(uri),
      () => store.list(uri),
      () => store.removeFile(uri),
      () => store.removeDirectory(uri),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'ERR_INVALID_PATH' });
    }
    expect(getDirectory).not.toHaveBeenCalled();
  });

  // The storage itself failed, not the entry, so the message names `file:///`.
  it('reports a failing `navigator.storage.getDirectory()` with the cause', async () => {
    const cause = new DOMException('no storage', 'SecurityError');
    const store = new OpfsStore(() => Promise.reject(cause));
    await expect(store.writeFile('file:///cache/a.txt', 'x')).rejects.toMatchObject({
      code: 'ERR_STORAGE_UNAVAILABLE',
      cause,
      message: expect.stringContaining('the directory at "file:///"'),
    });
  });

  it('names the root, not the entry, when the root cannot be opened', async () => {
    const { root, store } = setUp();
    await putFile(root, ['expo-file-system', 'cache'], 'a file in place of the root');
    const error = await store.writeFile('file:///cache/a/b.txt', 'x').catch((e) => e);
    expect(error).toMatchObject({
      code: 'ERR_INVALID_TYPE_DIRECTORY',
      message: expect.stringContaining('the directory at "file:///cache/"'),
    });
    expect(error.message).not.toContain('b.txt');
  });

  // An app on plain http still gets an error with a code, not a `TypeError` from `navigator`.
  it('getOpfsStore() rejects with ERR_OPFS_UNAVAILABLE when the browser has no OPFS', async () => {
    await expect(getOpfsStore().stat('file:///cache/')).rejects.toMatchObject({
      code: 'ERR_OPFS_UNAVAILABLE',
      message: OPFS_UNAVAILABLE_MESSAGE,
    });
  });
});

describe('OpfsStore.stat and exists', () => {
  it('returns the size and the modification time of a file', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'hello');
    expect(await store.stat('file:///cache/a.txt')).toEqual({
      kind: 'file',
      size: 5,
      lastModified: expect.any(Number),
    });
    expect(await store.exists('file:///cache/a.txt')).toBe(true);
  });

  it('finds a directory through a file or a directory uri', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    expect(await store.stat('file:///cache/dir/')).toMatchObject({ kind: 'directory' });
    expect(await store.stat('file:///cache/dir')).toMatchObject({ kind: 'directory' });
  });

  it('returns null for a missing entry or a missing parent', async () => {
    const { store } = setUp();
    expect(await store.stat('file:///cache/missing.txt')).toBeNull();
    expect(await store.stat('file:///cache/missing/a.txt')).toBeNull();
    expect(await store.exists('file:///document/missing/')).toBe(false);
  });

  // Native `exists` is false there, so this must not throw.
  it('returns null when a file stands in place of a parent directory', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'x');
    expect(await store.stat('file:///cache/a.txt/b.txt')).toBeNull();
  });
});

describe('OpfsStore.readFile', () => {
  it('returns the current data as a browser File', async () => {
    const { store } = setUp();
    await store.writeFile('file:///document/a.txt', 'first');
    await store.writeFile('file:///document/a.txt', 'second');
    const file = await store.readFile('file:///document/a.txt');
    expect(file).toBeInstanceOf(globalThis.File);
    expect(file.name).toBe('a.txt');
    expect(await file.text()).toBe('second');
  });

  it('maps a missing file to ERR_NOT_FOUND with the OPFS error as cause', async () => {
    const { store } = setUp();
    const error = await store.readFile('file:///cache/missing.txt').catch((e) => e);
    expect(error).toMatchObject({
      code: 'ERR_NOT_FOUND',
      message: expect.stringContaining('Failed to read the file at "file:///cache/missing.txt"'),
    });
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(error.cause.name).toBe('NotFoundError');
  });

  it('names the missing parent directory in the message', async () => {
    const { store } = setUp();
    await expect(store.readFile('file:///cache/a/b/c.txt')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
      message: expect.stringContaining('"file:///cache/a/"'),
    });
  });

  it('maps a directory at the uri to ERR_INVALID_TYPE_FILE', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    await expect(store.readFile('file:///cache/dir')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
    });
    await expect(store.readFile('file:///cache/')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
    });
  });
});

describe('OpfsStore.writeFile', () => {
  it('writes strings, bytes, and Blobs, and returns the new info', async () => {
    const { root, store } = setUp();
    expect(await store.writeFile('file:///cache/s.txt', 'text')).toMatchObject({
      kind: 'file',
      size: 4,
    });
    await store.writeFile('file:///cache/b.bin', new Uint8Array([104, 105]));
    await store.writeFile('file:///cache/blob.txt', new Blob(['blob']));
    expect(await textAt(root, ['expo-file-system', 'cache', 's.txt'])).toBe('text');
    expect(await textAt(root, ['expo-file-system', 'cache', 'b.bin'])).toBe('hi');
    expect(await textAt(root, ['expo-file-system', 'cache', 'blob.txt'])).toBe('blob');
  });

  it('pipes a ReadableStream into the file', async () => {
    const { store } = setUp();
    const entry = await store.writeFile(
      'file:///cache/stream.txt',
      new Blob(['a', 'b', 'c']).stream()
    );
    expect(entry).toMatchObject({ size: 3 });
    expect(await (await store.readFile('file:///cache/stream.txt')).text()).toBe('abc');
  });

  it('replaces the content, or appends to it with `append`', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'long old content');
    await store.writeFile('file:///cache/a.txt', 'new');
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('new');
    await store.writeFile('file:///cache/a.txt', ' more', { append: true });
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('new more');
  });

  it('updates lastModified on every write', async () => {
    const { store } = setUp();
    const first = await store.writeFile('file:///cache/a.txt', '1');
    const second = await store.writeFile('file:///cache/a.txt', '2');
    expect(second.lastModified!).toBeGreaterThan(first.lastModified!);
  });

  // Native `File.write()` does not create parent directories either.
  it('requires the parent directory to exist', async () => {
    const { store } = setUp();
    await expect(store.writeFile('file:///cache/missing/a.txt', 'x')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
  });

  it('maps a directory at the uri to ERR_INVALID_TYPE_FILE', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    await expect(store.writeFile('file:///cache/dir', 'x')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
    });
  });

  it('keeps the old content when the source stream fails', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'old');
    const failure = new Error('network lost');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(failure);
      },
    });
    await expect(store.writeFile('file:///cache/a.txt', source)).rejects.toBe(failure);
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('old');
  });

  it('aborts the writable and keeps the old content when the data cannot be written', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'old');
    const cause = new DOMException('quota', 'QuotaExceededError');
    const failing = failWritables('write', cause);
    try {
      await expect(store.writeFile('file:///cache/a.txt', 'new')).rejects.toMatchObject({
        code: 'ERR_QUOTA_EXCEEDED',
        cause,
      });
      expect(failing.aborts).toHaveLength(1);
      expect(failing.aborts[0]).toHaveBeenCalled();
    } finally {
      failing.restore();
    }
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('old');
  });

  // An append seeks before it writes. A writable left open there would hold the exclusive lock,
  // and every later write to the file would fail with ERR_FILE_LOCKED.
  it('aborts the writable when the seek of an append fails', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'old');
    const cause = new DOMException('seek failed', 'InvalidStateError');
    const failing = failWritables('seek', cause);
    try {
      await expect(
        store.writeFile('file:///cache/a.txt', ' more', { append: true })
      ).rejects.toMatchObject({ code: 'ERR_FILE_SYSTEM', cause });
      expect(failing.aborts[0]).toHaveBeenCalled();
    } finally {
      failing.restore();
    }
    await store.writeFile('file:///cache/a.txt', ' again', { append: true });
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('old again');
  });
});

// Two siloed writables would both start from the old content, and the one that closes last would
// drop the other's data. Native appends never lose data, so the store asks for an exclusive lock
// and the second writer fails loud.
describe('OpfsStore.writeFile locking', () => {
  it('rejects a second write to the same file with ERR_FILE_LOCKED while one is open', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'old');
    const open = openStream();
    const first = store.writeFile('file:///cache/a.txt', open.stream, { append: true });
    await settle();

    const error = await store.writeFile('file:///cache/a.txt', 'second').catch((e) => e);
    expect(error).toMatchObject({ code: 'ERR_FILE_LOCKED' });
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(error.cause.name).toBe('NoModificationAllowedError');

    open.controller.enqueue(new TextEncoder().encode(' first'));
    open.controller.close();
    await first;
    expect(await (await store.readFile('file:///cache/a.txt')).text()).toBe('old first');
  });

  it('releases the lock when the write closes', async () => {
    const { store } = setUp();
    const open = openStream();
    const first = store.writeFile('file:///cache/a.txt', open.stream);
    await settle();
    open.controller.close();
    await first;
    await expect(store.writeFile('file:///cache/a.txt', 'next')).resolves.toMatchObject({
      size: 4,
    });
  });

  it('releases the lock when the write aborts', async () => {
    const { store } = setUp();
    const open = openStream();
    const first = store.writeFile('file:///cache/a.txt', open.stream);
    await settle();
    const failure = new Error('network lost');
    open.controller.error(failure);
    await expect(first).rejects.toBe(failure);
    await expect(store.writeFile('file:///cache/a.txt', 'next')).resolves.toMatchObject({
      size: 4,
    });
  });

  it('locks each file on its own', async () => {
    const { store } = setUp();
    const open = openStream();
    const first = store.writeFile('file:///cache/a.txt', open.stream);
    await settle();
    await expect(store.writeFile('file:///cache/b.txt', 'b')).resolves.toMatchObject({ size: 1 });
    open.controller.close();
    await first;
  });
});

describe('OpfsStore.createDirectory', () => {
  it('creates a directory in an existing parent', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///document/dir/');
    expect(await store.stat('file:///document/dir/')).toMatchObject({ kind: 'directory' });
  });

  // Like native `Directory.create()` without `intermediates`.
  it('requires the parent without `intermediates`', async () => {
    const { store } = setUp();
    await expect(store.createDirectory('file:///document/a/b/')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
      message: expect.stringContaining('"file:///document/a/"'),
    });
    expect(await store.exists('file:///document/a/')).toBe(false);
  });

  it('creates the missing parents with `intermediates`', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///document/a/b/c/', { intermediates: true });
    expect(await store.exists('file:///document/a/')).toBe(true);
    expect(await store.exists('file:///document/a/b/c/')).toBe(true);
  });

  it('leaves an existing directory and its content alone', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    await store.writeFile('file:///cache/dir/a.txt', 'x');
    await store.createDirectory('file:///cache/dir/');
    expect(await store.exists('file:///cache/dir/a.txt')).toBe(true);
  });

  it('maps a file at the uri or in place of a parent to ERR_INVALID_TYPE_DIRECTORY', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a', 'x');
    await expect(store.createDirectory('file:///cache/a/')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_DIRECTORY',
    });
    await expect(
      store.createDirectory('file:///cache/a/b/', { intermediates: true })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_TYPE_DIRECTORY' });
  });
});

describe('OpfsStore.list', () => {
  it('returns the names and kinds of the children', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'x');
    await store.createDirectory('file:///cache/dir/');
    await store.writeFile('file:///cache/dir/inner.txt', 'x');
    // OPFS does not promise an order.
    const children = await store.list('file:///cache/');
    expect(children).toHaveLength(2);
    expect(children).toEqual(
      expect.arrayContaining([
        { name: 'a.txt', kind: 'file' },
        { name: 'dir', kind: 'directory' },
      ])
    );
    expect(await store.list('file:///cache/dir/')).toEqual([{ name: 'inner.txt', kind: 'file' }]);
  });

  it('maps a missing directory to ERR_NOT_FOUND', async () => {
    const { store } = setUp();
    await expect(store.list('file:///cache/missing/')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
  });
});

describe('OpfsStore.removeFile and removeDirectory', () => {
  it('removes a file', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'x');
    await store.removeFile('file:///cache/a.txt');
    expect(await store.exists('file:///cache/a.txt')).toBe(false);
  });

  it('maps a missing entry to ERR_NOT_FOUND', async () => {
    const { store } = setUp();
    await expect(store.removeFile('file:///cache/missing.txt')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
    await expect(store.removeDirectory('file:///cache/missing/')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
  });

  // `removeEntry` removes either kind, so without the check `File.delete()` could remove a
  // directory with all its content.
  it('removes only the kind the caller asked for', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    await store.writeFile('file:///cache/a.txt', 'x');
    await expect(store.removeFile('file:///cache/dir')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
    });
    await expect(store.removeDirectory('file:///cache/a.txt/')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_DIRECTORY',
    });
    expect(await store.exists('file:///cache/dir/')).toBe(true);
    expect(await store.exists('file:///cache/a.txt')).toBe(true);
  });

  it('removes a directory with content only with `recursive`', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/dir/');
    await store.writeFile('file:///cache/dir/a.txt', 'x');
    const error = await store.removeDirectory('file:///cache/dir/').catch((e) => e);
    expect(error).toMatchObject({ code: 'ERR_DIRECTORY_NOT_EMPTY' });
    expect(error.cause.name).toBe('InvalidModificationError');
    await store.removeDirectory('file:///cache/dir/', { recursive: true });
    expect(await store.exists('file:///cache/dir/')).toBe(false);
  });

  it('empties a root instead of removing it, because the roots always exist', async () => {
    const { store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'x');
    await store.writeFile('file:///document/b.txt', 'x');
    await expect(store.removeDirectory('file:///cache/')).rejects.toMatchObject({
      code: 'ERR_DIRECTORY_NOT_EMPTY',
    });
    await store.removeDirectory('file:///cache/', { recursive: true });
    expect(await store.stat('file:///cache/')).toMatchObject({ kind: 'directory' });
    expect(await store.list('file:///cache/')).toEqual([]);
    expect(await store.exists('file:///document/b.txt')).toBe(true);
  });

  it('cannot remove a root as a file', async () => {
    const { store } = setUp();
    await expect(store.removeFile('file:///cache/')).rejects.toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
    });
  });

  // The store opens handles again for every call, so an entry removed elsewhere (another tab,
  // the developer tools) is not served from an old handle.
  it('sees entries changed behind its back', async () => {
    const { root, store } = setUp();
    await store.writeFile('file:///cache/a.txt', 'x');
    const cache = await rootOf(root, 'cache');
    await cache.removeEntry('a.txt');
    await putFile(cache, ['b.txt'], 'from elsewhere');
    expect(await store.exists('file:///cache/a.txt')).toBe(false);
    expect(await (await store.readFile('file:///cache/b.txt')).text()).toBe('from elsewhere');
  });
});
