/**
 * @jest-environment node
 */
// The index runs over the store and the in-memory fake in `fakeOpfs.ts`. The tests compare the
// sync answers with what OPFS holds, because the index exists to give those answers without an
// `await`.
import ExpoFileSystem from '../../ExpoFileSystem.web';
import { OpfsIndex, getOpfsIndex, opfsKeyOf } from '../opfsIndex';
import { OpfsStore } from '../opfsStore';
import { OPFS_UNAVAILABLE_MESSAGE } from '../opfsSupport';
import {
  FakeFileHandle,
  counterClock,
  createFakeOpfs,
  putFile,
  type FakeDirectoryHandle,
  type FakeWritableFileStream,
} from './fakeOpfs';

function setUp({ available = true } = {}) {
  const opfs = createFakeOpfs(counterClock());
  const store = new OpfsStore(opfs.getDirectory);
  return { ...opfs, store, index: new OpfsIndex(store, () => available) };
}

async function rootOf(opfs: FakeDirectoryHandle, root: 'cache' | 'document') {
  const base = await opfs.getDirectoryHandle('expo-file-system', { create: true });
  return base.getDirectoryHandle(root, { create: true });
}

const DIRECTORY = { kind: 'directory', size: null, lastModified: null };

// Waits until `check` holds, for a test that cannot await the operation it waits for.
async function until(check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('opfsKeyOf', () => {
  it('joins the decoded names, so every spelling of a path has one key', () => {
    expect(opfsKeyOf(['cache', 'a b', 'c.txt'])).toBe('cache/a b/c.txt');
    expect(opfsKeyOf(['document'])).toBe('document');
  });
});

describe('OpfsIndex before ready()', () => {
  // Importing the web module or creating the index must not touch storage: nothing in the app
  // asked for it, and private browsing can reject `getDirectory()`.
  it('does not touch OPFS until ready() is called', async () => {
    const { getDirectory, index } = setUp();
    expect(index.isReady).toBe(false);
    expect(getDirectory).not.toHaveBeenCalled();
    await index.ready();
    expect(getDirectory).toHaveBeenCalled();
  });

  it('throws the "not initialized" error from every sync reader', () => {
    const { index } = setUp();
    for (const read of [
      () => index.entry('file:///cache/a.txt'),
      () => index.exists('file:///cache/'),
      () => index.list('file:///document/'),
    ]) {
      expect(read).toThrow(
        expect.objectContaining({
          code: 'ERR_NOT_INITIALIZED',
          message: expect.stringContaining('await `Paths.ready()`'),
        })
      );
    }
  });

  // The uri is wrong in every browser, so the error must not depend on OPFS or on `ready()`.
  it.each([true, false])(
    'still rejects an invalid uri with ERR_INVALID_PATH (OPFS available: %s)',
    (available) => {
      const { index } = setUp({ available });
      for (const read of [
        () => index.exists('file:///cache/../a.txt'),
        () => index.list('file:///bundle/'),
        () => index.subtreeSize('https://example.com/'),
      ]) {
        expect(read).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PATH' }));
      }
    }
  );

  it('does not update anything for writes made before ready(), the walk reads them later', async () => {
    const { index } = setUp();
    await index.writeFile('file:///cache/early.txt', 'x');
    expect(index.isReady).toBe(false);
    await index.ready();
    expect(index.entry('file:///cache/early.txt')).toMatchObject({ kind: 'file', size: 1 });
  });
});

describe('OpfsIndex.ready', () => {
  it('fills the index from nested directories in both roots', async () => {
    const { root, index } = setUp();
    await putFile(await rootOf(root, 'cache'), ['a.txt'], 'aaa');
    await putFile(await rootOf(root, 'cache'), ['dir', 'nested', 'b.txt'], 'bb');
    await putFile(await rootOf(root, 'document'), ['c.txt'], 'c');
    await (await rootOf(root, 'document')).getDirectoryHandle('empty', { create: true });

    await index.ready();

    expect(index.entry('file:///cache/a.txt')).toEqual({
      kind: 'file',
      size: 3,
      lastModified: expect.any(Number),
    });
    expect(index.entry('file:///cache/dir/')).toEqual(DIRECTORY);
    expect(index.entry('file:///cache/dir/nested/b.txt')).toMatchObject({ size: 2 });
    expect(index.entry('file:///document/c.txt')).toMatchObject({ size: 1 });
    expect(index.list('file:///document/empty/')).toEqual([]);
    expect(index.exists('file:///cache/missing.txt')).toBe(false);
  });

  it('has the same lastModified as OPFS', async () => {
    const { store, index } = setUp();
    const written = await store.writeFile('file:///cache/a.txt', 'x');
    await index.ready();
    expect(index.entry('file:///cache/a.txt')!.lastModified).toBe(written.lastModified);
  });

  // The roots exist on native from the start, so they exist on web before anything is written.
  it('creates missing roots, so they exist as empty directories', async () => {
    const { root, index } = setUp();
    await index.ready();
    expect(index.entry('file:///cache/')).toEqual(DIRECTORY);
    expect(index.entry('file:///document')).toEqual(DIRECTORY);
    expect(index.list('file:///cache/')).toEqual([]);
    const base = await root.getDirectoryHandle('expo-file-system');
    expect(await collectKeys(base)).toEqual(['cache', 'document']);
  });

  it('leaves entries outside `expo-file-system` alone, such as the expo-sqlite pool', async () => {
    const { root, index } = setUp();
    await putFile(root, ['.ahp-directory', 'pool-file'], 'x');
    await index.ready();
    expect(index.list('file:///cache/')).toEqual([]);
    expect(await collectKeys(root)).toEqual(['.ahp-directory', 'expo-file-system']);
  });

  it('walks once and returns the same promise to every caller', async () => {
    const { getDirectory, index } = setUp();
    const first = index.ready();
    expect(index.ready()).toBe(first);
    await first;
    const calls = getDirectory.mock.calls.length;
    await index.ready();
    expect(getDirectory.mock.calls.length).toBe(calls);
    expect(index.isReady).toBe(true);
  });

  it('rejects with the mapped error when OPFS fails, and tries again on the next call', async () => {
    const { root, store } = setUp();
    const cause = new DOMException('private mode', 'SecurityError');
    const getDirectory = jest
      .fn()
      .mockRejectedValueOnce(cause)
      .mockImplementation(async () => root);
    const index = new OpfsIndex(new OpfsStore(getDirectory), () => true);

    await expect(index.ready()).rejects.toMatchObject({ code: 'ERR_STORAGE_UNAVAILABLE', cause });
    expect(index.isReady).toBe(false);
    expect(() => index.exists('file:///cache/')).toThrow(
      expect.objectContaining({ code: 'ERR_NOT_INITIALIZED' })
    );

    await store.writeFile('file:///cache/a.txt', 'x');
    await index.ready();
    expect(index.exists('file:///cache/a.txt')).toBe(true);
  });

  // An app can await `ready()` at startup on every browser; on plain http or an old browser the
  // storage is not there, and that must not crash the app.
  it('resolves without touching OPFS when the browser has no OPFS', async () => {
    const { getDirectory, index } = setUp({ available: false });
    await expect(index.ready()).resolves.toBeUndefined();
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('is exposed by the web module, which resolves in Node where there is no OPFS', async () => {
    await expect(ExpoFileSystem.ready()).resolves.toBeUndefined();
  });

  // The walk has already read `cache` when the write lands, so only the update after the write
  // can add the file. It must wait for the walk, or the walk's result would replace it.
  it('keeps a write made while the walk runs', async () => {
    const { index, store } = setUp();
    const readTree = store.readTree.bind(store);
    let releaseWalk!: () => void;
    const walkPaused = new Promise<void>((resolve) => (releaseWalk = resolve));
    jest.spyOn(store, 'readTree').mockImplementation(async (uri) => {
      if (uri === 'file:///document/') {
        await walkPaused;
      }
      return readTree(uri);
    });

    const ready = index.ready();
    const write = index.writeFile('file:///cache/during.txt', 'during');
    // `write` itself waits for the walk, so wait for the data to reach OPFS instead.
    while ((await store.stat('file:///cache/during.txt'))?.size !== 6) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseWalk();
    await Promise.all([ready, write]);
    expect(index.entry('file:///cache/during.txt')).toMatchObject({ kind: 'file', size: 6 });
  });
});

// Without OPFS, `Paths.cache` and `Paths.document` keep their placeholder behaviour (D25): the
// index answers it, so the getters built on it need no check of their own.
describe('OpfsIndex without OPFS', () => {
  it('answers the placeholder values, before and after ready()', async () => {
    const { getDirectory, index } = setUp({ available: false });
    for (const step of ['before', 'after']) {
      expect([step, index.entry('file:///cache/')]).toEqual([step, DIRECTORY]);
      expect(index.exists('file:///document')).toBe(true);
      expect(index.entry('file:///cache/a.txt')).toBeNull();
      expect(index.exists('file:///document/dir/')).toBe(false);
      expect(index.list('file:///cache/')).toEqual([]);
      expect(index.list('file:///cache/dir/')).toBeNull();
      expect(index.subtreeSize('file:///document/')).toBe(0);
      await index.ready();
    }
    expect(getDirectory).not.toHaveBeenCalled();
  });

  // Node has no OPFS, so the default index is the one an app on plain http gets.
  it('rejects writes with ERR_OPFS_UNAVAILABLE and keeps the placeholders', async () => {
    const index = getOpfsIndex();
    await index.ready();
    await expect(index.writeFile('file:///cache/a.txt', 'x')).rejects.toMatchObject({
      code: 'ERR_OPFS_UNAVAILABLE',
      message: OPFS_UNAVAILABLE_MESSAGE,
    });
    await expect(index.createDirectory('file:///cache/dir/')).rejects.toMatchObject({
      code: 'ERR_OPFS_UNAVAILABLE',
    });
    expect(index.exists('file:///cache/a.txt')).toBe(false);
    expect(index.list('file:///cache/')).toEqual([]);
  });
});

describe('OpfsIndex updates after every operation', () => {
  async function readyIndex() {
    const setup = setUp();
    await setup.index.ready();
    return setup;
  }

  it('adds a written file and updates its size and lastModified', async () => {
    const { index } = await readyIndex();
    await index.writeFile('file:///cache/a.txt', 'one');
    const first = index.entry('file:///cache/a.txt')!;
    expect(first).toMatchObject({ kind: 'file', size: 3 });

    await index.writeFile('file:///cache/a.txt', ' and two', { append: true });
    const second = index.entry('file:///cache/a.txt')!;
    expect(second.size).toBe(11);
    expect(second.lastModified!).toBeGreaterThan(first.lastModified!);
    expect(index.list('file:///cache/')).toEqual([{ name: 'a.txt', kind: 'file' }]);
  });

  it('adds a directory and every intermediate directory', async () => {
    const { index } = await readyIndex();
    await index.createDirectory('file:///document/a/b/', { intermediates: true });
    expect(index.entry('file:///document/a/')).toEqual(DIRECTORY);
    expect(index.entry('file:///document/a/b/')).toEqual(DIRECTORY);
    expect(index.list('file:///document/')).toEqual([{ name: 'a', kind: 'directory' }]);
    expect(index.list('file:///document/a/')).toEqual([{ name: 'b', kind: 'directory' }]);
  });

  it('reads the content of a directory that another tab created before', async () => {
    const { root, index } = await readyIndex();
    await putFile(await rootOf(root, 'cache'), ['shared', 'x.txt'], 'x');
    await index.createDirectory('file:///cache/shared/');
    expect(index.list('file:///cache/shared/')).toEqual([{ name: 'x.txt', kind: 'file' }]);
  });

  it('removes a file', async () => {
    const { index } = await readyIndex();
    await index.writeFile('file:///cache/a.txt', 'x');
    await index.removeFile('file:///cache/a.txt');
    expect(index.exists('file:///cache/a.txt')).toBe(false);
    expect(index.list('file:///cache/')).toEqual([]);
  });

  it('removes a directory with everything below it, and not its siblings', async () => {
    const { index } = await readyIndex();
    await index.createDirectory('file:///cache/dir/sub/', { intermediates: true });
    await index.writeFile('file:///cache/dir/sub/a.txt', 'x');
    await index.writeFile('file:///cache/dir-sibling.txt', 'x');
    await index.removeDirectory('file:///cache/dir/', { recursive: true });
    expect(index.exists('file:///cache/dir/')).toBe(false);
    expect(index.exists('file:///cache/dir/sub/a.txt')).toBe(false);
    expect(index.exists('file:///cache/dir-sibling.txt')).toBe(true);
  });

  it('keeps a root after removing it, empty', async () => {
    const { index } = await readyIndex();
    await index.writeFile('file:///cache/a.txt', 'x');
    await index.writeFile('file:///document/b.txt', 'x');
    await index.removeDirectory('file:///cache/', { recursive: true });
    expect(index.entry('file:///cache/')).toEqual(DIRECTORY);
    expect(index.list('file:///cache/')).toEqual([]);
    expect(index.exists('file:///document/b.txt')).toBe(true);
  });

  it('rejects like the store and leaves the index matching OPFS', async () => {
    const { index } = await readyIndex();
    await index.createDirectory('file:///cache/dir/');
    await index.writeFile('file:///cache/dir/a.txt', 'x');
    await expect(index.removeDirectory('file:///cache/dir/')).rejects.toMatchObject({
      code: 'ERR_DIRECTORY_NOT_EMPTY',
    });
    expect(index.exists('file:///cache/dir/a.txt')).toBe(true);
    await expect(index.writeFile('file:///cache/missing/a.txt', 'x')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
    expect(index.exists('file:///cache/missing/a.txt')).toBe(false);
  });

  // `getFileHandle({ create: true })` runs before the write, so a failed write leaves an empty
  // file in OPFS. The index must show it, or `exists` would disagree with OPFS.
  it('reads the path again after a failed write', async () => {
    const { index, store } = await readyIndex();
    const cause = new DOMException('quota', 'QuotaExceededError');
    const createWritable = FakeFileHandle.prototype.createWritable;
    const spy = jest
      .spyOn(FakeFileHandle.prototype, 'createWritable')
      .mockImplementation(async function (this: FakeFileHandle, options) {
        const writable: FakeWritableFileStream = await createWritable.call(this, options);
        jest.spyOn(writable, 'write').mockRejectedValue(cause);
        return writable;
      });
    try {
      await expect(index.writeFile('file:///cache/a.txt', 'data')).rejects.toMatchObject({
        code: 'ERR_QUOTA_EXCEEDED',
        cause,
      });
    } finally {
      spy.mockRestore();
    }
    expect(await store.stat('file:///cache/a.txt')).toMatchObject({ size: 0 });
    expect(index.entry('file:///cache/a.txt')).toMatchObject({ kind: 'file', size: 0 });
  });

  // An entry the index cannot check may be stale, and a stale `exists` is worse than none: the
  // index forgets it until `refresh()` reads it.
  it('forgets the path when it cannot read it again after a failed operation', async () => {
    const { index, store } = await readyIndex();
    await index.createDirectory('file:///cache/dir/');
    await index.writeFile('file:///cache/dir/a.txt', 'x');
    const writeFile = jest
      .spyOn(store, 'writeFile')
      .mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const stat = jest.spyOn(store, 'stat').mockRejectedValue(new Error('OPFS went away'));
    await expect(index.writeFile('file:///cache/dir/a.txt', 'y')).rejects.toBeInstanceOf(
      DOMException
    );
    expect(index.exists('file:///cache/dir/a.txt')).toBe(false);
    expect(index.exists('file:///cache/dir/')).toBe(true);

    writeFile.mockRestore();
    stat.mockRestore();
    await index.refresh('file:///cache/dir/');
    expect(index.entry('file:///cache/dir/a.txt')).toMatchObject({ kind: 'file', size: 1 });
  });

  it('forgets the directories of a failed create it cannot read again', async () => {
    const { index, store } = await readyIndex();
    await index.createDirectory('file:///cache/a/');
    jest.spyOn(store, 'createDirectory').mockRejectedValueOnce(new Error('failed'));
    jest.spyOn(store, 'stat').mockRejectedValueOnce(new Error('OPFS went away'));
    await expect(
      index.createDirectory('file:///cache/a/b/', { intermediates: true })
    ).rejects.toThrow('failed');
    expect(index.exists('file:///cache/a/')).toBe(false);
    expect(index.exists('file:///cache/')).toBe(true);
    await index.refresh('file:///cache/');
    expect(index.exists('file:///cache/a/')).toBe(true);
  });

  // The create succeeded, so the directories exist; a failed read of their content must not hide
  // them.
  it('keeps the created directories when reading their content fails', async () => {
    const { root, index, store } = await readyIndex();
    await putFile(await rootOf(root, 'cache'), ['shared', 'x.txt'], 'x');
    jest.spyOn(store, 'readTree').mockRejectedValueOnce(new Error('OPFS went away'));
    await index.createDirectory('file:///cache/shared/inner/', { intermediates: true });
    expect(index.entry('file:///cache/shared/')).toEqual(DIRECTORY);
    expect(index.entry('file:///cache/shared/inner/')).toEqual(DIRECTORY);
    await index.refresh('file:///cache/shared/');
    expect(index.list('file:///cache/shared/')).toEqual(
      expect.arrayContaining([
        { name: 'x.txt', kind: 'file' },
        { name: 'inner', kind: 'directory' },
      ])
    );
  });

  // Known directories are not read again, so creating a path below a large tree stays cheap.
  it('reads only the directories it did not know after a create', async () => {
    const { index, store } = await readyIndex();
    await index.createDirectory('file:///cache/a/');
    const readTree = jest.spyOn(store, 'readTree');
    const stat = jest.spyOn(store, 'stat');
    await index.createDirectory('file:///cache/a/b/c/', { intermediates: true });
    expect(readTree.mock.calls).toEqual([['file:///cache/a/b/']]);
    expect(stat.mock.calls).toEqual([['file:///cache/a/b']]);
  });

  // A re-walk reads OPFS and then replaces the subtree. A write that lands in between must still
  // be in the index afterwards, so the updates run one at a time.
  it('keeps a write that lands while refresh() reads OPFS', async () => {
    const { index, store } = await readyIndex();
    const readTree = store.readTree.bind(store);
    let releaseRead!: () => void;
    const readPaused = new Promise<void>((resolve) => (releaseRead = resolve));
    let readDone = false;
    jest.spyOn(store, 'readTree').mockImplementationOnce(async (uri) => {
      const tree = await readTree(uri);
      readDone = true;
      await readPaused;
      return tree;
    });

    const refresh = index.refresh('file:///cache/');
    await until(async () => readDone);
    const write = index.writeFile('file:///cache/during.txt', 'during');
    // `write` waits for the refresh, so wait for the data to reach OPFS instead.
    await until(async () => (await store.stat('file:///cache/during.txt'))?.size === 6);
    releaseRead();
    await Promise.all([refresh, write]);
    expect(index.entry('file:///cache/during.txt')).toMatchObject({ kind: 'file', size: 6 });
  });

  it('runs the next update after one that failed', async () => {
    const { index, store } = await readyIndex();
    jest.spyOn(store, 'stat').mockRejectedValueOnce(new Error('OPFS went away'));
    await expect(index.refresh('file:///cache/')).rejects.toThrow('OPFS went away');
    await index.writeFile('file:///cache/a.txt', 'x');
    expect(index.exists('file:///cache/a.txt')).toBe(true);
  });

  it('subtreeSize() sums the sizes of the files at every depth below a directory', async () => {
    const { index } = await readyIndex();
    await index.createDirectory('file:///cache/dir/sub/', { intermediates: true });
    await index.writeFile('file:///cache/dir/a.txt', 'aaa');
    await index.writeFile('file:///cache/dir/sub/b.txt', 'bb');
    await index.writeFile('file:///cache/dir-sibling.txt', 'not below dir');
    await index.createDirectory('file:///cache/empty/');
    expect(index.subtreeSize('file:///cache/dir/')).toBe(5);
    expect(index.subtreeSize('file:///cache/dir/sub')).toBe(2);
    expect(index.subtreeSize('file:///cache/')).toBe(5 + 'not below dir'.length);
    expect(index.subtreeSize('file:///cache/empty/')).toBe(0);
    expect(index.subtreeSize('file:///cache/missing/')).toBe(0);
  });

  it('reads the intermediate directories again after a failed create', async () => {
    const { index } = await readyIndex();
    await index.writeFile('file:///cache/a', 'x');
    await expect(
      index.createDirectory('file:///cache/a/b/', { intermediates: true })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_TYPE_DIRECTORY' });
    expect(index.entry('file:///cache/a')).toMatchObject({ kind: 'file' });
    expect(index.exists('file:///cache/a/b/')).toBe(false);
  });

  it('refresh() reads changes made outside the index', async () => {
    const { root, index } = await readyIndex();
    await index.writeFile('file:///cache/a.txt', 'x');
    const cache = await rootOf(root, 'cache');
    await cache.removeEntry('a.txt');
    await putFile(cache, ['dir', 'b.txt'], 'bb');
    expect(index.exists('file:///cache/a.txt')).toBe(true);

    await index.refresh('file:///cache/');
    expect(index.exists('file:///cache/a.txt')).toBe(false);
    expect(index.entry('file:///cache/dir/b.txt')).toMatchObject({ size: 2 });
  });

  it('uses the same entry for every spelling of a path', async () => {
    const { index } = await readyIndex();
    await index.writeFile('file:///cache/a%20b.txt', 'x');
    expect(index.exists('file:///cache/a b.txt')).toBe(true);
    await index.createDirectory('file:///cache/dir/');
    expect(index.entry('file:///cache/dir')).toEqual(DIRECTORY);
  });
});

describe('OpfsStore.readTree', () => {
  it('returns every entry below a directory with relative names', async () => {
    const { store } = setUp();
    await store.createDirectory('file:///cache/a/b/', { intermediates: true });
    await store.writeFile('file:///cache/a/b/c.txt', 'c');
    await store.writeFile('file:///cache/top.txt', 'top');
    expect(await store.readTree('file:///cache/')).toEqual(
      expect.arrayContaining([
        [['a'], DIRECTORY],
        [['a', 'b'], DIRECTORY],
        [['a', 'b', 'c.txt'], expect.objectContaining({ kind: 'file', size: 1 })],
        [['top.txt'], expect.objectContaining({ kind: 'file', size: 3 })],
      ])
    );
    expect(await store.readTree('file:///cache/a/b/')).toEqual([
      [['c.txt'], expect.objectContaining({ size: 1 })],
    ]);
  });

  it('maps a missing directory to ERR_NOT_FOUND', async () => {
    const { store } = setUp();
    await expect(store.readTree('file:///cache/missing/')).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
  });
});

async function collectKeys(directory: FakeDirectoryHandle): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of directory.keys()) {
    keys.push(key);
  }
  return keys;
}
