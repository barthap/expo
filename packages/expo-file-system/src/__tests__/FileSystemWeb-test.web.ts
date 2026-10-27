/**
 * @jest-environment node
 */
// jsdom has no `Blob.text()`, `Blob.stream()`, `URL.createObjectURL()`, or `Response`. The Node
// environment has the WHATWG `File`, `Blob`, `FormData`, and `Response` classes that browsers have,
// so the web backend runs against the same slots as in a browser.
import { Directory, File, Paths } from '../index';

const ERR_UNAVAILABLE = expect.objectContaining({ code: 'ERR_UNAVAILABLE' });

function makeWebFile(content = 'hello web', name = 'notes.txt') {
  return new globalThis.File([content], name, { type: 'text/plain', lastModified: 1234 });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('File on web, snapshot-backed', () => {
  it('is a real browser File, so browser APIs accept it without conversion', () => {
    const file = File.fromWebFile(makeWebFile());
    expect(file).toBeInstanceOf(globalThis.File);
    expect(file).toBeInstanceOf(Blob);
    expect(file).toBeInstanceOf(File);
  });

  it('keeps the name, type, size, and lastModified of the wrapped file', () => {
    const file = File.fromWebFile(makeWebFile());
    expect(file.name).toBe('notes.txt');
    expect(file.extension).toBe('.txt');
    expect(file.type).toBe('text/plain');
    expect(file.size).toBe(9);
    expect(file.lastModified).toBe(1234);
  });

  it('reads the wrapped data through every read method', async () => {
    const file = File.fromWebFile(makeWebFile('{"a":1}', 'data.json'));
    expect(await file.text()).toBe('{"a":1}');
    expect(await file.json()).toEqual({ a: 1 });
    expect(Array.from(await file.bytes())).toEqual(Array.from(Buffer.from('{"a":1}')));
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.from('{"a":1}'))
    );
    expect(await readStream(file.stream())).toBe('{"a":1}');
    expect(await readStream(file.readableStream())).toBe('{"a":1}');
  });

  it('slices like a Blob', async () => {
    const file = File.fromWebFile(makeWebFile('hello web'));
    const slice = file.slice(6, 9, 'text/x-test');
    expect(slice).toBeInstanceOf(Blob);
    expect(slice.type).toBe('text/x-test');
    expect(await slice.text()).toBe('web');
  });

  it('uses a blob: URL as uri, so new File(uri) finds the same data again', async () => {
    const file = File.fromWebFile(makeWebFile('round trip', 'trip.txt'));
    expect(file.uri.startsWith('blob:')).toBe(true);
    expect(file.exists).toBe(true);

    for (const copy of [new File(file.uri), new File(file)]) {
      expect(copy.uri).toBe(file.uri);
      expect(copy.name).toBe('trip.txt');
      expect(copy.size).toBe(10);
      expect(await copy.text()).toBe('round trip');
    }
  });

  it('delete() revokes the blob URL, so the uri no longer resolves to data', async () => {
    const file = File.fromWebFile(makeWebFile());
    const { uri } = file;
    file.delete();

    expect(file.exists).toBe(false);
    // The instance still holds its snapshot.
    expect(await file.text()).toBe('hello web');
    // A new File for the same uri is uri-backed now.
    const again = new File(uri);
    expect(again.exists).toBe(false);
    expect(() => again.size).toThrow(ERR_UNAVAILABLE);
  });

  it('toWebFile() returns a plain browser File with the same data and metadata', async () => {
    const file = File.fromWebFile(makeWebFile());
    const webFile = file.toWebFile();
    expect(webFile).toBeInstanceOf(globalThis.File);
    expect(webFile).not.toBeInstanceOf(File);
    expect(webFile.name).toBe('notes.txt');
    expect(webFile.type).toBe('text/plain');
    expect(webFile.lastModified).toBe(1234);
    expect(await webFile.text()).toBe('hello web');
  });

  it('sends the real file name in a multipart FormData upload', async () => {
    const file = File.fromWebFile(makeWebFile('upload me', 'photo.png'));
    const form = new FormData();
    form.append('upload', file);
    const body = await new Response(form).text();
    expect(body).toContain('filename="photo.png"');
    expect(body).toContain('upload me');
  });
});

