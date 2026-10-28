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

  it('treats the scheme case-insensitively, like the browser fetch does', () => {
    const file = new File('DATA:,hi');
    expect(file.exists).toBe(true);
    expect(file.type).toBe('');
  });

  it('takes the name and extension from the uri', () => {
    const file = new File('https://example.com/dir/photo.png');
    expect(file.name).toBe('photo.png');
    expect(file.extension).toBe('.png');
    expect(new File(Paths.cache, 'a.txt').uri).toBe('file:///cache/a.txt');
  });

  it('throws for size, slice, and toWebFile instead of reporting empty data', () => {
    const file = new File('https://example.com/photo.png');
    expect(() => file.size).toThrow(ERR_UNAVAILABLE);
    expect(() => file.slice(0, 1)).toThrow(ERR_UNAVAILABLE);
    expect(() => file.toWebFile()).toThrow(ERR_UNAVAILABLE);
    expect(() => file.toWebFile()).toThrow(/new globalThis\.File\(\[await file\.bytes\(\)\]/);
    expect(file.lastModified).toBeNull();
  });

  it('delete() does nothing for a uri it did not register', () => {
    const file = new File('https://example.com/photo.png');
    expect(() => file.delete()).not.toThrow();
    expect(file.exists).toBe(false);
  });
});

