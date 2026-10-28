import { CodedError, UnavailabilityError } from 'expo-modules-core';

import type { PickFileOptions } from './File.types';
import type { DownloadOptions } from './NetworkTasks.types';
import { getOpfsIndex } from './internal/opfsIndex';
import { normalizeFileUri } from './internal/opfsPaths';
import { PathUtilities } from './pathUtilities';

// Web has no file system to write to. Files are either snapshot-backed (they hold the data of
// a browser `File` or `Blob`) or uri-backed (they only know a `uri`). Snapshots are kept in this
// registry under a `blob:` URL, so `new File(file.uri)` finds the same data again.
type RegistryEntry = { blob: Blob; name: string };
const blobRegistry = new Map<string, RegistryEntry>();

// Placeholder URIs for `Paths.cache`, `Paths.document`, and `Paths.bundle`. Nothing is stored
// under them yet.
const cacheDirectory = 'file:///cache/';
const documentDirectory = 'file:///document/';
const bundleDirectory = 'file:///bundle/';
const virtualRoots = [cacheDirectory, documentDirectory, bundleDirectory].map(stripTrailingSlash);

const NO_PERSISTENCE =
  'Files on web cannot be written, because expo-file-system has no persistent storage on web yet.';
const USE_BROWSER_APIS =
  'Read the file with `text()`, `bytes()`, `arrayBuffer()`, or `stream()`, or pass it directly to `fetch()` or `FormData`.';

function unavailable(member: string, reason: string): UnavailabilityError {
  const error = new UnavailabilityError('expo-file-system', member);
  error.message = `${member} is not available on web. ${reason}`;
  return error;
}

function stripTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

function unsupportedFileMember(member: string): UnavailabilityError {
  return unavailable(`File.${member}`, `${NO_PERSISTENCE} ${USE_BROWSER_APIS}`);
}

function unsupportedDirectoryMember(member: string): UnavailabilityError {
  return unavailable(
    `Directory.${member}`,
    'Directories on web are only paths, because expo-file-system has no persistent storage on web yet.'
  );
}

function uriBackedError(member: string, uri: string): UnavailabilityError {
  return unavailable(
    `File.${member}`,
    `The file at "${uri}" only has a URI, so its data is read with \`fetch()\` and is not available synchronously. Read it first and build a browser \`File\`: \`new globalThis.File([await file.bytes()], file.name, { type: file.type })\`.`
  );
}

// Scheme names are case-insensitive, so `DATA:,hi` is a `data:` uri too.
function hasScheme(uri: string, scheme: string): boolean {
  return uri.slice(0, scheme.length + 1).toLowerCase() === `${scheme}:`;
}

// Returns a MIME type the way `Blob.type` holds it, with its parameters, for example
// `text/plain;charset=utf-8`. Returns `''` when there is none.
function normalizeType(type: string | null): string {
  return (type ?? '').trim().toLowerCase();
}

// Returns the MIME type written in a `data:` uri, without the `;base64` marker, or `''` when the
// uri has none.
function dataUriType(uri: string): string {
  const commaIndex = uri.indexOf(',');
  const type = normalizeType(
    uri
      .slice('data:'.length, commaIndex === -1 ? undefined : commaIndex)
      .replace(/;\s*base64\s*$/i, '')
  );
  return type.startsWith(';') ? '' : type;
}

