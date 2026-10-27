import { Directory, File, Paths } from 'expo-file-system';

import type { JasmineInterface } from '../types';

export const name = 'FileSystemWeb';

// Runs the web backend of expo-file-system against the browser's own `File`, `Blob`, `FormData`,
// and `URL.createObjectURL`, which jest can only approximate.
export async function test({ afterEach, describe, expect, it }: JasmineInterface) {
  // `File.fromWebFile()` keeps the data in memory until `delete()`, so every test cleans up.
  const createdFiles: File[] = [];

  function fromWebFile(webFile: globalThis.File): File {
    const file = File.fromWebFile(webFile);
    createdFiles.push(file);
    return file;
  }

  function makeWebFile(content = 'hello web', fileName = 'notes.txt') {
    return new globalThis.File([content], fileName, { type: 'text/plain', lastModified: 1234 });
  }

  function errorCodeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (error: any) {
      return error.code;
    }
    return undefined;
  }

  async function rejectionCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error: any) {
      return error.code;
    }
    return undefined;
  }

  async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  describe('FileSystemWeb', () => {
    afterEach(() => {
      for (const file of createdFiles.splice(0)) {
        file.delete();
      }
    });

    describe('snapshot-backed File', () => {
      it('is a real browser File and Blob', () => {
        const file = fromWebFile(makeWebFile());
        expect(file instanceof globalThis.File).toBe(true);
        expect(file instanceof Blob).toBe(true);
        expect(file instanceof File).toBe(true);
      });

      it('keeps name, extension, type, size, and lastModified', () => {
        const file = fromWebFile(makeWebFile());
        expect(file.name).toBe('notes.txt');
        expect(file.extension).toBe('.txt');
        expect(file.type).toBe('text/plain');
        expect(file.size).toBe(9);
        expect(file.lastModified).toBe(1234);
      });

      it('reads data with text, bytes, arrayBuffer, json, and stream', async () => {
        const file = fromWebFile(makeWebFile('{"a":1}', 'data.json'));
        expect(await file.text()).toBe('{"a":1}');
        expect(await file.json()).toEqual({ a: 1 });
        expect(Array.from(await file.bytes())).toEqual([123, 34, 97, 34, 58, 49, 125]);
        expect(new Uint8Array(await file.arrayBuffer()).length).toBe(7);
        expect(await readStream(file.stream())).toBe('{"a":1}');
      });

      it('slices like a Blob', async () => {
        const slice = fromWebFile(makeWebFile()).slice(6, 9, 'text/x-test');
        expect(slice instanceof Blob).toBe(true);
        expect(slice.type).toBe('text/x-test');
        expect(await slice.text()).toBe('web');
      });

      it('round-trips through its blob: uri', async () => {
        const file = fromWebFile(makeWebFile('round trip', 'trip.txt'));
        expect(file.uri.startsWith('blob:')).toBe(true);
        expect(file.exists).toBe(true);
        const copy = new File(file.uri);
        expect(copy.name).toBe('trip.txt');
        expect(copy.size).toBe(10);
        expect(await copy.text()).toBe('round trip');
        // The browser resolves the same URL to the same data.
        expect(await (await fetch(file.uri)).text()).toBe('round trip');
      });

      it('delete() revokes the blob: uri', async () => {
        const file = fromWebFile(makeWebFile());
        const { uri } = file;
        file.delete();
        expect(file.exists).toBe(false);
        expect(new File(uri).exists).toBe(false);
        let fetchFailed = false;
        try {
          await fetch(uri);
        } catch {
          fetchFailed = true;
        }
        expect(fetchFailed).toBe(true);
      });

      it('toWebFile() returns a plain browser File', async () => {
        const webFile = fromWebFile(makeWebFile()).toWebFile();
        expect(webFile instanceof globalThis.File).toBe(true);
        expect(webFile instanceof File).toBe(false);
        expect(webFile.name).toBe('notes.txt');
        expect(webFile.lastModified).toBe(1234);
        expect(await webFile.text()).toBe('hello web');
      });

      it('sends the real file name in a multipart FormData body', async () => {
        const form = new FormData();
        form.append('upload', fromWebFile(makeWebFile('upload me', 'photo.png')));
        const body = await new Response(form).text();
        expect(body).toContain('filename="photo.png"');
        expect(body).toContain('upload me');
      });

      it('keeps name and lastModified through structuredClone', () => {
        const clone = structuredClone(fromWebFile(makeWebFile()));
        expect(clone instanceof globalThis.File).toBe(true);
        expect(clone.name).toBe('notes.txt');
        expect(clone.lastModified).toBe(1234);
      });
    });

    describe('uri-backed File', () => {
      it('exists only for data: uris and registered blob: uris', () => {
        expect(new File('data:text/plain;base64,aGk=').exists).toBe(true);
        expect(new File('https://example.com/photo.png').exists).toBe(false);
        expect(new File(Paths.cache, 'a.txt').exists).toBe(false);
      });

      it('takes name and extension from the uri', () => {
        const file = new File('https://example.com/dir/photo.png');
        expect(file.name).toBe('photo.png');
        expect(file.extension).toBe('.png');
      });

      it('throws for size and slice, and has no lastModified', () => {
        const file = new File('https://example.com/photo.png');
        expect(errorCodeOf(() => file.size)).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.slice(0, 1))).toBe('ERR_UNAVAILABLE');
        expect(file.lastModified).toBe(null);
      });
    });

    describe('uri-backed reads', () => {
      // Blob URLs created by the tests, not by expo-file-system, so `File` treats them as foreign.
      const foreignBlobUrls: string[] = [];

      function createForeignBlobUrl(blob: Blob): string {
        const url = URL.createObjectURL(blob);
        foreignBlobUrls.push(url);
        return url;
      }

      // The MIME type without its parameters, for example `text/html` for `text/html; charset=utf-8`.
      function essenceOf(type: string): string {
        return type.split(';')[0]!.trim();
      }

      afterEach(() => {
        for (const url of foreignBlobUrls.splice(0)) {
          URL.revokeObjectURL(url);
        }
      });

      it('reads a data: uri and takes type from its MIME type', async () => {
        // `{"a":1}` in base64.
        const file = new File('data:application/json;base64,eyJhIjoxfQ==');
        expect(file.type).toBe('application/json');
        expect(await file.text()).toBe('{"a":1}');
        expect(await file.json()).toEqual({ a: 1 });
        expect(Array.from(await file.bytes())).toEqual([123, 34, 97, 34, 58, 49, 125]);
        expect(new Uint8Array(await file.arrayBuffer()).length).toBe(7);
        expect(await readStream(file.stream())).toBe('{"a":1}');
        expect(file.type).toBe('application/json');
      });

      it('reads a blob: URL that another library created', async () => {
        const uri = createForeignBlobUrl(new Blob(['foreign data'], { type: 'text/plain' }));
        const file = new File(uri);
        expect(file.exists).toBe(false);
        expect(file.type).toBe('');
        expect(await file.text()).toBe('foreign data');
        // The browser sends the Blob type as the Content-Type of the blob: URL.
        expect(essenceOf(file.type)).toBe('text/plain');
        expect((await file.bytes()).length).toBe(12);
        expect(await readStream(file.stream())).toBe('foreign data');
        expect(errorCodeOf(() => file.size)).toBe('ERR_UNAVAILABLE');
      });

      it('rejects with the uri and the fetch error when a blob: URL is revoked', async () => {
        const uri = createForeignBlobUrl(new Blob(['gone']));
        URL.revokeObjectURL(uri);
        let error: any = null;
        try {
          await new File(uri).text();
        } catch (e) {
          error = e;
        }
        expect(error instanceof Error).toBe(true);
        expect(error.message).toContain(uri);
        expect(error.cause instanceof TypeError).toBe(true);
      });

      it('reads a same-origin http: URL and caches its Content-Type', async () => {
        // The dev server serves the test-suite page itself, so its URL always exists.
        const file = new File(location.href);
        expect(file.exists).toBe(false);
        expect(file.type).toBe('');
        const html = await file.text();
        expect(/<!DOCTYPE|<html/i.test(html)).toBe(true);
        // The dev server may add a `charset` parameter, which `type` keeps.
        expect(essenceOf(file.type)).toBe('text/html');
      });
    });

    describe('unsupported members', () => {
      it('throw or reject with UnavailabilityError', async () => {
        const file = fromWebFile(makeWebFile());
        expect(await rejectionCodeOf(file.write('x'))).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.writeSync('x'))).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.create())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.open())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.textSync())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.md5)).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.info())).toBe('ERR_UNAVAILABLE');
        expect(await rejectionCodeOf(file.digest('SHA-256'))).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.upload('https://example.com'))).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => file.watch(() => {}))).toBe('ERR_UNAVAILABLE');
      });
    });

    describe('Directory and Paths', () => {
      it('roots exist, everything below them does not', () => {
        expect(Paths.cache.uri).toBe('file:///cache/');
        expect(Paths.cache.exists).toBe(true);
        expect(Paths.document.exists).toBe(true);
        expect(Paths.bundle.exists).toBe(true);
        const dir = new Directory(Paths.cache, 'sub');
        expect(dir.exists).toBe(false);
        expect(dir.name).toBe('sub');
        expect(dir.parentDirectory.uri).toBe('file:///cache');
      });

      it('throws for directory operations and disk space', () => {
        const dir = new Directory(Paths.cache, 'sub');
        expect(errorCodeOf(() => dir.create())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => dir.list())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => Paths.totalDiskSpace)).toBe('ERR_UNAVAILABLE');
        expect(Paths.appleSharedContainers).toEqual({});
      });
    });
  });
}
