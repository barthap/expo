import { UnavailabilityError, uuid, type EventSubscription } from 'expo-modules-core';
import { Blob as ExpoBlob } from 'expo/blob';
import { Platform } from 'react-native';

import { Directory } from './Directory';
import ExpoFileSystem from './ExpoFileSystem';
import {
  FileMode,
  type FileCanPreviewOptions,
  type FilePreviewOptions,
  type FilePreviewCollectionOptions,
  type PickFileOptions,
  type PickMultipleFilesOptions,
  type PickMultipleFilesResult,
  type PickSingleFileOptions,
  type PickSingleFileResult,
} from './File.types';
import {
  type WatchEvent,
  type WatchOptions,
  type WatchSubscription,
} from './FileSystemWatcher.types';
import { DownloadTask, UploadTask } from './NetworkTasks';
import {
  type DownloadOptions,
  type DownloadProgress,
  type DownloadTaskOptions,
  type UploadOptions,
  type UploadResult,
} from './NetworkTasks.types';
import { Paths } from './Paths';
import { FileSystemWatcher } from './internal/FileSystemWatcher';
import { FileSystemReadableStreamSource, FileSystemWritableSink } from './internal/streams';
import { extname } from './pathUtilities/path';

/**
 * The `Blob` constructor of `expo/blob` takes any part with a method under this symbol and reads
 * the returned byte range of the file on every read of the `Blob`, instead of copying the bytes.
 */
const FILE_RANGE: unique symbol = Symbol.for('expo.blob.fileRange');

type FileRangeReference = { uri: string; offset: number; size: number };

function fileRangePart(reference: FileRangeReference): BlobPart {
  // The declared Blob part types do not include file ranges, which are internal to expo and
  // expo-file-system, so the part is typed as a Blob part here.
  return { [FILE_RANGE]: () => reference } as unknown as BlobPart;
}

/**
 * Represents a file on the filesystem.
 *
 * A `File` instance can be created for any path, and does not need to exist on the filesystem during creation.
 *
 * The constructor accepts an array of strings that are joined to create the file URI. The first argument can also be a `Directory` instance (like `Paths.cache`) or a `File` instance (which creates a new reference to the same file).
 *
 * > **Note:** On web, there is no file system to write to yet. A `File` either holds its data in
 * > memory, when it comes from `File.fromWebFile()`, `File.pickFileAsync()`, or
 * > `File.downloadFileAsync()`, or only has a URI, such as a `blob:`, `data:`, or `https:` URL, and
 * > reads it with `fetch()`. Members that need a file system are not available on web.
 * @example
 * ```ts
 * const file = new File(Paths.cache, "subdirName", "file.txt");
 * ```
 */
export class File extends ExpoFileSystem.FileSystemFile implements Blob {
  /**
   * Checks whether every supplied local file can be previewed.
   * Android resolves to `false` for more than one file. Only iOS previews multiple files.
   * An array with one file behaves like a single `File`.
   * Rejects empty arrays and invalid arguments.
   * @platform ios
   * @platform android
   *
   * @example
   * ```ts
   * const files = [new File(Paths.cache, 'report.pdf'), new File(Paths.cache, 'notes.txt')];
   * const canPreviewAll = await File.canPreview(files);
   * ```
   */
  static async canPreview(input: File | File[], options?: FileCanPreviewOptions): Promise<boolean> {
    const files = normalizePreviewFiles(input);
    validateCollectionPreviewOptions(files, options);
    if (files.length === 1) {
      return files[0]!.canPreview(options);
    }
    if (Platform.OS !== 'ios' || Platform.isTV) {
      return false;
    }
    if (!ExpoFileSystem.canPreview) {
      throw new UnavailabilityError('expo-file-system', 'File.canPreview');
    }
    return ExpoFileSystem.canPreview(files);
  }