describe('File on web, uri-backed reads', () => {
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function respondWith(body: string, headers: Record<string, string> = {}) {
    fetchMock.mockImplementation(async () => new Response(body, { headers }));
  }

  const uris = {
    'data:': 'data:application/json,{"a":1}',
    'http:': 'http://example.com/data.json',
    'foreign blob:': 'blob:http://example.com/0b6e5a3c-unknown',
  };

  describe.each(Object.entries(uris))('%s uri', (_, uri) => {
    beforeEach(() => respondWith('{"a":1}', { 'Content-Type': 'application/json' }));

    it('reads the data that fetch(uri) returns with every read method', async () => {
      const file = new File(uri);
      expect(await file.text()).toBe('{"a":1}');
      expect(await file.json()).toEqual({ a: 1 });
      const bytes = await file.bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(bytes)).toEqual(Array.from(Buffer.from('{"a":1}')));
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(
        new Uint8Array(Buffer.from('{"a":1}'))
      );
      expect(await readStream(file.stream())).toBe('{"a":1}');
      expect(await readStream(file.readableStream())).toBe('{"a":1}');
      for (const [calledUri] of fetchMock.mock.calls) {
        expect(calledUri).toBe(uri);
      }
      // One fetch per read; nothing is cached except the type.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('keeps throwing for size and slice after a read, because reads do not keep the data', async () => {
      const file = new File(uri);
      await file.text();
      expect(() => file.size).toThrow(ERR_UNAVAILABLE);
      expect(() => file.slice(0, 1)).toThrow(ERR_UNAVAILABLE);
      expect(file.lastModified).toBeNull();
    });
  });

  it('stream() does not fetch until the stream is read', async () => {
    respondWith('lazy');
    const stream = new File('https://example.com/a.txt').stream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString('utf8')).toBe('lazy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
  });

  it('stream().cancel() aborts a fetch that has not answered yet, so the request does not stay open', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    const reader = new File('https://example.com/slow').stream().getReader();
    reader.read().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('stream().cancel() cancels the response body after the first chunk', async () => {
    const bodyCancel = jest.fn();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.enqueue(new TextEncoder().encode('chunk')),
            cancel: bodyCancel,
          })
        )
    );
    const reader = new File('https://example.com/endless').stream().getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('done');
    expect(bodyCancel).toHaveBeenCalled();
  });

  it('decodes a data: uri for real, without a fetch mock', async () => {
    fetchMock.mockRestore();
    const file = new File('data:text/plain;base64,aGVsbG8=');
    expect(await file.text()).toBe('hello');
  });

  describe('type', () => {
    it('comes from the MIME type of a data: uri, with its parameters like Blob.type', () => {
      expect(new File('data:text/plain;charset=utf-8;base64,aGk=').type).toBe(
        'text/plain;charset=utf-8'
      );
      expect(new File('data:Image/PNG;base64,aGk=').type).toBe('image/png');
      expect(new File('data:,hi').type).toBe('');
      expect(new File('data:;base64,aGk=').type).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not change for a data: uri after a read', async () => {
      // Browsers answer `data:,hi` with `text/plain;charset=US-ASCII`; the uri names no type.
      respondWith('hi', { 'Content-Type': 'text/plain;charset=US-ASCII' });
      const file = new File('data:,hi');
      await file.text();
      expect(file.type).toBe('');
    });

    it.each([
      ['http:', 'https://example.com/photo'],
      ['foreign blob:', 'blob:http://example.com/0b6e5a3c-unknown'],
    ])('is empty for a %s uri until a read returns a Content-Type', async (_, uri) => {
      respondWith('<html></html>', { 'Content-Type': 'Text/HTML; charset=utf-8' });
      const file = new File(uri);
      expect(file.type).toBe('');
      await file.text();
      expect(file.type).toBe('text/html; charset=utf-8');
    });

    it('follows the Content-Type of every successful read', async () => {
      const file = new File('https://example.com/changing');
      respondWith('a', { 'Content-Type': 'text/plain' });
      await file.text();
      expect(file.type).toBe('text/plain');
      respondWith('{}', { 'Content-Type': 'application/json' });
      await file.text();
      expect(file.type).toBe('application/json');
    });

    it('keeps the boundary parameter, so formData() parses a multipart response', async () => {
      const body = [
        '--x',
        'Content-Disposition: form-data; name="greeting"',
        '',
        'hello',
        '--x--',
        '',
      ].join('\r\n');
      respondWith(body, { 'Content-Type': 'multipart/form-data; boundary=x' });
      const form = await new File('https://example.com/form').formData();
      // `formData()` is typed with the React Native `FormData`, which declares no `get()`.
      expect((form as unknown as globalThis.FormData).get('greeting')).toBe('hello');
    });

    it('stays empty when the response has no Content-Type', async () => {
      fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2])));
      const file = new File('blob:http://example.com/no-type');
      await file.bytes();
      expect(file.type).toBe('');
    });

    it('does not change after a failed read', async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response('missing', { status: 404, headers: { 'Content-Type': 'text/html' } })
      );
      const file = new File('https://example.com/missing.png');
      await expect(file.text()).rejects.toThrow();
      expect(file.type).toBe('');
    });
  });

  describe('errors', () => {
    it('rejects with the uri, the status, and the response as cause for a 404', async () => {
      const response = new Response('not here', { status: 404, statusText: 'Not Found' });
      fetchMock.mockResolvedValue(response);
      const uri = 'https://example.com/missing.png';
      const error = await new File(uri).text().catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(uri);
      expect(error.message).toContain('404 Not Found');
      expect(error.cause).toBe(response);
    });

    it('rejects with the uri and the network error as cause when fetch fails', async () => {
      const networkError = new TypeError('fetch failed');
      fetchMock.mockRejectedValue(networkError);
      const uri = 'https://example.com/offline.png';
      for (const read of ['text', 'bytes', 'arrayBuffer', 'json'] as const) {
        const error = await new File(uri)[read]().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(uri);
        expect(error.message).toContain('fetch failed');
        expect(error.cause).toBe(networkError);
      }
    });

    it('errors the stream on the first read when the fetch fails', async () => {
      fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
      const reader = new File('https://example.com/broken').stream().getReader();
      await expect(reader.read()).rejects.toThrow(/https:\/\/example\.com\/broken.*500/);
    });
  });

  it('never calls fetch for a snapshot-backed file', async () => {
    const file = File.fromWebFile(makeWebFile());
    await file.text();
    await file.bytes();
    await file.arrayBuffer();
    await file.json().catch(() => {});
    await readStream(file.stream());
    await readStream(new File(file.uri).stream());
    expect(fetchMock).not.toHaveBeenCalled();
    file.delete();
  });
});