describe('File on web, uri-backed', () => {
  it('reports exists only for data the browser can read locally', () => {
    expect(new File('data:text/plain;base64,aGk=').exists).toBe(true);
    expect(new File('https://example.com/photo.png').exists).toBe(false);
    expect(new File('blob:https://example.com/unknown').exists).toBe(false);
    expect(new File(Paths.cache, 'a.txt').exists).toBe(false);
    expect(new File(Paths.document, 'a.txt').exists).toBe(false);
  });

  it('takes the name and extension from the uri', () => {
    const file = new File('https://example.com/dir/photo.png');
    expect(file.name).toBe('photo.png');
    expect(file.extension).toBe('.png');
    expect(new File(Paths.cache, 'a.txt').uri).toBe('file:///cache/a.txt');
  });

  it('throws for size, slice, and stream instead of reporting empty data', () => {
    const file = new File('https://example.com/photo.png');
    expect(() => file.size).toThrow(ERR_UNAVAILABLE);
    expect(() => file.slice(0, 1)).toThrow(ERR_UNAVAILABLE);
    expect(() => file.stream()).toThrow(ERR_UNAVAILABLE);
    expect(() => file.toWebFile()).toThrow(ERR_UNAVAILABLE);
    expect(file.lastModified).toBeNull();
  });

  it('rejects reads, because the data is not loaded', async () => {
    const file = new File('https://example.com/photo.png');
    await expect(file.text()).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(file.bytes()).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(file.arrayBuffer()).rejects.toEqual(ERR_UNAVAILABLE);
  });

  it('delete() does nothing for a uri it did not register', () => {
    const file = new File('https://example.com/photo.png');
    expect(() => file.delete()).not.toThrow();
    expect(file.exists).toBe(false);
  });
});

describe('File on web, unsupported members', () => {
  const file = () => File.fromWebFile(makeWebFile());

  it.each([
    'writeSync',
    'create',
    'copySync',
    'moveSync',
    'rename',
    'open',
    'textSync',
    'bytesSync',
    'base64Sync',
    'info',
    'writableStream',
  ] as const)('%s() throws UnavailabilityError', (member) => {
    const f = file() as any;
    expect(() => f[member]()).toThrow(ERR_UNAVAILABLE);
  });

  it.each(['write', 'copy', 'move', 'base64', 'digest', 'canPreview', 'preview'] as const)(
    '%s() rejects with UnavailabilityError',
    async (member) => {
      const f = file() as any;
      await expect(f[member]()).rejects.toEqual(ERR_UNAVAILABLE);
    }
  );

  it.each(['md5', 'modificationTime', 'creationTime', 'contentUri'] as const)(
    '%s throws UnavailabilityError',
    (member) => {
      const f = file() as any;
      expect(() => f[member]).toThrow(ERR_UNAVAILABLE);
    }
  );

  it('explains what is missing and what to use instead', () => {
    expect(() => file().writeSync('x')).toThrow(/File\.writeSync is not available on web.*fetch/);
  });

  it('throws for uploads, download tasks, and watchers', () => {
    const f = file();
    expect(() => f.upload('https://example.com')).toThrow(ERR_UNAVAILABLE);
    expect(() => f.createUploadTask('https://example.com')).toThrow(ERR_UNAVAILABLE);
    expect(() => File.createDownloadTask('https://example.com', Paths.cache)).toThrow(
      ERR_UNAVAILABLE
    );
    expect(() => f.watch(() => {})).toThrow(ERR_UNAVAILABLE);
  });
});

describe('Directory and Paths on web', () => {
  it('exposes placeholder roots that exist', () => {
    expect(Paths.cache.uri).toBe('file:///cache/');
    expect(Paths.document.uri).toBe('file:///document/');
    expect(Paths.bundle.uri).toBe('file:///bundle/');
    for (const root of [Paths.cache, Paths.document, Paths.bundle]) {
      expect(root.exists).toBe(true);
    }
    expect(new Directory('file:///cache').exists).toBe(true);
  });

  it('treats everything below the roots as missing', () => {
    const dir = new Directory(Paths.cache, 'sub');
    expect(dir.uri).toBe('file:///cache/sub');
    expect(dir.exists).toBe(false);
    expect(dir.name).toBe('sub');
    expect(dir.parentDirectory.uri).toBe('file:///cache');
  });

  it('throws for directory operations', async () => {
    const dir = new Directory(Paths.cache, 'sub');
    expect(() => dir.create()).toThrow(ERR_UNAVAILABLE);
    expect(() => dir.list()).toThrow(/Directory\.list is not available on web/);
    expect(() => dir.delete()).toThrow(ERR_UNAVAILABLE);
    expect(() => dir.size).toThrow(ERR_UNAVAILABLE);
    await expect(dir.copy(Paths.document)).rejects.toEqual(ERR_UNAVAILABLE);
    expect(() => dir.watch(() => {})).toThrow(ERR_UNAVAILABLE);
  });

  it('throws for disk space and path info, and has no shared containers', () => {
    expect(() => Paths.totalDiskSpace).toThrow(ERR_UNAVAILABLE);
    expect(() => Paths.availableDiskSpace).toThrow(ERR_UNAVAILABLE);
    expect(() => Paths.info('file:///cache/')).toThrow(ERR_UNAVAILABLE);
    expect(Paths.appleSharedContainers).toEqual({});
  });
});