  /**
   * Previews local files in the supplied order, starting at `initialIndex` (default `0`).
   * Android rejects more than one file. Only iOS previews multiple files.
   * An array with one file behaves like a single `File`.
   * Rejects if you pass `title` or `mimeType` with more than one file.
   * Also rejects empty arrays, an invalid `initialIndex`, and files that cannot be previewed.
   * Resolves at presentation or handoff to another app, not when the viewer closes.
   * @platform ios
   * @platform android
   *
   * @example
   * ```ts
   * // The files must exist before previewing.
   * const files = [new File(Paths.cache, 'report.pdf'), new File(Paths.cache, 'notes.txt')];
   * if (await File.canPreview(files)) {
   *   await File.preview(files, { initialIndex: 1 });
   * }
   * ```
   */
  static async preview(
    input: File | File[],
    options?: FilePreviewOptions & FilePreviewCollectionOptions
  ): Promise<void> {
    const files = normalizePreviewFiles(input);
    const initialIndex = options?.initialIndex ?? 0;
    if (!Number.isInteger(initialIndex) || initialIndex < 0 || initialIndex >= files.length) {
      throw new RangeError('initialIndex must be an integer within the preview collection.');
    }
    validateCollectionPreviewOptions(files, options);
    if (files.length === 1) {
      return files[0]!.preview({ title: options?.title, mimeType: options?.mimeType });
    }
    if (Platform.OS !== 'ios' || Platform.isTV || !ExpoFileSystem.preview) {
      throw new UnavailabilityError('expo-file-system', 'File.preview (multiple files)');
    }
    return ExpoFileSystem.preview(files, initialIndex);
  }

  /**
   * A static method that downloads a file from the network.
   *
   * On Android, the response body streams directly into the target file. If the download fails after
   * it starts, a partially written file may remain at the destination. On iOS, the download first
   * completes in a temporary location and the file is moved into place only after success, so no
   * file is left behind when the request fails.
   *
   * > **Note:** On web, the file is downloaded into memory with `fetch()`, and the returned file holds
   * > its data under a `blob:` URL until you call `delete()`. The location of `destination` is
   * > ignored, because `Paths.cache` and `Paths.document` are placeholders on web. A `File`
   * > destination only gives the file name. Otherwise, the name comes from the `Content-Disposition`
   * > header, then from the last segment of an `http:` or `https:` URL, and is `download` when
   * > neither has one. `options.idempotent` is ignored, `onProgress` is called once with the
   * > final size, and only when the downloaded file is not empty, and a non-2xx response rejects
   * > with an error that includes the status code.
   *
   * @param url - The URL of the file to download.
   * @param destination - The destination directory or file. If a directory is provided, the resulting filename will be determined based on the response headers.
   * @param options - Download options. When the destination already contains a file, the promise rejects with a `DestinationAlreadyExists` error unless `options.idempotent` is set to `true`. With `idempotent: true`, the download overwrites the existing file instead of failing.
   *
   * @returns A promise that resolves to the downloaded file. When the server responds with
   * a non-2xx HTTP status, the promise rejects with an `UnableToDownload` error whose
   * message includes the status code. No file is created in that scenario.
   *
   * @example
   * ```ts
   * const file = await File.downloadFileAsync("https://example.com/image.png", new Directory(Paths.document));
   * ```
   */
  static downloadFileAsync: (
    url: string,
    destination: Directory | File,
    options?: DownloadOptions
  ) => Promise<File>;

