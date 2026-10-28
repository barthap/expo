/**
 * @jest-environment node
 */
// `File`, `Directory`, and `Paths` under `Paths.cache` and `Paths.document` on web, through the
// public API, over the in-memory OPFS fake (jsdom has no OPFS). The web module reads the index from
// `getOpfsIndex()`, so it is replaced with a fresh index over a fresh fake for every test.
import { Directory, File, Paths } from '../index';
import {
  counterClock,
  createFakeOpfs,
  putFile,
  type FakeDirectoryHandle,
} from '../internal/__tests__/fakeOpfs';
import { OpfsIndex } from '../internal/opfsIndex';
import { OpfsStore } from '../internal/opfsStore';

let mockIndex: OpfsIndex;
jest.mock('../internal/opfsIndex', () => ({
  ...jest.requireActual('../internal/opfsIndex'),
  getOpfsIndex: () => mockIndex,
}));

let opfs: ReturnType<typeof createFakeOpfs>;

beforeEach(() => {
  opfs = createFakeOpfs(counterClock());
  mockIndex = new OpfsIndex(new OpfsStore(opfs.getDirectory), () => true);
});

const code = (value: string) => expect.objectContaining({ code: value });

async function rootOf(root: 'cache' | 'document'): Promise<FakeDirectoryHandle> {
  const base = await opfs.root.getDirectoryHandle('expo-file-system', { create: true });
  return base.getDirectoryHandle(root, { create: true });
}