describe('File.downloadFileAsync on web', () => {
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
  const downloaded: File[] = [];

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const file of downloaded.splice(0)) {
      file.delete();
    }
  });

  function respondWith(body: string | null, init: ResponseInit = {}) {
    fetchMock.mockImplementation(async () => new Response(body, init));
  }

  async function download(...args: Parameters<typeof File.downloadFileAsync>) {
    const file = await File.downloadFileAsync(...args);
    downloaded.push(file);
    return file;
  }

  it('returns a snapshot-backed file that holds the downloaded data', async () => {
    respondWith('downloaded data', { headers: { 'Content-Type': 'text/csv;charset=utf-8' } });
    const file = await download('https://example.com/files/report.csv', Paths.cache);
    expect(file).toBeInstanceOf(File);
    expect(file.uri.startsWith('blob:')).toBe(true);
    expect(file.exists).toBe(true);
    expect(file.size).toBe(15);
    expect(file.type).toBe('text/csv;charset=utf-8');
    expect(await file.text()).toBe('downloaded data');
    // Reads come from memory, not from the network again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await new File(file.uri).text()).toBe('downloaded data');
  });

  describe('name', () => {
    it('comes from a File destination first', async () => {
      respondWith('x', { headers: { 'Content-Disposition': 'attachment; filename="server.txt"' } });
      const file = await download(
        'https://example.com/url.txt',
        new File(Paths.document, 'mine.txt')
      );
      expect(file.name).toBe('mine.txt');
    });

    it.each([
      ['a quoted filename', 'attachment; filename="report 2026.pdf"', 'report 2026.pdf'],
      ['an unquoted filename', 'attachment; filename=report.pdf', 'report.pdf'],
      ['an escaped quote', 'attachment; filename="say \\"hi\\".txt"', 'say "hi".txt'],
      [
        'an encoded filename*, preferred over filename',
        `attachment; filename="fallback.txt"; filename*=UTF-8''%C5%BC%C3%B3%C5%82w.txt`,
        'żółw.txt',
      ],
      ['a path, which is dropped', 'attachment; filename="../../etc/passwd"', 'passwd'],
      [
        'filename when filename* is malformed',
        `attachment; filename*=UTF-8''%ZZ.txt; filename="ok.txt"`,
        'ok.txt',
      ],
    ])('comes from Content-Disposition with %s', async (_, header, name) => {
      respondWith('x', { headers: { 'Content-Disposition': header } });
      const file = await download('https://example.com/url-name.bin', Paths.cache);
      expect(file.name).toBe(name);
    });

    it.each([
      ['the last path segment', 'https://example.com/a/b%20c.png?size=2#top', 'b c.png'],
      ['the last non-empty segment', 'https://example.com/a/archive/', 'archive'],
      ['download for a URL without a path', 'https://example.com/', 'download'],
      ['download for a data: URL', 'data:text/plain,hello', 'download'],
      ['download for a malformed percent-encoding', 'https://example.com/a/%E9.txt', 'download'],
    ])('falls back to %s of the URL', async (_, url, name) => {
      respondWith('x');
      const file = await download(url, Paths.cache);
      expect(file.name).toBe(name);
    });

    it('falls back to the URL when filename* is malformed and there is no filename', async () => {
      respondWith('x', {
        headers: { 'Content-Disposition': `attachment; filename*=UTF-8''%ZZ.txt` },
      });
      const file = await download('https://example.com/from-url.txt', Paths.cache);
      expect(file.name).toBe('from-url.txt');
    });

    it('comes from the URL after redirects', async () => {
      fetchMock.mockImplementation(async () => {
        const response = new Response('x');
        Object.defineProperty(response, 'url', { value: 'https://cdn.example.com/real.zip' });
        return response;
      });
      const file = await download('https://example.com/latest', Paths.cache);
      expect(file.name).toBe('real.zip');
    });
  });

  it('sends the headers from the options', async () => {
    respondWith('x');
    await download('https://example.com/a.txt', Paths.cache, {
      headers: { Authorization: 'Bearer token' },
    });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('downloads a data: URL with the real fetch', async () => {
    fetchMock.mockRestore();
    const file = await download('data:application/json,{"a":1}', Paths.cache);
    expect(await file.json()).toEqual({ a: 1 });
    expect(file.type).toBe('application/json');
    expect(file.name).toBe('download');
  });

  it('sends one final progress event with the downloaded size', async () => {
    respondWith('12345');
    const onProgress = jest.fn();
    await download('https://example.com/a.txt', Paths.cache, { onProgress });
    expect(onProgress.mock.calls).toEqual([[{ bytesWritten: 5, totalBytes: 5 }]]);
  });

  it('rejects with the URL and the status for a non-2xx response, and creates no file', async () => {
    const response = new Response('nope', { status: 403, statusText: 'Forbidden' });
    fetchMock.mockResolvedValue(response);
    const createObjectURL = jest.spyOn(URL, 'createObjectURL');
    const url = 'https://example.com/secret.txt';
    const error = await File.downloadFileAsync(url, Paths.cache).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(url);
    expect(error.message).toContain('403 Forbidden');
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it('rejects with an AbortError when the signal aborts, because the signal goes to fetch', async () => {
    fetchMock.mockImplementation(
      (_, init) =>
        new Promise((_, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError'))
          );
        })
    );
    const controller = new AbortController();
    const promise = File.downloadFileAsync('https://example.com/slow.bin', Paths.cache, {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(controller.signal);
    controller.abort('user left');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', message: 'user left' });
  });

  it('rejects with an AbortError when the signal aborts while the body is read', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      const response = new Response('partial');
      // The headers arrived, then the abort stops the body.
      response.blob = async () => {
        controller.abort('user left');
        throw new DOMException('This operation was aborted', 'AbortError');
      };
      return response;
    });
    const createObjectURL = jest.spyOn(URL, 'createObjectURL');
    const error = await File.downloadFileAsync('https://example.com/big.bin', Paths.cache, {
      signal: controller.signal,
    }).catch((e) => e);
    // The shared AbortError carries the abort reason, not the browser's DOMException.
    expect(error).not.toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'AbortError', message: 'user left' });
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it('rejects with an AbortError without fetching when the signal is already aborted', async () => {
    await expect(
      File.downloadFileAsync('https://example.com/a.txt', Paths.cache, {
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each([
    'write',
    'copy',
    'move',
    'base64',
    'digest',
    'canPreview',
    'preview',
    'createAsync',
  ] as const)('%s() rejects with UnavailabilityError', async (member) => {
    const f = file() as any;
    await expect(f[member]()).rejects.toEqual(ERR_UNAVAILABLE);
  });

  it.each(['md5', 'modificationTime', 'creationTime', 'contentUri'] as const)(
    '%s throws UnavailabilityError',
    (member) => {
      const f = file() as any;
      expect(() => f[member]).toThrow(ERR_UNAVAILABLE);
    }
  );

  it('deleteAsync() releases the data like delete()', async () => {
    const f = file();
    await f.deleteAsync();
    expect(f.exists).toBe(false);
    expect(new File(f.uri).exists).toBe(false);
  });

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
    // Like on native, a directory uri ends with a slash.
    expect(dir.uri).toBe('file:///cache/sub/');
    expect(dir.exists).toBe(false);
    expect(dir.name).toBe('sub');
    expect(dir.parentDirectory.uri).toBe('file:///cache/');
  });

  it('throws for directory operations', async () => {
    const dir = new Directory(Paths.cache, 'sub');
    expect(() => dir.create()).toThrow(ERR_UNAVAILABLE);
    expect(() => dir.list()).toThrow(/Directory\.list is not available on web/);
    expect(() => dir.delete()).toThrow(ERR_UNAVAILABLE);
    expect(() => dir.size).toThrow(ERR_UNAVAILABLE);
    await expect(dir.copy(Paths.document)).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(dir.createAsync()).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(dir.deleteAsync()).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(dir.createFileAsync('a.txt', null)).rejects.toEqual(ERR_UNAVAILABLE);
    await expect(dir.createDirectoryAsync('inner')).rejects.toEqual(ERR_UNAVAILABLE);
    expect(() => dir.watch(() => {})).toThrow(ERR_UNAVAILABLE);
  });

  it('throws for disk space and path info, and has no shared containers', () => {
    expect(() => Paths.totalDiskSpace).toThrow(ERR_UNAVAILABLE);
    expect(() => Paths.availableDiskSpace).toThrow(ERR_UNAVAILABLE);
    expect(() => Paths.info('file:///cache/')).toThrow(ERR_UNAVAILABLE);
    expect(Paths.appleSharedContainers).toEqual({});
  });
});