  /**
   * Opens the system file picker for selecting a single file.
   *
   * This overload requires `options.multipleFiles` to be `undefined` or `false`.
   *
   * > **Note:** On web, the picker is an `<input type="file">` dialog, and `initialUri` is ignored.
   * > Call it from a user gesture, such as a click handler. Otherwise browsers do not open the
   * > dialog, and in browsers with `navigator.userActivation` the promise rejects with an
   * > `ERR_USER_ACTIVATION` error instead of resolving with a canceled result. A call made while
   * > another picker is open resolves with a canceled result. In browsers without
   * > `navigator.userActivation`, a call made outside a user gesture never settles the promise,
   * > because no dialog opens and no event follows.
   * > A closed dialog is detected with the `cancel` event of file inputs, so in Chrome 37 to 112
   * > and Safari 15.4 to 16.3 the promise may never settle when the user closes the dialog. Picked
   * > files hold their data under a `blob:` URL until you call `delete()`.
   *
   * @param options File picker options.
   */
  static pickFileAsync(options?: PickSingleFileOptions): Promise<PickSingleFileResult>;
  /**
   * Opens the system file picker for selecting multiple files.
   *
   * This overload requires `options.multipleFiles` to be `true`.
   *
   * > **Note:** On web, the picker is an `<input type="file">` dialog, and `initialUri` is ignored.
   * > Call it from a user gesture, such as a click handler. Otherwise browsers do not open the
   * > dialog, and in browsers with `navigator.userActivation` the promise rejects with an
   * > `ERR_USER_ACTIVATION` error instead of resolving with a canceled result. A call made while
   * > another picker is open resolves with a canceled result. In browsers without
   * > `navigator.userActivation`, a call made outside a user gesture never settles the promise,
   * > because no dialog opens and no event follows.
   * > A closed dialog is detected with the `cancel` event of file inputs, so in Chrome 37 to 112
   * > and Safari 15.4 to 16.3 the promise may never settle when the user closes the dialog. Picked
   * > files hold their data under a `blob:` URL until you call `delete()`.
   *
   * @param options File picker options.
   *
   * @example
   * ```ts
   * const result = await File.pickFileAsync({
   *   multipleFiles: true,
   *   mimeTypes: ['image/*', 'application/pdf'],
   * });
   *
   * if (!result.canceled) {
   *   for (const file of result.result) {
   *     console.log(file.uri);
   *   }
   * }
   * ```
   */
  static pickFileAsync(options?: PickMultipleFilesOptions): Promise<PickMultipleFilesResult>;
  /**
   * A static method that opens a file picker to select a single file of specified type. On iOS, it returns a temporary copy of the file leaving the original file untouched.
   *
   * Selecting multiple files is not supported yet.
   *
   * @deprecated Use `pickFileAsync({initialUri, mimeTypes: mimeType})` instead.
   * @param initialUri An optional URI pointing to an initial folder on which the file picker is opened.
   * @param mimeType A mime type that is used to filter out files that can be picked out.
   * @returns A `File` instance or an array of `File` instances.
   */
  static pickFileAsync(initialUri?: string, mimeType?: string): Promise<File | File[]>;
  static async pickFileAsync(
    initialUriOrOptions?: string | PickFileOptions,
    mimeType?: string
  ): Promise<File | File[] | PickSingleFileResult | PickMultipleFilesResult> {
    const { options, usingOldAPI } = parsePickFileOptions(initialUriOrOptions, mimeType);
    try {
      if (options.multipleFiles) {
        const files = await ExpoFileSystem.pickFileAsync(options);
        return { result: files.map((file) => new File(file.uri)), canceled: false };
      }
      const file = await ExpoFileSystem.pickFileAsync(options);
      if (usingOldAPI) {
        return new File(file.uri);
      }
      return {
        result: new File(file.uri),
        canceled: false,
      };
    } catch (e) {
      // On web, a picker opened outside a user gesture never opens. That is a bug in the calling
      // code, not a cancel, so it is thrown. Native modules never use this code.
      if (usingOldAPI || (e as { code?: unknown })?.code === 'ERR_USER_ACTIVATION') {
        throw e;
      }
      return {
        result: null,
        canceled: true,
      };
    }
  }

  /**
   * Wraps a browser `File` (for example from an `<input type="file">` or a drop event) in a `File`
   * from this module. The returned file reads from the same data and keeps its `name`, `type`, and
   * `lastModified`. Its `uri` is a `blob:` URL, so `new File(file.uri)` returns a file with the same
   * data until you call `delete()`.
   *
   * > **Note:** The wrapped data stays in memory until you call `delete()`, because the module keeps a
   * > reference to it under the `blob:` URL.
   * @param webFile The browser `File` to wrap.
   * @platform web
   */
  static fromWebFile(webFile: globalThis.File): File {
    if (Platform.OS !== 'web') {
      throw new UnavailabilityError('expo-file-system', 'File.fromWebFile');
    }
    return super.fromWebFile(webFile) as File;
  }