async function fetchUri(
  uri: string,
  init?: RequestInit,
  failure = `Failed to read the file at "${uri}"`
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(uri, init);
  } catch (error) {
    throw new Error(`${failure}: ${(error as Error)?.message ?? error}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${failure}: the server responded with status ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      { cause: response }
    );
  }
  return response;
}

function registerBlob(blob: Blob, name: string): string {
  const uri = URL.createObjectURL(blob);
  blobRegistry.set(uri, { blob, name });
  return uri;
}

function superArgsFor(uri: string): ConstructorParameters<typeof globalThis.File> {
  const entry = blobRegistry.get(uri);
  if (entry) {
    const { blob, name } = entry;
    const lastModified = blob instanceof globalThis.File ? blob.lastModified : undefined;
    return [[blob], name, { type: blob.type, lastModified }];
  }
  return [[], PathUtilities.basename(uri)];
}

class FileSystemFile extends globalThis.File {
  readonly #uri: string;
  readonly #isSnapshot: boolean;
  // The MIME type of the last successful read of a uri-backed `http(s):` or foreign `blob:` file.
  #fetchedType: string | null = null;

  static fromWebFile(webFile: globalThis.File): FileSystemFile {
    return new this(registerBlob(webFile, webFile.name));
  }

  // Like native, a `file:` uri is cleaned up here and `validatePath()` has nothing left to do.
  constructor(uri: string) {
    const normalizedUri = normalizeFileUri(uri, 'file');
    super(...superArgsFor(normalizedUri));
    this.#uri = normalizedUri;
    this.#isSnapshot = blobRegistry.has(normalizedUri);
  }

  get uri(): string {
    return this.#uri;
  }

  validatePath(): void {}

  get exists(): boolean {
    return blobRegistry.has(this.#uri) || hasScheme(this.#uri, 'data');
  }

  // A snapshot keeps the type of its data. A `data:` uri names its MIME type. Other uri-backed files
  // learn it from the `Content-Type` of the last successful read.
  get type(): string {
    if (this.#isSnapshot) {
      return super.type;
    }
    if (hasScheme(this.#uri, 'data')) {
      return dataUriType(this.#uri);
    }
    return this.#fetchedType ?? '';
  }

  async #fetch(signal?: AbortSignal): Promise<Response> {
    const response = await fetchUri(this.#uri, { signal });
    if (!hasScheme(this.#uri, 'data')) {
      this.#fetchedType = normalizeType(response.headers.get('content-type'));
    }
    return response;
  }

  // A uri-backed file has empty internal data, so it throws instead of reporting size 0.
  get size(): number {
    if (!this.#isSnapshot) {
      throw uriBackedError('size', this.#uri);
    }
    return super.size;
  }

  // @ts-expect-error: the browser `File` declares `lastModified` as a number, but a uri-backed
  // file does not know it and returns `null` like a missing native file.
  get lastModified(): number | null {
    return this.#isSnapshot ? super.lastModified : null;
  }

  async text(): Promise<string> {
    if (!this.#isSnapshot) {
      return (await this.#fetch()).text();
    }
    return super.text();
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.#isSnapshot) {
      return new Uint8Array(await (await this.#fetch()).arrayBuffer());
    }
    // `Blob.prototype.bytes` is missing in older browsers.
    if (typeof super.bytes === 'function') {
      return super.bytes();
    }
    return new Uint8Array(await super.arrayBuffer());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.#isSnapshot) {
      return (await this.#fetch()).arrayBuffer();
    }
    return super.arrayBuffer();
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (!this.#isSnapshot) {
      return this.#fetchStream();
    }
    return super.stream();
  }

  readableStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.stream();
  }

  // `stream()` is synchronous, so the stream starts the fetch when it is first read. A high-water
  // mark of 0 stops the stream from pulling (and fetching) before anyone reads from it. Cancelling
  // before the response arrives aborts the fetch; after that it cancels the response body.
  #fetchStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull: async (controller) => {
          if (!reader) {
            const { body } = await this.#fetch(abort.signal);
            if (!body) {
              controller.close();
              return;
            }
            reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        cancel: (reason) => (reader ? reader.cancel(reason) : abort.abort(reason)),
      },
      { highWaterMark: 0 }
    );
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    if (!this.#isSnapshot) {
      throw uriBackedError('slice', this.#uri);
    }
    return super.slice(start, end, contentType);
  }

  toWebFile(): globalThis.File {
    if (!this.#isSnapshot) {
      throw uriBackedError('toWebFile', this.#uri);
    }
    return new globalThis.File([this], this.name, {
      type: this.type,
      lastModified: super.lastModified,
    });
  }

  delete(): void {
    if (blobRegistry.delete(this.#uri)) {
      URL.revokeObjectURL(this.#uri);
    }
  }

  writableStream(): never {
    throw unsupportedFileMember('writableStream');
  }
  write(): Promise<never> {
    return Promise.reject(unsupportedFileMember('write'));
  }
  writeSync(): never {
    throw unsupportedFileMember('writeSync');
  }
  create(): never {
    throw unsupportedFileMember('create');
  }
  createAsync(): Promise<never> {
    return Promise.reject(unsupportedFileMember('createAsync'));
  }
  async deleteAsync(): Promise<void> {
    this.delete();
  }
  copy(): Promise<never> {
    return Promise.reject(unsupportedFileMember('copy'));
  }
  copySync(): never {
    throw unsupportedFileMember('copySync');
  }
  move(): Promise<never> {
    return Promise.reject(unsupportedFileMember('move'));
  }
  moveSync(): never {
    throw unsupportedFileMember('moveSync');
  }
  rename(): never {
    throw unsupportedFileMember('rename');
  }
  open(): never {
    throw unsupportedFileMember('open');
  }
  textSync(): never {
    throw unsupportedFileMember('textSync');
  }
  bytesSync(): never {
    throw unsupportedFileMember('bytesSync');
  }
  base64(): Promise<never> {
    return Promise.reject(unsupportedFileMember('base64'));
  }
  base64Sync(): never {
    throw unsupportedFileMember('base64Sync');
  }
  digest(): Promise<never> {
    return Promise.reject(unsupportedFileMember('digest'));
  }
  info(): never {
    throw unsupportedFileMember('info');
  }
  get md5(): never {
    throw unsupportedFileMember('md5');
  }
  get modificationTime(): never {
    throw unsupportedFileMember('modificationTime');
  }
  get creationTime(): never {
    throw unsupportedFileMember('creationTime');
  }
  get contentUri(): never {
    throw unsupportedFileMember('contentUri');
  }
  canPreview(): Promise<never> {
    return Promise.reject(unsupportedFileMember('canPreview'));
  }
  preview(): Promise<never> {
    return Promise.reject(unsupportedFileMember('preview'));
  }
}

class FileSystemDirectory {
  readonly #uri: string;

  constructor(uri: string) {
    this.#uri = normalizeFileUri(uri, 'directory');
  }

  get uri(): string {
    return this.#uri;
  }

  validatePath(): void {}

  get exists(): boolean {
    return virtualRoots.includes(stripTrailingSlash(this.#uri));
  }

  get size(): never {
    throw unsupportedDirectoryMember('size');
  }
  delete(): never {
    throw unsupportedDirectoryMember('delete');
  }
  create(): never {
    throw unsupportedDirectoryMember('create');
  }
  createAsync(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('createAsync'));
  }
  deleteAsync(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('deleteAsync'));
  }
  createFileAsync(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('createFileAsync'));
  }
  createDirectoryAsync(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('createDirectoryAsync'));
  }
  createFile(): never {
    throw unsupportedDirectoryMember('createFile');
  }
  createDirectory(): never {
    throw unsupportedDirectoryMember('createDirectory');
  }
  copy(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('copy'));
  }
  copySync(): never {
    throw unsupportedDirectoryMember('copySync');
  }
  move(): Promise<never> {
    return Promise.reject(unsupportedDirectoryMember('move'));
  }
  moveSync(): never {
    throw unsupportedDirectoryMember('moveSync');
  }
  rename(): never {
    throw unsupportedDirectoryMember('rename');
  }
  // The shared `Directory.list()` calls this.
  listAsRecords(): never {
    throw unsupportedDirectoryMember('list');
  }
  info(): never {
    throw unsupportedDirectoryMember('info');
  }
}

// The shared `UploadTask` and `DownloadTask` construct these, so `File.upload()`,
// `File.createUploadTask()`, and `File.createDownloadTask()` throw here.
class FileSystemUploadTask {
  constructor() {
    throw unavailable(
      'File.upload',
      'Uploads on web go through the browser. Pass the file to `fetch()` as the body or append it to a `FormData`.'
    );
  }
}

class FileSystemDownloadTask {
  constructor() {
    throw unavailable(
      'File.createDownloadTask',
      'Download tasks cannot be paused or resumed on web. Use `fetch()` and wrap the response with `File.fromWebFile()`.'
    );
  }
}

// How long to wait after the window gets focus back before a picker without a `change` counts as
// canceled. Only browsers without the `cancel` event on file inputs use it.
const PICKER_FOCUS_GRACE_MS = 1000;

// Whether a file dialog is open. Browsers show one dialog at a time.
let pickerInProgress = false;

// Returns the `accept` attribute for `mimeTypes`, or `null` when every type is allowed.
function acceptFor(mimeTypes: string | string[] | undefined): string | null {
  const types = (Array.isArray(mimeTypes) ? mimeTypes : [mimeTypes]).filter(
    (type): type is string => !!type
  );
  if (types.length === 0 || types.includes('*/*')) {
    return null;
  }
  return types.join(',');
}

// Opens the browser file dialog through a hidden `<input type="file">`. `initialUri` is ignored,
// because browsers do not let a page choose the folder the dialog opens in. A canceled dialog
// rejects, and the shared `File.pickFileAsync` turns that into `{ canceled: true }`.
function pickFileAsync(options: PickFileOptions = {}): Promise<FileSystemFile | FileSystemFile[]> {
  // Browsers ignore `click()` on a file input without a user gesture, and the promise would never
  // settle. Browsers without `navigator.userActivation` rely on the cancel handling below.
  if (navigator.userActivation?.isActive === false) {
    return Promise.reject(
      new CodedError(
        'ERR_USER_ACTIVATION',
        'File.pickFileAsync must be called from a user gesture, such as a click or key press handler, because browsers only open the file dialog in response to user input.'
      )
    );
  }
  // Like `PickingInProgressException` on iOS, the shared `File.pickFileAsync` turns this into
  // `{ canceled: true }`.
  if (pickerInProgress) {
    return Promise.reject(
      new CodedError('ERR_PICKER_IN_PROGRESS', 'Another file picker is already open.')
    );
  }
  pickerInProgress = true;
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    const accept = acceptFor(options.mimeTypes);
    if (accept) {
      input.accept = accept;
    }
    input.multiple = !!options.multipleFiles;

    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocus);
      clearTimeout(focusTimer);
      input.remove();
      pickerInProgress = false;
    };
    const onChange = () => {
      cleanup();
      const webFiles = Array.from(input.files ?? []);
      if (webFiles.length === 0) {
        reject(new CodedError('ERR_PICKER_CANCELED', 'The file picker was canceled.'));
        return;
      }
      let files: FileSystemFile[];
      try {
        files = webFiles.map((webFile) => FileSystemFile.fromWebFile(webFile));
      } catch (error) {
        reject(error);
        return;
      }
      resolve(options.multipleFiles ? files : files[0]!);
    };
    const onCancel = () => {
      cleanup();
      reject(new CodedError('ERR_PICKER_CANCELED', 'The file picker was canceled.'));
    };
    // The window gets focus back when the dialog closes. Without a `change` shortly after, the
    // dialog was canceled. `onChange` also handles a `change` that never fired but left files.
    const onFocus = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(onChange, PICKER_FOCUS_GRACE_MS);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    // Browsers that fire `cancel` on file inputs never need the focus fallback, which could
    // report a slow `change` (for example a large file) as a cancel.
    if (!('oncancel' in input)) {
      window.addEventListener('focus', onFocus);
    }
    document.body.appendChild(input);
    input.click();
  });
}

// Returns the file name from a `Content-Disposition` header, or `null` when it has none. Prefers
// the encoded `filename*=UTF-8''...` form over `filename=`, as RFC 6266 asks.
function contentDispositionName(header: string | null): string | null {
  if (!header) {
    return null;
  }
  // The `filename*=` charset is ignored (only UTF-8 is decoded), and decoding errors fall through.
  const encoded = /filename\*\s*=\s*([\w-]+)'[^']*'([^;\s]+)/i.exec(header);
  if (encoded) {
    try {
      return withoutPath(decodeURIComponent(encoded[2]!));
    } catch {
      // A malformed percent-encoding falls through to `filename=`.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header);
  if (plain) {
    return withoutPath(plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]!);
  }
  return null;
}

// Keeps only the last part of a name that contains a path, and returns `null` for an empty name.
function withoutPath(name: string): string | null {
  return name.trim().split(/[\\/]/).pop()!.trim() || null;
}

// Returns the last non-empty path segment of an `http(s):` URL. Other URLs have no file name in
// their path: `data:text/plain,hi` has the data and `blob:` URLs have a random id.
function urlName(url: string): string | null {
  if (!hasScheme(url, 'http') && !hasScheme(url, 'https')) {
    return null;
  }
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    return segment ? withoutPath(decodeURIComponent(segment)) : null;
  } catch {
    return null;
  }
}

// Downloads `url` into memory and returns the `blob:` uri of a snapshot-backed file. The location
// of `destination` is ignored, because there is nowhere to store the file yet: `Paths.cache` and
// `Paths.document` are placeholders until OPFS support. A `File` destination only gives the name.
// `idempotent` is ignored, because downloads never overwrite anything. The shared
// `File.downloadFileAsync` sends one progress event from the downloaded size, and `signal` goes
// straight to `fetch`, so `addListener` and `cancelDownloadAsync` have nothing to do.
async function downloadFileAsync(
  url: string,
  destination: FileSystemFile | FileSystemDirectory,
  options?: DownloadOptions
): Promise<string> {
  const response = await fetchUri(
    url,
    { headers: options?.headers, signal: options?.signal },
    `Failed to download "${url}"`
  );
  const blob = await response.blob();
  const name =
    (destination instanceof FileSystemFile ? destination.name || null : null) ??
    contentDispositionName(response.headers.get('content-disposition')) ??
    // `response.url` is the URL after redirects, so its name matches the file that was served.
    urlName(response.url || url) ??
    'download';
  return registerBlob(blob, name);
}

export default {
  FileSystemDirectory,
  FileSystemFile,
  FileSystemUploadTask,
  FileSystemDownloadTask,
  downloadFileAsync,
  cancelDownloadAsync: () => {},
  addListener: () => ({ remove() {} }),
  pickDirectoryAsync: () => {
    return Promise.reject(
      unavailable('Directory.pickDirectoryAsync', 'Browsers do not give access to directories.')
    );
  },
  pickFileAsync,
  // Fills the in-memory index of the OPFS storage. Nothing calls it yet, and `Paths.cache` and
  // `Paths.document` do not use the storage yet.
  ready: () => getOpfsIndex().ready(),
  info: () => {
    throw unavailable('Paths.info', 'Paths on web do not point to stored files or directories.');
  },
  get totalDiskSpace(): number {
    throw unavailable('Paths.totalDiskSpace', 'Browsers do not report disk space.');
  },
  get availableDiskSpace(): number {
    throw unavailable('Paths.availableDiskSpace', 'Browsers do not report disk space.');
  },
  documentDirectory,
  cacheDirectory,
  bundleDirectory,
  appleSharedContainers: {},
};
