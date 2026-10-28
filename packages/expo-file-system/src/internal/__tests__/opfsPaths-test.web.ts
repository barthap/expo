/**
 * @jest-environment node
 */
// The web backend runs under the Node environment, like `FileSystemWeb-test.web.ts`.
import { Directory, File, Paths } from '../../index';
import { normalizeFileUri, opfsPathOf } from '../opfsPaths';

const INVALID_PATH = expect.objectContaining({ code: 'ERR_INVALID_PATH' });

function invalidPathError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

// The expected values are what the native constructors return. iOS builds the URL with
// `standardizedFileURL` and `appendingPathComponent(_:isDirectory:)` (`FileSystemPath.swift`),
// Android drops or adds the trailing slash in `asString()` (`FileSystemFile.kt`,
// `FileSystemDirectory.kt`), and both get the uri from the shared `Paths.join`. The cases come from
// the native `FileSystem` test-suite specs, so a web `uri` matches the native one.
describe('normalizeFileUri', () => {
  describe.each([
    ['File', (uri: string) => new File(uri).uri],
    ['Directory', (uri: string) => new Directory(uri).uri],
  ])('through the %s constructor', (className, construct) => {
    const directory = className === 'Directory';
    const expected = (path: string) => `file://${path}${directory ? '/' : ''}`;

    it('adds the missing slashes of `file:/p`', () => {
      expect(construct('file:/path/to/file')).toBe(expected('/path/to/file'));
    });

    it('drops the `localhost` host', () => {
      expect(construct('file://localhost/path/to/file')).toBe(expected('/path/to/file'));
    });

    it('keeps a `file:///` uri', () => {
      expect(construct('file:///path/to/file')).toBe(expected('/path/to/file'));
    });

    it(`${directory ? 'keeps' : 'drops'} a trailing slash`, () => {
      expect(construct('file:/path/to/file/')).toBe(expected('/path/to/file'));
    });

    it('resolves `.` and `..` segments', () => {
      expect(construct('file:///a/./b/../c')).toBe(expected('/a/c'));
      expect(construct('file:///a/%2e%2E/c')).toBe(expected('/c'));
    });

    it('joins repeated slashes', () => {
      expect(construct('file:///a//b///c')).toBe(expected('/a/b/c'));
    });

    it('keeps percent-encoded names encoded', () => {
      expect(construct('file:///a/b%20c')).toBe(expected('/a/b%20c'));
    });
  });

  it('resolves `..` passed as a separate segment', () => {
    expect(new File('file:///path', 'to', '..', 'file').uri).toBe('file:///path/file');
    expect(new Directory('file:///path', 'to', '..', 'directory').uri).toBe(
      'file:///path/directory/'
    );
  });

  it('gives a file the same parent directory uri as the directory it was made in', () => {
    const testDirectory = Paths.document.uri + 'tests/';
    const file = new File(testDirectory, 'image.jpeg');
    expect(file.parentDirectory.uri).toBe(new Directory(testDirectory).uri);
    expect(file.parentDirectory.uri).toBe('file:///document/tests/');
  });

  it('gives a nested directory the parent directory uri with a trailing slash', () => {
    const testDirectory = Paths.document.uri + 'tests/';
    const directory = new Directory(testDirectory, '/testdirectory/sampleDir');
    expect(directory.uri).toBe('file:///document/tests/testdirectory/sampleDir/');
    expect(directory.parentDirectory.parentDirectory.uri).toBe(new Directory(testDirectory).uri);
  });

  it('keeps the root of a directory and of a file', () => {
    expect(new Directory('file:///').uri).toBe('file:///');
    expect(normalizeFileUri('file:///', 'file')).toBe('file:///');
  });

  it('gives the same uri when normalized twice', () => {
    for (const uri of ['file:/a/b/', 'file://localhost/a/./b', 'file:///a//b/..']) {
      for (const kind of ['file', 'directory'] as const) {
        const once = normalizeFileUri(uri, kind);
        expect(normalizeFileUri(once, kind)).toBe(once);
      }
    }
  });

  it('keeps `Paths.cache` and `Paths.document` and the files in them unchanged', () => {
    expect(Paths.cache.uri).toBe('file:///cache/');
    expect(Paths.document.uri).toBe('file:///document/');
    expect(new File(Paths.document, 'file.txt').uri).toBe('file:///document/file.txt');
    expect(new Directory(Paths.cache).exists).toBe(true);
    expect(new Directory('file:///cache').exists).toBe(true);
  });

  // The blob registry is keyed by the exact `blob:` URL, and `data:` and `https:` URLs are not
  // paths, so changing them would lose the data or point at another resource.
  it('returns uris of other schemes unchanged', () => {
    for (const uri of [
      'blob:http://localhost:8081/0b4c-uuid',
      'data:text/plain,a/../b/',
      'https://example.com/a/../b/',
      'relative/path/',
    ]) {
      expect(normalizeFileUri(uri, 'file')).toBe(uri);
      expect(normalizeFileUri(uri, 'directory')).toBe(uri);
    }
  });

  // Node's `URL` drops `localhost` from `file:` URLs, as the URL standard says, but Chrome keeps it.
  // The mocked parser keeps the host like Chrome does.
  it('drops any host that the URL parser kept, like iOS does', () => {
    jest.isolateModules(() => {
      jest.doMock('../../pathUtilities/url', () => ({
        asUrl: (uri: string) => {
          const [, host, pathname] = /^file:\/\/([^/]*)(\/.*)$/.exec(uri)!;
          return { host, pathname, search: '' };
        },
      }));
      const { normalizeFileUri: normalize } = require('../opfsPaths');
      expect(normalize('file://localhost/path/to/file', 'file')).toBe('file:///path/to/file');
      expect(normalize('file://LOCALHOST/path/to/dir', 'directory')).toBe('file:///path/to/dir/');
      expect(normalize('file://server/path/to/file', 'file')).toBe('file:///path/to/file');
    });
    jest.dontMock('../../pathUtilities/url');
  });

  it('drops a host and the query, like iOS `standardizedFileURL`', () => {
    expect(normalizeFileUri('file://server/a', 'file')).toBe('file:///a');
    expect(normalizeFileUri('file:///a?q=1', 'file')).toBe('file:///a');
    expect(normalizeFileUri('file:///a/?q=1', 'directory')).toBe('file:///a/');
  });

  it('treats the scheme case-insensitively', () => {
    expect(normalizeFileUri('FILE:/a/b/', 'file')).toBe('file:///a/b');
  });
});