  /**
   * Creates an instance of a file. It can be created for any path, and does not need to exist on the filesystem during creation.
   *
   * The constructor accepts an array of strings that are joined to create the file URI. The first argument can also be a `Directory` instance (like `Paths.cache`) or a `File` instance (which creates a new reference to the same file).
   * @param uris An array of: `file:///` string URIs, `File` instances, and `Directory` instances representing an arbitrary location on the file system. On web, `blob:`, `data:`, and `http(s):` URIs are accepted as well. Extra path segments appended to a `blob:` or `data:` URI are dropped, because those URLs have no path to join.
   * @example
   * ```ts
   * const file = new File(Paths.cache, "subdirName", "file.txt");
   * ```
   */
  constructor(...uris: (string | File | Directory)[]) {
    super(Paths.join(...uris));
    this.validatePath();
  }

  /**
   * Directory containing the file.
   *
   * > **Note:** On web, the `blob:` and `data:` URLs of a file have an opaque path, so
   * > `parentDirectory.uri` equals the `uri` of the file. For an `http:` or `https:` URL, it is the
   * > parent path of the URL. In both cases it does not point to a directory that holds the file.
   */
  get parentDirectory() {
    return new Directory(Paths.dirname(this.uri));
  }

  /**
   * File extension.
   * @example '.png'
   */
  get extension() {
    return extname(this.name);
  }

  /**
   * File name. Includes the extension.
   */
  get name() {
    // On web, `super.name` is the browser `File` name slot, which also holds the original name
    // of a picked or wrapped file. On native, there is no such getter and it is `undefined`.
    return super.name || Paths.basename(this.uri);
  }

  /**
   * Returns a browser `File` with the data, `name`, `type`, and `lastModified` of this file.
   * Use it when a browser API needs a plain `File` instance.
   *
   * Throws for a file that only has a URI, because its data is not loaded. Read the data first and
   * build the browser `File` from it:
   * `new globalThis.File([await file.bytes()], file.name, { type: file.type })`.
   * @platform web
   */
  toWebFile(): globalThis.File {
    if (Platform.OS !== 'web') {
      throw new UnavailabilityError('expo-file-system', 'File.toWebFile');
    }
    return super.toWebFile();
  }

  /**
   * Creates a `ReadableStream` that reads from this file using a `FileHandle` internally.
   *
   * The stream reads in 1024-byte chunks by default. The underlying file handle is
   * closed automatically when the stream is fully consumed or cancelled.
   *
   * > **Note:** On web, this is the same as `stream()`.
   *
   * @return A byte-oriented `ReadableStream` backed by this file.
   */
  readableStream() {
    if (Platform.OS === 'web') {
      return super.readableStream();
    }
    return new ReadableStream(new FileSystemReadableStreamSource(super.open(FileMode.ReadOnly)));
  }

  /**
   * Creates a `WritableStream` that writes to this file using a `FileHandle` internally.
   *
   * The underlying file handle is closed automatically when the stream is closed or aborted.
   *
   * @return A `WritableStream` that accepts `Uint8Array` chunks.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  writableStream() {
    if (Platform.OS === 'web') {
      return super.writableStream();
    }
    return new WritableStream<Uint8Array>(
      new FileSystemWritableSink(super.open(FileMode.WriteOnly))
    );
  }

  /**
   * Retrieves the content of the entire file as an `ArrayBuffer`.
   *
   * > **Note:** On web, a file that only has a URI is read with `fetch()`, so the promise rejects
   * > when the request fails.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (Platform.OS === 'web') {
      return super.arrayBuffer();
    }
    const bytes = await this.bytes();
    return bytes.buffer as ArrayBuffer;
  }

  /**
   * Retrieves the content of the entire file as text and parses it as JSON.
   *
   * > **Note:** On web, a file that only has a URI is read with `fetch()`, so the promise rejects
   * > when the request fails.
   */
  async json(): Promise<any> {
    return JSON.parse(await this.text());
  }

