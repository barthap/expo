import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { Blob as ExpoBlob } from 'expo/blob';

import type { JasmineInterface } from '../types';

// Opt-in: runs only when named (`run?tests=blobstreambenchmark`), because the JS path takes
// seconds for the large cases. It logs times and asserts only that every byte arrived.
export const name = 'BlobStreamBenchmark';
export const optIn = true;

const MiB = 1024 * 1024;
// A JS-path write that takes longer than this is aborted and reported as skipped
const JS_PATH_LIMIT_MS = 60_000;
// Debug builds on an emulator write a few hundred KiB per second through JS, and the
// `writableStream()` case has no limit, because a pipe option would turn off the native copy
const CASE_TIMEOUT_MS = 10 * 60_000;

/**
 * A sink that writes every chunk through a `FileHandle` opened here, so `pipeTo` cannot
 * recognize it as a file and always moves the bytes through JS chunk by chunk.
 */
function jsFileSink(file: File): WritableStream<Uint8Array> {
  const handle = file.open(FileMode.WriteOnly);
  return new WritableStream<Uint8Array>({
    write: (chunk) => handle.writeBytes(chunk),
    close: () => handle.close(),
    abort: () => handle.close(),
  });
}

// One mebibyte of a repeating byte pattern, which the cases below repeat as Blob parts
function patternMiB(): Uint8Array {
  return new Uint8Array(MiB).map((_, i) => i % 251);
}

export async function test({ describe, expect, it, ...t }: JasmineInterface) {
  const directory = new Directory(Paths.cache, 'blob-stream-benchmark');

  describe(name, () => {
    let originalTimeout: number;

    t.beforeAll(() => {
      originalTimeout = t.jasmine.DEFAULT_TIMEOUT_INTERVAL;
      t.jasmine.DEFAULT_TIMEOUT_INTERVAL = CASE_TIMEOUT_MS;
      if (directory.exists) {
        directory.delete();
      }
      directory.create();
    });

    t.afterAll(() => {
      t.jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
      if (directory.exists) {
        directory.delete();
      }
    });

    async function measure(
      destinationName: string,
      blob: Blob,
      createSink: (file: File) => WritableStream<Uint8Array>,
      limitMs?: number
    ): Promise<number | null> {
      // A file of its own, so a case that timed out and still writes cannot change another
      const destination = new File(directory, destinationName);
      // iOS opens a write handle only for an existing file
      destination.create({ overwrite: true });
      const controller = new AbortController();
      const timer = limitMs ? setTimeout(() => controller.abort(), limitMs) : null;
      const started = performance.now();
      try {
        await blob
          .stream()
          .pipeTo(createSink(destination), limitMs ? { signal: controller.signal } : undefined);
      } catch (error) {
        if (controller.signal.aborted) {
          return null;
        }
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      const elapsed = performance.now() - started;
      expect(destination.size).toBe(blob.size);
      return elapsed;
    }

    async function run(caseName: string, createBlob: () => Blob) {
      const blob = createBlob();
      const js = await measure(`${caseName}-js.bin`, blob, jsFileSink, JS_PATH_LIMIT_MS);
      const native = await measure(`${caseName}-native.bin`, blob, (file) => file.writableStream());
      const format = (ms: number | null) => (ms == null ? 'skipped' : ms.toFixed(1));
      console.log(`[BlobStreamBenchmark] ${caseName} js=${format(js)} native=${format(native)}`);
    }

    it('writes a 3 MB in-memory Blob', async () => {
      const pattern = patternMiB();
      await run('memory-3MB', () => new ExpoBlob([pattern, pattern, pattern]));
    });

    it('writes a 50 MB in-memory Blob', async () => {
      const pattern = patternMiB();
      await run('memory-50MB', () => new ExpoBlob(new Array(50).fill(pattern)));
    });

    it('writes a 50 MB file-backed Blob', async () => {
      const pattern = patternMiB();
      const source = new File(directory, 'source.bin');
      source.create({ overwrite: true });
      const handle = source.open(FileMode.WriteOnly);
      try {
        for (let i = 0; i < 50; i++) {
          handle.writeBytesSync(pattern);
        }
      } finally {
        handle.close();
      }
      await run('file-50MB', () => source.slice());
    });
  });
}