describe('opfsPathOf', () => {
  it('maps a file in a root to the root and the entry names', () => {
    expect(opfsPathOf('file:///cache/a/b.txt')).toEqual(['cache', 'a', 'b.txt']);
    expect(opfsPathOf('file:///document/notes.txt')).toEqual(['document', 'notes.txt']);
  });

  it('maps a directory uri with its trailing slash', () => {
    expect(opfsPathOf('file:///document/a/b/')).toEqual(['document', 'a', 'b']);
  });

  it('maps the roots themselves', () => {
    expect(opfsPathOf('file:///cache/')).toEqual(['cache']);
    expect(opfsPathOf('file:///cache')).toEqual(['cache']);
    expect(opfsPathOf(Paths.document.uri)).toEqual(['document']);
  });

  it('decodes percent-encoded names, because OPFS names are plain strings', () => {
    expect(opfsPathOf(new File(Paths.cache, 'my file#1.txt').uri)).toEqual([
      'cache',
      'my file#1.txt',
    ]);
    expect(opfsPathOf('file:///cache/%C5%BC%C3%B3%C5%82w')).toEqual(['cache', 'żółw']);
  });

  it('maps the uris that the constructors build', () => {
    expect(opfsPathOf(new File(Paths.cache, 'dir', 'a.txt').uri)).toEqual([
      'cache',
      'dir',
      'a.txt',
    ]);
    expect(opfsPathOf(new Directory(Paths.document, 'a', 'b').uri)).toEqual(['document', 'a', 'b']);
  });

  // A `..` in a constructor is resolved like on native, so it can move a path out of a root, and
  // the result is then no longer an OPFS path.
  it('maps a constructor path that leaves a root by where it ends up', () => {
    expect(opfsPathOf(new File(Paths.cache, '..', 'document', 'a.txt').uri)).toEqual([
      'document',
      'a.txt',
    ]);
    expect(opfsPathOf(new File(Paths.cache, '..', 'a.txt').uri)).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(opfsPathOf('file:///Cache/a.txt')).toBeNull();
    expect(opfsPathOf('file:///cache/A.txt')).toEqual(['cache', 'A.txt']);
  });

  it('returns null for uris outside the two roots', () => {
    for (const uri of [
      'file:///bundle/a.txt',
      'file:///',
      'file:///cached/a.txt',
      'file:///other/cache/a.txt',
      'file://host/cache/a.txt',
      'blob:http://localhost/cache/a',
      'data:,cache',
      'https://example.com/cache/a.txt',
      'cache/a.txt',
    ]) {
      expect(opfsPathOf(uri)).toBeNull();
    }
  });

  // These uris never come from the constructors, which resolve `..` and `.` and join slashes. They
  // could come from code that builds a uri by hand, so the mapping throws instead of guessing.
  it('rejects `..` and `.` segments so that a path cannot leave its root', () => {
    expect(() => opfsPathOf('file:///cache/../document/a.txt')).toThrow(INVALID_PATH);
    expect(() => opfsPathOf('file:///cache/a/../../x')).toThrow(INVALID_PATH);
    expect(() => opfsPathOf('file:///cache/./a.txt')).toThrow(INVALID_PATH);
    expect(() => opfsPathOf('file:///cache/%2E%2E/a.txt')).toThrow(INVALID_PATH);
  });

  it('rejects empty segments', () => {
    expect(() => opfsPathOf('file:///cache//a.txt')).toThrow(INVALID_PATH);
    expect(() => opfsPathOf('file:///cache/a//')).toThrow(INVALID_PATH);
  });

  it('rejects a name with an encoded slash, which OPFS does not allow', () => {
    expect(() => opfsPathOf('file:///cache/a%2Fb')).toThrow(INVALID_PATH);
  });

  it('rejects a malformed percent-encoding', () => {
    expect(() => opfsPathOf('file:///cache/a%E0%A4')).toThrow(INVALID_PATH);
  });

  it('rejects a query or a fragment', () => {
    expect(() => opfsPathOf('file:///cache/a.txt?x=1')).toThrow(INVALID_PATH);
    expect(() => opfsPathOf('file:///cache/a.txt#x')).toThrow(INVALID_PATH);
  });

  it('names the uri in the error', () => {
    const error = invalidPathError(() => opfsPathOf('file:///cache/../x')) as Error;
    expect(error.message).toContain('"file:///cache/../x"');
    expect(error.message).toContain('".."');
  });
});