// Content in OPFS that the index did not write, as if another tab or an earlier session made it.
async function seed(root: 'cache' | 'document', names: string[], content: string) {
  await putFile(await rootOf(root), names, content);
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('before Paths.ready()', () => {
  // The index is filled asynchronously, and a sync answer from an empty index would be wrong.
  it('the sync readers throw ERR_NOT_INITIALIZED and name Paths.ready()', () => {
    const file = new File(Paths.cache, 'a.txt');
    expect(() => file.exists).toThrow(code('ERR_NOT_INITIALIZED'));
    expect(() => file.exists).toThrow(/Paths\.ready\(\)/);
    expect(() => file.size).toThrow(code('ERR_NOT_INITIALIZED'));
    expect(() => Paths.cache.exists).toThrow(code('ERR_NOT_INITIALIZED'));
    expect(() => Paths.document.list()).toThrow(code('ERR_NOT_INITIALIZED'));
    expect(() => Paths.info(Paths.cache.uri)).toThrow(code('ERR_NOT_INITIALIZED'));
  });

  it('the paths outside the stored roots do not depend on it', () => {
    expect(Paths.bundle.exists).toBe(true);
    expect(new File('data:,hi').exists).toBe(true);
  });

  it('after Paths.ready(), the sync readers see what OPFS already held', async () => {
    await seed('document', ['notes', 'a.txt'], 'hello');
    await Paths.ready();
    const file = new File(Paths.document, 'notes', 'a.txt');
    expect(file.exists).toBe(true);
    expect(file.size).toBe(5);
    expect(new Directory(Paths.document, 'notes').exists).toBe(true);
    expect(Paths.cache.exists).toBe(true);
  });

  // An app that never calls `Paths.ready()` still gets correct sync answers after an awaited call.
  it('an async member fills the index first, so the sync readers work after it', async () => {
    const file = new File(Paths.cache, 'b.txt');
    await file.write('data');
    expect(file.exists).toBe(true);
    expect(file.size).toBe(4);
  });
});

describe('OPFS-backed File', () => {
  beforeEach(() => Paths.ready());

  it('write() creates the file and every read method returns its current data', async () => {
    const file = new File(Paths.cache, 'data.json');
    expect(file.exists).toBe(false);
    await file.write('{"a":1}');
    expect(file.exists).toBe(true);
    expect(file.size).toBe(7);
    expect(typeof file.lastModified).toBe('number');
    expect(await file.text()).toBe('{"a":1}');
    expect(await file.json()).toEqual({ a: 1 });
    expect(Array.from(await file.bytes())).toEqual(Array.from(Buffer.from('{"a":1}')));
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.from('{"a":1}'))
    );
    expect(await readStream(file.stream())).toBe('{"a":1}');
    expect(await readStream(file.readableStream())).toBe('{"a":1}');
  });

  it('write() replaces the content, or appends with { append: true }', async () => {
    const file = new File(Paths.cache, 'log.txt');
    await file.write('one');
    await file.write('two');
    expect(await file.text()).toBe('two');
    await file.write(new TextEncoder().encode('+three'), { append: true });
    expect(await file.text()).toBe('two+three');
    expect(file.size).toBe(9);
  });

  it('write() decodes the content with { encoding: "base64" }, like native', async () => {
    const file = new File(Paths.cache, 'b64.bin');
    await file.write('aGk=', { encoding: 'base64' });
    expect(await file.text()).toBe('hi');
  });

  it('write() rejects when the parent directory does not exist, like native', async () => {
    const file = new File(Paths.cache, 'missing', 'a.txt');
    await expect(file.write('x')).rejects.toEqual(code('ERR_NOT_FOUND'));
    expect(file.exists).toBe(false);
  });

  it('reads the data again on every read, so a change made outside the index is visible', async () => {
    const file = new File(Paths.cache, 'shared.txt');
    await file.write('old');
    await seed('cache', ['shared.txt'], 'new from another tab');
    expect(await file.text()).toBe('new from another tab');
  });

  it('a read of a file removed outside the index rejects and updates the index', async () => {
    const file = new File(Paths.cache, 'gone.txt');
    await file.write('x');
    await (await rootOf('cache')).removeEntry('gone.txt');
    expect(file.exists).toBe(true);
    await expect(file.text()).rejects.toEqual(code('ERR_NOT_FOUND'));
    expect(file.exists).toBe(false);
  });

  it('a missing file has size 0 and lastModified null, like native', () => {
    const file = new File(Paths.cache, 'nope.txt');
    expect(file.size).toBe(0);
    expect(file.lastModified).toBeNull();
  });

  it('exists is false when a directory is at the path, and the other way around', async () => {
    await new Directory(Paths.cache, 'dir').createAsync();
    await new File(Paths.cache, 'file').write('x');
    expect(new File(Paths.cache, 'dir').exists).toBe(false);
    expect(new Directory(Paths.cache, 'file').exists).toBe(false);
  });

  it('stream() does not read OPFS until the stream is read', async () => {
    const file = new File(Paths.cache, 'lazy.txt');
    await file.write('lazy');
    const readFile = jest.spyOn(mockIndex.store, 'readFile');
    const stream = file.stream();
    expect(readFile).not.toHaveBeenCalled();
    expect(await readStream(stream)).toBe('lazy');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  // A sync `slice()` cannot return bytes that are only read asynchronously; a Blob with the right
  // size and no bytes would upload or copy nothing.
  it('slice() and toWebFile() throw and show how to read the data first', async () => {
    const file = new File(Paths.cache, 'a.txt');
    await file.write('abc');
    expect(() => file.slice(0, 1)).toThrow(code('ERR_UNAVAILABLE'));
    expect(() => file.slice(0, 1)).toThrow(/new globalThis\.File\(\[await file\.bytes\(\)\]/);
    expect(() => file.toWebFile()).toThrow(code('ERR_UNAVAILABLE'));
  });

  it('the sync mutators throw and point at the async member', () => {
    const file = new File(Paths.cache, 'a.txt');
    expect(() => file.create()).toThrow(/use `await file\.createAsync\(\)`/i);
    expect(() => file.delete()).toThrow(/use `await file\.deleteAsync\(\)`/i);
    expect(() => file.writeSync('x')).toThrow(/use `await file\.write\(\)`/i);
    expect(() => file.textSync()).toThrow(/use `await file\.text\(\)`/i);
    expect(() => file.copySync(Paths.document)).toThrow(/use `await file\.copy\(\)`/i);
  });

  // An OPFS file has no bytes in its browser `File` slots, so passing it to `fetch()` or `FormData`
  // would send nothing. The message must not suggest it.
  it('members that OPFS files do not have either do not suggest fetch() or FormData', async () => {
    const file = new File(Paths.cache, 'a.txt');
    const error = await file.base64().catch((e) => e);
    expect(error.code).toBe('ERR_UNAVAILABLE');
    expect(error.message).not.toMatch(/FormData|fetch/);
    expect(() => file.open()).toThrow(/does not implement it on web/);
  });

  it('info() reports the entry, with no creation time', async () => {
    const file = new File(Paths.cache, 'a.txt');
    expect(file.info()).toEqual({ exists: false, uri: file.uri });
    await file.write('abc');
    expect(file.info()).toEqual({
      exists: true,
      uri: file.uri,
      size: 3,
      modificationTime: file.lastModified,
    });
    expect(() => file.info({ md5: true })).toThrow(code('ERR_UNAVAILABLE'));
  });

  it('Paths.info() reports files and directories', async () => {
    await new File(Paths.cache, 'a.txt').write('x');
    expect(Paths.info('file:///cache/a.txt')).toEqual({ exists: true, isDirectory: false });
    expect(Paths.info('file:///cache')).toEqual({ exists: true, isDirectory: true });
    expect(Paths.info('file:///cache/missing')).toEqual({ exists: false, isDirectory: null });
  });
});

describe('File.createAsync()', () => {
  beforeEach(() => Paths.ready());

  it('creates an empty file', async () => {
    const file = new File(Paths.cache, 'new.txt');
    await file.createAsync();
    expect(file.exists).toBe(true);
    expect(file.size).toBe(0);
  });

  it('rejects for an existing file, like native', async () => {
    const file = new File(Paths.cache, 'new.txt');
    await file.write('keep');
    await expect(file.createAsync()).rejects.toEqual(code('ERR_FILE_ALREADY_EXISTS'));
    expect(await file.text()).toBe('keep');
  });

  it('replaces an existing file with an empty one with { overwrite: true }', async () => {
    const file = new File(Paths.cache, 'new.txt');
    await file.write('old');
    await file.createAsync({ overwrite: true });
    expect(await file.text()).toBe('');
  });

  it('rejects for a directory at the path, also with { overwrite: true }', async () => {
    await new Directory(Paths.cache, 'taken').createAsync();
    const file = new File(Paths.cache, 'taken');
    await expect(file.createAsync({ overwrite: true })).rejects.toEqual(
      code('ERR_INVALID_TYPE_FILE')
    );
    expect(new Directory(Paths.cache, 'taken').exists).toBe(true);
  });

  it('creates a file directly in a root with { intermediates: true }', async () => {
    const file = new File(Paths.cache, 'top.txt');
    await file.createAsync({ intermediates: true });
    expect(file.exists).toBe(true);
  });

  it('rejects for a missing parent, and creates it with { intermediates: true }', async () => {
    const file = new File(Paths.cache, 'a', 'b', 'c.txt');
    await expect(file.createAsync()).rejects.toEqual(code('ERR_NOT_FOUND'));
    await file.createAsync({ intermediates: true });
    expect(file.exists).toBe(true);
    expect(new Directory(Paths.cache, 'a', 'b').exists).toBe(true);
  });
});

describe('Directory.createAsync()', () => {
  beforeEach(() => Paths.ready());

  it('creates a directory', async () => {
    const dir = new Directory(Paths.document, 'albums');
    await dir.createAsync();
    expect(dir.exists).toBe(true);
    expect(Paths.document.list().map((item) => item.uri)).toEqual([dir.uri]);
  });

  it('rejects for an existing directory without options, like native', async () => {
    const dir = new Directory(Paths.document, 'albums');
    await dir.createAsync();
    await expect(dir.createAsync()).rejects.toEqual(code('ERR_FILE_ALREADY_EXISTS'));
    await expect(Paths.document.createAsync()).rejects.toEqual(code('ERR_FILE_ALREADY_EXISTS'));
  });

  it('keeps an existing directory and its content with { idempotent: true }', async () => {
    const dir = new Directory(Paths.document, 'albums');
    await dir.createAsync();
    await new File(dir, 'a.txt').write('a');
    await dir.createAsync({ idempotent: true });
    // `idempotent` is checked first, like native `needsCreation()`.
    await dir.createAsync({ idempotent: true, overwrite: true });
    expect(new File(dir, 'a.txt').exists).toBe(true);
  });

  // D79: `overwrite` means a fresh, empty directory.
  it('replaces an existing directory and everything in it with { overwrite: true }', async () => {
    const dir = new Directory(Paths.document, 'albums');
    await dir.createAsync();
    await new Directory(dir, 'inner').createAsync();
    await new File(dir, 'inner', 'a.txt').write('a');
    await dir.createAsync({ overwrite: true });
    expect(dir.exists).toBe(true);
    expect(dir.list()).toEqual([]);
    expect(new File(dir, 'inner', 'a.txt').exists).toBe(false);
  });

  // The roots belong to the module and always exist, and neither native platform empties a
  // directory on `overwrite`, so a root keeps what the app stored in it.
  it('keeps a root and its content with { overwrite: true }', async () => {
    const file = new File(Paths.document, 'a.txt');
    await file.write('a');
    await Paths.document.createAsync({ overwrite: true });
    await Paths.cache.createAsync({ overwrite: true });
    expect(Paths.document.exists).toBe(true);
    expect(await file.text()).toBe('a');
  });

  it('rejects for a file at the path, also with { idempotent: true }', async () => {
    await new File(Paths.document, 'albums').write('x');
    const dir = new Directory(Paths.document, 'albums');
    await expect(dir.createAsync({ idempotent: true })).rejects.toEqual(
      code('ERR_INVALID_TYPE_DIRECTORY')
    );
  });

  it('rejects for a missing parent, and creates it with { intermediates: true }', async () => {
    const dir = new Directory(Paths.document, 'a', 'b');
    await expect(dir.createAsync()).rejects.toEqual(code('ERR_NOT_FOUND'));
    expect(new Directory(Paths.document, 'a').exists).toBe(false);
    await dir.createAsync({ intermediates: true });
    expect(dir.exists).toBe(true);
  });
});

describe('Directory.createFileAsync() and createDirectoryAsync()', () => {
  beforeEach(() => Paths.ready());

  it('create a child and return a public File or Directory for it', async () => {
    const dir = new Directory(Paths.cache, 'parent');
    await dir.createAsync();
    const file = await dir.createFileAsync('a b.txt', 'text/plain');
    expect(file).toBeInstanceOf(File);
    expect(file.uri).toBe(new File(dir, 'a b.txt').uri);
    expect(file.exists).toBe(true);
    const child = await dir.createDirectoryAsync('inner');
    expect(child).toBeInstanceOf(Directory);
    expect(child.uri).toBe(new Directory(dir, 'inner').uri);
    expect(child.exists).toBe(true);
  });

  it('reject an existing child and a name that reaches another directory', async () => {
    const dir = Paths.cache;
    await dir.createFileAsync('a.txt', null);
    await expect(dir.createFileAsync('a.txt', null)).rejects.toEqual(
      code('ERR_FILE_ALREADY_EXISTS')
    );
    for (const name of ['', '..', 'x/y']) {
      await expect(dir.createDirectoryAsync(name)).rejects.toEqual(code('ERR_UNABLE_TO_CREATE'));
    }
  });
});

describe('deleteAsync()', () => {
  beforeEach(() => Paths.ready());

  it('removes a file, and rejects for a missing one like native', async () => {
    const file = new File(Paths.cache, 'a.txt');
    await file.write('x');
    await file.deleteAsync();
    expect(file.exists).toBe(false);
    await expect(file.deleteAsync()).rejects.toEqual(code('ERR_UNABLE_TO_DELETE'));
  });

  it('removes a directory and everything in it, like native', async () => {
    const dir = new Directory(Paths.cache, 'tree');
    await new Directory(dir, 'inner').createAsync({ intermediates: true });
    await new File(dir, 'inner', 'a.txt').write('x');
    await dir.deleteAsync();
    expect(dir.exists).toBe(false);
    expect(new File(dir, 'inner', 'a.txt').exists).toBe(false);
    await expect(dir.deleteAsync()).rejects.toEqual(code('ERR_UNABLE_TO_DELETE'));
  });

  // D25: deleting a root empties it, and the root is still there.
  it('empties a root, which still exists afterwards', async () => {
    await new File(Paths.document, 'inner', 'a.txt').createAsync({ intermediates: true });
    await Paths.document.deleteAsync();
    expect(Paths.document.exists).toBe(true);
    expect(Paths.document.list()).toEqual([]);
    expect(new File(Paths.document, 'inner', 'a.txt').exists).toBe(false);
  });

  it('rejects for an entry of the other kind', async () => {
    await new File(Paths.cache, 'f').write('x');
    await new Directory(Paths.cache, 'd').createAsync();
    await expect(new Directory(Paths.cache, 'f').deleteAsync()).rejects.toEqual(
      code('ERR_INVALID_TYPE_DIRECTORY')
    );
    await expect(new File(Paths.cache, 'd').deleteAsync()).rejects.toEqual(
      code('ERR_INVALID_TYPE_FILE')
    );
  });
});

describe('OPFS-backed Directory readers', () => {
  beforeEach(() => Paths.ready());

  it('list() returns File and Directory instances whose uris round-trip through the constructors', async () => {
    const dir = new Directory(Paths.document, 'my photos');
    await dir.createAsync();
    await new File(dir, 'a b.txt').write('x');
    await new Directory(dir, 'sub dir').createAsync();
    const items = dir.list();
    const file = items.find((item) => item instanceof File)!;
    const sub = items.find((item) => item instanceof Directory)!;
    expect(items).toHaveLength(2);
    expect(file.uri).toBe(new File(dir, 'a b.txt').uri);
    expect(file.name).toBe('a b.txt');
    expect(file.exists).toBe(true);
    expect(sub.uri).toBe(new Directory(dir, 'sub dir').uri);
    expect(sub.uri.endsWith('/')).toBe(true);
    expect(sub.exists).toBe(true);
  });

  it('list() throws for a missing directory and for a file', async () => {
    await new File(Paths.document, 'f').write('x');
    expect(() => new Directory(Paths.document, 'nope').list()).toThrow(code('ERR_NOT_FOUND'));
    expect(() => new Directory(Paths.document, 'f').list()).toThrow(
      code('ERR_INVALID_TYPE_DIRECTORY')
    );
  });

  it('size is the size of every file inside, at any depth, and null for a missing directory', async () => {
    const dir = new Directory(Paths.cache, 'sized');
    await new Directory(dir, 'inner').createAsync({ intermediates: true });
    await new File(dir, 'a.txt').write('abc');
    await new File(dir, 'inner', 'b.txt').write('de');
    expect(dir.size).toBe(5);
    expect(new Directory(Paths.cache, 'missing').size).toBeNull();
  });

  it('info() reports the size and the names of the children', async () => {
    const dir = new Directory(Paths.cache, 'info');
    expect(dir.info()).toEqual({ exists: false, uri: dir.uri });
    await dir.createAsync();
    await new File(dir, 'a.txt').write('abc');
    expect(dir.info()).toEqual({
      exists: true,
      uri: dir.uri,
      size: 3,
      files: ['a.txt'],
    });
  });

  it('the sync mutators throw and point at the async member', () => {
    const dir = new Directory(Paths.cache, 'x');
    expect(() => dir.create()).toThrow(/use `await directory\.createAsync\(\)`/i);
    expect(() => dir.delete()).toThrow(/use `await directory\.deleteAsync\(\)`/i);
    expect(() => dir.createFile('a', null)).toThrow(/createFileAsync/);
  });
});

describe('copy() and move() into OPFS', () => {
  beforeEach(() => Paths.ready());

  it('copy() writes the data to a File destination and keeps the source', async () => {
    const source = new File(Paths.cache, 'a.txt');
    await source.write('data');
    const target = new File(Paths.document, 'b.txt');
    await source.copy(target);
    expect(await target.text()).toBe('data');
    expect(source.exists).toBe(true);
  });

  it('copy() into a Directory uses the name of the source, and the directory must exist', async () => {
    const source = new File(Paths.cache, 'a.txt');
    await source.write('data');
    await expect(source.copy(new Directory(Paths.document, 'nope'))).rejects.toEqual(
      code('ERR_NOT_FOUND')
    );
    await source.copy(Paths.document);
    expect(await new File(Paths.document, 'a.txt').text()).toBe('data');
  });

  it('rejects for an existing destination unless { overwrite: true }', async () => {
    const source = new File(Paths.cache, 'a.txt');
    await source.write('new');
    const target = new File(Paths.document, 'a.txt');
    await target.write('old');
    await expect(source.copy(target)).rejects.toEqual(code('ERR_DESTINATION_ALREADY_EXISTS'));
    await expect(source.move(target)).rejects.toEqual(code('ERR_DESTINATION_ALREADY_EXISTS'));
    expect(await target.text()).toBe('old');
    await source.copy(target, { overwrite: true });
    expect(await target.text()).toBe('new');
  });

  it('move() removes the source and points the instance at the destination', async () => {
    const file = new File(Paths.cache, 'a.txt');
    await file.write('data');
    const sourceUri = file.uri;
    await file.move(new File(Paths.document, 'moved.txt'));
    expect(file.uri).toBe(new File(Paths.document, 'moved.txt').uri);
    expect(file.name).toBe('moved.txt');
    expect(new File(sourceUri).exists).toBe(false);
    expect(file.exists).toBe(true);
    expect(await file.text()).toBe('data');
  });

  // OPFS gives the type only with a read, and move() reads the source, so the type stays.
  it('move() keeps the type that reading a never-read source learned', async () => {
    await new File(Paths.cache, 'a.txt').write('data');
    const source = new File(Paths.cache, 'a.txt');
    const readFile = jest
      .spyOn(mockIndex.store, 'readFile')
      .mockResolvedValueOnce(new globalThis.File(['data'], 'a.txt', { type: 'text/plain' }));
    await source.move(new File(Paths.document, 'moved.txt'));
    readFile.mockRestore();
    expect(source.type).toBe('text/plain');
    expect(await source.text()).toBe('data');
  });

  // Reading and writing the same entry and then removing the source would lose the file.
  it('copy() and move() to the same path change nothing', async () => {
    const file = new File(Paths.cache, 'same.txt');
    await file.write('data');
    // Without `overwrite`, the destination exists, like on native.
    await expect(file.copy(new File(Paths.cache, 'same.txt'))).rejects.toEqual(
      code('ERR_DESTINATION_ALREADY_EXISTS')
    );
    await file.copy(new File(Paths.cache, 'same.txt'), { overwrite: true });
    await file.move(new File(Paths.cache, 'same.txt'), { overwrite: true });
    expect(await file.text()).toBe('data');
  });

  it('copy() and move() to a destination outside the stored roots stay unavailable', async () => {
    const file = new File(Paths.cache, 'a.txt');
    await file.write('data');
    await expect(file.copy(new Directory(Paths.bundle))).rejects.toEqual(code('ERR_UNAVAILABLE'));
    await expect(file.move(new Directory(Paths.bundle))).rejects.toEqual(code('ERR_UNAVAILABLE'));
  });

  describe('from a picked or wrapped file', () => {
    function picked() {
      return File.fromWebFile(
        new globalThis.File(['picked data'], 'photo.png', { type: 'image/png', lastModified: 7 })
      );
    }

    it('copy() stores the snapshot under its name, and the picked file stays', async () => {
      const file = picked();
      await file.copy(new Directory(Paths.document));
      const stored = new File(Paths.document, 'photo.png');
      expect(stored.exists).toBe(true);
      expect(stored.size).toBe(11);
      expect(await stored.text()).toBe('picked data');
      expect(file.exists).toBe(true);
      expect(file.uri.startsWith('blob:')).toBe(true);
      file.delete();
    });

    it('move() stores the snapshot, revokes the blob: URL, and makes the instance OPFS-backed', async () => {
      const file = picked();
      const blobUri = file.uri;
      const revoke = jest.spyOn(URL, 'revokeObjectURL');
      await file.move(new File(Paths.document, 'renamed.png'));
      expect(revoke).toHaveBeenCalledWith(blobUri);
      revoke.mockRestore();
      expect(new File(blobUri).exists).toBe(false);
      expect(file.uri).toBe(new File(Paths.document, 'renamed.png').uri);
      // The name follows the destination, not the picked name.
      expect(file.name).toBe('renamed.png');
      expect(file.type).toBe('image/png');
      expect(file.exists).toBe(true);
      expect(await file.text()).toBe('picked data');
      expect(() => file.slice()).toThrow(code('ERR_UNAVAILABLE'));
    });

    it('a uri-backed file can be copied but not moved, because the source cannot be removed', async () => {
      const file = new File('data:text/plain,from%20a%20uri');
      await file.copy(new File(Paths.cache, 'from-uri.txt'));
      expect(await new File(Paths.cache, 'from-uri.txt').text()).toBe('from a uri');
      await expect(file.move(new File(Paths.cache, 'other.txt'))).rejects.toEqual(
        code('ERR_UNAVAILABLE')
      );
    });
  });
});

describe('File.downloadFileAsync() into OPFS', () => {
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

  beforeEach(async () => {
    await Paths.ready();
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  function respondWith(body: string, init: ResponseInit = {}) {
    fetchMock.mockImplementation(async () => new Response(body, init));
  }

  it('pipes the body into a file in the destination Directory, named from the response', async () => {
    respondWith('downloaded', {
      headers: { 'Content-Disposition': 'attachment; filename="report 1.csv"' },
    });
    const onProgress = jest.fn();
    const file = await File.downloadFileAsync('https://example.com/x', Paths.document, {
      onProgress,
    });
    expect(file.uri).toBe(new File(Paths.document, 'report 1.csv').uri);
    expect(file.exists).toBe(true);
    expect(file.size).toBe(10);
    expect(await file.text()).toBe('downloaded');
    expect(onProgress.mock.calls).toEqual([[{ bytesWritten: 10, totalBytes: 10 }]]);
  });

  it('writes to a File destination', async () => {
    respondWith('body');
    const target = new File(Paths.cache, 'mine.txt');
    const file = await File.downloadFileAsync('https://example.com/a.txt', target);
    expect(file.uri).toBe(target.uri);
    expect(await target.text()).toBe('body');
  });

  it('rejects for an existing File destination before the request, unless idempotent', async () => {
    const target = new File(Paths.cache, 'mine.txt');
    await target.write('old');
    respondWith('new');
    await expect(File.downloadFileAsync('https://example.com/a', target)).rejects.toEqual(
      code('ERR_DESTINATION_ALREADY_EXISTS')
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await File.downloadFileAsync('https://example.com/a', target, { idempotent: true });
    expect(await target.text()).toBe('new');
  });

  it('rejects for an existing file in a Directory destination, unless idempotent', async () => {
    await new File(Paths.cache, 'a.txt').write('old');
    respondWith('new');
    await expect(File.downloadFileAsync('https://example.com/a.txt', Paths.cache)).rejects.toEqual(
      code('ERR_DESTINATION_ALREADY_EXISTS')
    );
    expect(await new File(Paths.cache, 'a.txt').text()).toBe('old');
    await File.downloadFileAsync('https://example.com/a.txt', Paths.cache, { idempotent: true });
    expect(await new File(Paths.cache, 'a.txt').text()).toBe('new');
  });

  // The store rejects before it pipes the body (here for the missing parent), and a body that is
  // never read would keep the connection open.
  it('cancels the body when the write fails before piping', async () => {
    const cancel = jest.fn();
    fetchMock.mockImplementation(
      async () => new Response(new ReadableStream({ pull() {}, cancel }))
    );
    await expect(
      File.downloadFileAsync('https://example.com/a.txt', new File(Paths.cache, 'missing', 'a.txt'))
    ).rejects.toEqual(code('ERR_NOT_FOUND'));
    expect(cancel).toHaveBeenCalled();
  });

  it('creates no file for a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(File.downloadFileAsync('https://example.com/a.txt', Paths.cache)).rejects.toThrow(
      '404'
    );
    expect(new File(Paths.cache, 'a.txt').exists).toBe(false);
  });
});