  /**
   * Parses the content of the entire file as `FormData`.
   *
   * > **Note:** On web, a file that only has a URI is read with `fetch()`, so the promise rejects
   * > when the request fails. The bytes are parsed with the `type` of the file as the `Content-Type`.
   */
  async formData(): ReturnType<Response['formData']> {
    return new Response(await this.arrayBuffer(), {
      headers: this.type ? { 'Content-Type': this.type } : undefined,
    }).formData();
  }

  /**
   * Returns a `ReadableStream` for this file. This is an alias for `readableStream()`
   * and implements the `Blob.stream()` interface.
   *
   * > **Note:** On web, the stream of a file that only has a URI starts a `fetch()` when it is first
   * > read, and errors when the request fails.
   *
   * @return A byte-oriented `ReadableStream` backed by this file.
   */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (Platform.OS === 'web') {
      return super.stream();
    }
    return this.readableStream();
  }

  /**
   * Returns a `Blob` with the bytes of this file from `start` up to, but not including, `end`.
   * Implements the `Blob.slice()` interface.
   *
   * The file is not read when the `Blob` is created. Its `size` is fixed when you call `slice()`,
   * and the bytes are read from the file every time you read the `Blob`, so a read sees the
   * current content of the file. If the file got shorter in the meantime, the read returns fewer
   * bytes than `size`, and if the file was deleted, the read rejects. Throws if the file does not
   * exist or cannot be read, and if the slice is larger than 2147483647 bytes (2 GiB). You can
   * pass the returned `Blob` to `new Blob([...])`, `FormData`, and `fetch()` like any other `Blob`.
   * Pass a `File` to `new Blob([file])` to get a `Blob` of the whole file in the same way.
   *
   * > **Note:** On iOS, files outside of the app sandbox that need security-scoped access are not
   * > supported.
   *
   * > **Note:** On web, `slice()` returns a browser `Blob` with a copy of the bytes, and throws for
   * > a file that only has a URI, because its data is not loaded. Read the data with `bytes()` first.
   *
   * @param start The index of the first byte to include.
   * @param end The index of the first byte to exclude.
   * @param contentType The `type` of the returned `Blob`. Defaults to an empty string. The `type` of
   * the file is not inherited.
   */
  slice(start?: number, end?: number, contentType?: string): Blob {
    if (Platform.OS === 'web') {
      return super.slice(start, end, contentType);
    }
    const fileSize = this.readableSize();
    // Same as the native `Blob.slice()`: `NaN` becomes 0 and fractions are truncated.
    const toIndex = (n: number | undefined) =>
      n == null ? undefined : Number.isNaN(n) ? 0 : Math.trunc(n);
    const from = toIndex(start);
    const to = toIndex(end);
    const relStart =
      from == null ? 0 : from < 0 ? Math.max(fileSize + from, 0) : Math.min(from, fileSize);
    const relEnd =
      to == null ? fileSize : to < 0 ? Math.max(fileSize + to, 0) : Math.min(to, fileSize);
    const reference = { uri: this.uri, offset: relStart, size: Math.max(relEnd - relStart, 0) };
    return new ExpoBlob([fileRangePart(reference)], { type: contentType });
  }

  /**
   * Returns the byte range of the whole file, so that `new Blob([file])` reads the file on every
   * read of the `Blob` instead of copying it.
   * @hidden
   */
  [FILE_RANGE](): FileRangeReference {
    if (Platform.OS === 'web') {
      throw new UnavailabilityError('expo-file-system', 'File[Symbol.for("expo.blob.fileRange")]');
    }
    return { uri: this.uri, offset: 0, size: this.readableSize() };
  }

  /**
   * The size of the file, checked to be readable. `exists` goes through the read permission
   * check, which a `Blob` reading the file later does not do.
   */
  private readableSize(): number {
    if (!this.exists) {
      throw new Error(
        `Unable to read '${this.uri}': the file does not exist or the app has no read permission.`
      );
    }
    return this.size;
  }

  /**
   * Determines whether the platform can preview this file.
   *
   * On iOS, this checks whether Quick Look can preview the file. On Android, this checks whether
   * an installed app can handle the preview intent for the file's MIME type.
   * Invalid files and files the app cannot read reject instead of returning `false`. If the file
   * does not exist, the promise resolves to `false`.
   *
   * @param options Preview options.
   * @returns A promise that resolves to `true` if the file can be previewed, and `false` otherwise.
   * @platform android
   * @platform ios
   */
  canPreview(options?: FileCanPreviewOptions): Promise<boolean> {
    return super.canPreview(options ?? {});
  }

  /**
   * Opens this file with the platform's file preview flow.
   *
   * On iOS, this presents Quick Look. On Android, this starts an `ACTION_VIEW` intent.
   * The promise resolves once the preview has been presented or handed off to another app.
   * The promise rejects if the file does not exist or cannot be previewed.
   *
   * @param options Preview options.
   * @platform android
   * @platform ios
   */
  preview(options?: FilePreviewOptions): Promise<void> {
    return super.preview(options ?? {});
  }

  /**
   * Uploads this file to a server and starts the request immediately.
   *
   * The promise resolves with the HTTP response metadata and body for any completed response,
   * including non-2xx status codes. It is rejected only when the file cannot be read, the
   * request fails, or the upload is cancelled.
   *
   * > **Note:** On web, pass the file to `fetch()` as the request body or append it to a `FormData`
   * > instead.
   *
   * @param url The URL to upload the file to.
   * @param options Upload options.
   * @returns A promise that resolves to the upload result.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  upload(url: string, options?: UploadOptions): Promise<UploadResult> {
    return new UploadTask(this, url, options).uploadAsync();
  }

  /**
   * Creates an upload task for this file without starting it.
   *
   * Call `uploadAsync()` on the returned task to start the upload. Use this when you need to
   * inspect task state, cancel the upload, or subscribe to progress manually.
   *
   * > **Note:** On web, pass the file to `fetch()` as the request body or append it to a `FormData`
   * > instead.
   *
   * @param url The URL to upload the file to.
   * @param options Upload options.
   * @returns An upload task that can be started with `uploadAsync()`.
   *
   * @example
   * ```ts
   * const file = new File(Paths.document, 'photo.jpg');
   * const task = file.createUploadTask('https://example.com/upload', {
   *   uploadType: UploadType.MULTIPART,
   *   onProgress: ({ bytesSent, totalBytes }) => {
   *     console.log(`${bytesSent} / ${totalBytes}`);
   *   },
   * });
   *
   * const result = await task.uploadAsync();
   * ```
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  createUploadTask(url: string, options?: UploadOptions): UploadTask {
    return new UploadTask(this, url, options);
  }

  /**
   * Creates a download task without starting it.
   *
   * Call `downloadAsync()` on the returned task to start the download. Use this when you need
   * pause/resume support, task state, cancellation, or manual progress subscriptions.
   *
   * > **Note:** On web, use `File.downloadFileAsync()` instead.
   *
   * @param url The URL of the file to download.
   * @param destination The destination file or directory. If a directory is provided, the
   * resulting filename is determined from the response headers or URL.
   * @param options Download task options.
   * @returns A download task that can be started with `downloadAsync()`.
   *
   * @example
   * ```ts
   * const destination = new File(Paths.document, 'video.mp4');
   * const task = File.createDownloadTask('https://example.com/video.mp4', destination, {
   *   onProgress: ({ bytesWritten, totalBytes }) => {
   *     console.log(`${bytesWritten} / ${totalBytes}`);
   *   },
   * });
   *
   * const file = await task.downloadAsync();
   * ```
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  static createDownloadTask(
    url: string,
    destination: File | Directory,
    options?: DownloadTaskOptions
  ): DownloadTask {
    return new DownloadTask(url, destination, options);
  }

  /**
   * Watches this file for changes on the filesystem.
   *
   * The watcher automatically stops when the file is deleted or renamed. To stop watching manually,
   * call `remove()` on the returned subscription.
   *
   * @param callback Invoked when a change is detected. Receives a `WatchEvent` describing what changed.
   * @param options Configuration for debouncing and filtering events.
   * @return A subscription handle. Call `remove()` to stop watching.
   *
   * @example
   * ```ts
   * const file = new File(Paths.cache, 'data.json');
   * const subscription = file.watch((event) => {
   *   console.log(`File ${event.type}`);
   * });
   *
   * // Later, stop watching:
   * subscription.remove();
   * ```
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  watch(callback: (event: WatchEvent<File>) => void, options?: WatchOptions): WatchSubscription {
    return new FileSystemWatcher<File>(this.uri, callback, options, (uri) => new File(uri));
  }
}

function createAbortError(reason?: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

// Cannot use `static` keyword in class declaration because of a runtime error.
File.downloadFileAsync = async function downloadFileAsync(
  url: string,
  to: File | Directory,
  options?: DownloadOptions
) {
  const needsUuid = options?.onProgress || options?.signal;
  const downloadUuid = needsUuid ? uuid.v4() : undefined;

  let subscription: EventSubscription | undefined;
  let abortHandler: (() => void) | undefined;
  let lastProgress: DownloadProgress | undefined;

  try {
    if (options?.signal?.aborted) {
      throw createAbortError(options.signal.reason);
    }

    if (downloadUuid && options?.onProgress) {
      subscription = ExpoFileSystem.addListener('downloadProgress', (event) => {
        if (event.uuid === downloadUuid) {
          lastProgress = event.data;
          options.onProgress!(lastProgress);
        }
      });
    }

    if (downloadUuid && options?.signal) {
      abortHandler = () => {
        ExpoFileSystem.cancelDownloadAsync(downloadUuid);
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const outputURI = await ExpoFileSystem.downloadFileAsync(url, to, options, downloadUuid);
    const file = new File(outputURI);
    const fileSize = file.size ?? 0;
    if (
      options?.onProgress &&
      fileSize > 0 &&
      (lastProgress?.bytesWritten !== fileSize || lastProgress?.totalBytes !== fileSize)
    ) {
      options.onProgress({ bytesWritten: fileSize, totalBytes: fileSize });
    }
    return file;
  } catch (error: any) {
    if (options?.signal?.aborted) {
      throw createAbortError(options.signal.reason);
    }
    throw error;
  } finally {
    subscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
};

/**
 * Used to parse different APIs merged together.
 * @hidden
 */
function parsePickFileOptions(
  initialUriOrOptions?: string | PickFileOptions,
  mimeType?: string
): { options: PickFileOptions; usingOldAPI: boolean } {
  if (typeof initialUriOrOptions === 'object') {
    return { options: initialUriOrOptions, usingOldAPI: false };
  }
  return {
    options: {
      initialUri: initialUriOrOptions,
      mimeTypes: mimeType,
      multipleFiles: false,
    },
    usingOldAPI: mimeType !== undefined || typeof initialUriOrOptions === 'string',
  };
}

function normalizePreviewFiles(input: File | File[]): File[] {
  const files = Array.isArray(input) ? [...input] : [input];
  if (files.length === 0) {
    throw new RangeError('At least one file is required for a preview.');
  }
  for (const file of files) {
    if (!(file instanceof ExpoFileSystem.FileSystemFile)) {
      throw new TypeError('Preview input must contain File instances.');
    }
  }
  return files;
}

function validateCollectionPreviewOptions(files: File[], options?: FilePreviewOptions): void {
  if (files.length > 1 && (options?.title !== undefined || options?.mimeType !== undefined)) {
    throw new TypeError('title and mimeType are only supported for single-file previews.');
  }
}
