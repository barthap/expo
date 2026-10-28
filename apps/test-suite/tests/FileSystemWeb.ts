import { Directory, File, Paths } from 'expo-file-system';

import type { JasmineInterface } from '../types';

export const name = 'FileSystemWeb';

// Runs the web backend of expo-file-system against the browser's own `File`, `Blob`, `FormData`,
// and `URL.createObjectURL`, which jest can only approximate.
export async function test({ afterEach, describe, expect, it, pending }: JasmineInterface) {
  // The sync members of files in `Paths.cache` and `Paths.document` need the index of the OPFS
  // storage.
  await Paths.ready();
  // The same check as the package uses: a secure context and `createWritable()`.
  const hasOpfs =
    globalThis.isSecureContext === true &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof globalThis.FileSystemFileHandle === 'function' &&
    'createWritable' in globalThis.FileSystemFileHandle.prototype;

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

    describe('downloadFileAsync', () => {
      async function download(...args: Parameters<typeof File.downloadFileAsync>) {
        const file = await File.downloadFileAsync(...args);
        createdFiles.push(file);
        return file;
      }

      // The MIME type without its parameters, for example `text/html` for `text/html; charset=utf-8`.
      function essenceOf(type: string): string {
        return type.split(';')[0]!.trim();
      }

      // `Paths.bundle` is not stored, so a download there stays in memory.
      it('downloads a data: URL into memory and takes the name of a File destination', async () => {
        const progress: { bytesWritten: number; totalBytes: number }[] = [];
        const file = await download(
          'data:text/plain,hello%20web',
          new File(Paths.bundle, 'greeting.txt'),
          { onProgress: (event) => progress.push(event) }
        );
        expect(file.uri.startsWith('blob:')).toBe(true);
        expect(file.exists).toBe(true);
        expect(file.name).toBe('greeting.txt');
        expect(essenceOf(file.type)).toBe('text/plain');
        expect(file.size).toBe(9);
        expect(await file.text()).toBe('hello web');
        expect(await (await fetch(file.uri)).text()).toBe('hello web');
        expect(progress).toEqual([{ bytesWritten: 9, totalBytes: 9 }]);
      });

      it('downloads a same-origin http: URL and takes the name from its path', async () => {
        // The dev server serves the test-suite page itself, so its URL always exists.
        const file = await download(location.href, Paths.bundle);
        expect(file.name).toBe(location.pathname.split('/').filter(Boolean).pop() ?? 'download');
        expect(essenceOf(file.type)).toBe('text/html');
        expect(/<!DOCTYPE|<html/i.test(await file.text())).toBe(true);
        expect(file.size > 0).toBe(true);
      });

      it('rejects with an AbortError when the signal aborts during the fetch', async () => {
        const controller = new AbortController();
        const promise = File.downloadFileAsync(location.href, Paths.cache, {
          signal: controller.signal,
        });
        controller.abort();
        let error: any = null;
        try {
          createdFiles.push(await promise);
        } catch (e) {
          error = e;
        }
        expect(error?.name).toBe('AbortError');
      });
    });

    describe('pickFileAsync', () => {
      // The real dialog needs a click by a person, so picking itself is a manual check. Events that
      // a test dispatches do not count as user activation.
      it('throws ERR_USER_ACTIVATION outside a user gesture instead of waiting forever', async () => {
        const activation = (navigator as any).userActivation;
        if (!activation) {
          pending('this browser has no navigator.userActivation, so the picker cannot tell');
          return;
        }
        if (activation.isActive) {
          pending('the page has user activation (for example a click to start the tests)');
          return;
        }
        let error: any = null;
        try {
          await File.pickFileAsync();
        } catch (e) {
          error = e;
        }
        expect(error?.code).toBe('ERR_USER_ACTIVATION');
        expect(document.querySelector('input[type="file"]')).toBe(null);
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
        // Like on native, a directory uri ends with a slash.
        expect(dir.parentDirectory.uri).toBe('file:///cache/');
      });

      it('throws for sync directory operations and disk space', () => {
        const dir = new Directory(Paths.cache, 'sub');
        expect(errorCodeOf(() => dir.create())).toBe('ERR_UNAVAILABLE');
        expect(errorCodeOf(() => dir.list())).toBe('ERR_NOT_FOUND');
        expect(errorCodeOf(() => new Directory(Paths.bundle, 'sub').list())).toBe(
          'ERR_UNAVAILABLE'
        );
        expect(errorCodeOf(() => Paths.totalDiskSpace)).toBe('ERR_UNAVAILABLE');
        expect(Paths.appleSharedContainers).toEqual({});
      });
    });

    // `Paths.cache` and `Paths.document` against the browser's real OPFS, which jest only replaces
    // with a fake. Each spec writes below its own directory and removes it.
    describe('OPFS storage', () => {
      const runId = Date.now();

      it('creates, writes, reads, lists, and deletes files under Paths.cache', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        const directory = new Directory(Paths.cache, `opfs-spec-${runId}`);
        try {
          await directory.createAsync();
          expect(directory.exists).toBe(true);
          const file = new File(directory, 'notes one.txt');
          await file.createAsync();
          expect(file.exists).toBe(true);
          expect(file.size).toBe(0);
          await file.write('hello opfs');
          await file.write('!', { append: true });
          expect(file.size).toBe(11);
          expect(await file.text()).toBe('hello opfs!');
          expect(new TextDecoder().decode(await file.bytes())).toBe('hello opfs!');
          expect(await readStream(file.stream())).toBe('hello opfs!');
          expect(directory.list().map((item) => item.uri)).toEqual([file.uri]);
          expect(directory.size).toBe(11);
          expect(Paths.info(file.uri)).toEqual({ exists: true, isDirectory: false });

          const copy = new File(Paths.document, `opfs-spec-${runId}.txt`);
          await file.copy(copy);
          expect(await copy.text()).toBe('hello opfs!');
          await copy.deleteAsync();
          expect(copy.exists).toBe(false);

          await file.deleteAsync();
          expect(file.exists).toBe(false);
          expect(await rejectionCodeOf(file.text())).toBe('ERR_NOT_FOUND');
        } finally {
          await directory.deleteAsync().catch(() => {});
        }
        expect(directory.exists).toBe(false);
      });

      it('stores a picked or wrapped file with move(), which releases its blob: URL', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        const directory = new Directory(Paths.document, `opfs-move-spec-${runId}`);
        try {
          await directory.createAsync();
          const file = File.fromWebFile(makeWebFile('moved data', 'photo.txt'));
          const blobUri = file.uri;
          await file.move(directory);
          expect(file.uri).toBe(new File(directory, 'photo.txt').uri);
          expect(new File(blobUri).exists).toBe(false);
          // A revoked blob: URL no longer resolves.
          expect(
            await fetch(blobUri).then(
              () => 'resolved',
              () => 'rejected'
            )
          ).toBe('rejected');
          expect(file.exists).toBe(true);
          expect(await file.text()).toBe('moved data');
        } finally {
          await directory.deleteAsync().catch(() => {});
        }
      });

      it('downloads into Paths.document by piping the response body', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        const directory = new Directory(Paths.document, `opfs-download-spec-${runId}`);
        try {
          await directory.createAsync();
          const file = await File.downloadFileAsync(
            location.href,
            new File(directory, 'page.html')
          );
          expect(file.uri).toBe(new File(directory, 'page.html').uri);
          expect(file.size > 0).toBe(true);
          expect(/<!DOCTYPE|<html/i.test(await file.text())).toBe(true);
          const error = await File.downloadFileAsync(location.href, file).catch((e: any) => e);
          expect(error?.code).toBe('ERR_DESTINATION_ALREADY_EXISTS');
        } finally {
          await directory.deleteAsync().catch(() => {});
        }
      });

      // Writes ask for `mode: 'exclusive'`, so a write to a file while another one is open fails
      // instead of dropping the other's data when both close.
      it('rejects one of two overlapping writes to a file with ERR_FILE_LOCKED', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        const file = new File(Paths.cache, `opfs-lock-spec-${runId}.bin`);
        try {
          const results = await Promise.allSettled([
            file.write(new Uint8Array(8 * 1024 * 1024).fill(1)),
            file.write(new Uint8Array(8 * 1024 * 1024).fill(2)),
          ]);
          const rejected = results.filter((result) => result.status === 'rejected');
          expect(rejected.length).toBe(1);
          expect((rejected[0] as PromiseRejectedResult).reason?.code).toBe('ERR_FILE_LOCKED');
          expect(file.size).toBe(8 * 1024 * 1024);
        } finally {
          await file.deleteAsync().catch(() => {});
        }
      });

      // Cross-reload persistence is a manual check; see the report of the OPFS change. Within one
      // run, the second spec reads the file the first wrote through a new `File`.
      const persisted = () => new File(Paths.document, `opfs-persist-spec-${runId}.json`);

      it('writes a file in Paths.document for the next spec', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        await persisted().write(JSON.stringify({ runId }));
        expect(persisted().exists).toBe(true);
      });

      it('reads the file of the previous spec through a new File after Paths.ready()', async () => {
        if (!hasOpfs) {
          pending('This browser has no OPFS.');
          return;
        }
        await Paths.ready();
        const file = persisted();
        try {
          expect(file.exists).toBe(true);
          expect(await file.json()).toEqual({ runId });
        } finally {
          await file.deleteAsync().catch(() => {});
        }
      });
    });
  });
}
