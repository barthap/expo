import { UnavailabilityError } from 'expo-modules-core';

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
    `The file at "${uri}" only has a URI and its data is not loaded. Use \`File.fromWebFile()\` with a browser \`File\`, or \`fetch()\` the URI directly.`
  );
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

  static fromWebFile(webFile: globalThis.File): FileSystemFile {
    return new this(registerBlob(webFile, webFile.name));
  }

  constructor(uri: string) {
    super(...superArgsFor(uri));
    this.#uri = uri;
    this.#isSnapshot = blobRegistry.has(uri);
  }

  get uri(): string {
    return this.#uri;
  }

  validatePath(): void {}

  get exists(): boolean {
    return blobRegistry.has(this.#uri) || this.#uri.startsWith('data:');
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

  text(): Promise<string> {
    if (!this.#isSnapshot) {
      return Promise.reject(uriBackedError('text', this.#uri));
    }
    return super.text();
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.#isSnapshot) {
      throw uriBackedError('bytes', this.#uri);
    }
    // `Blob.prototype.bytes` is missing in older browsers.
    if (typeof super.bytes === 'function') {
      return super.bytes();
    }
    return new Uint8Array(await super.arrayBuffer());
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.#isSnapshot) {
      return Promise.reject(uriBackedError('arrayBuffer', this.#uri));
    }
    return super.arrayBuffer();
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (!this.#isSnapshot) {
      throw uriBackedError('stream', this.#uri);
    }
    return super.stream();
  }

  readableStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (!this.#isSnapshot) {
      throw uriBackedError('readableStream', this.#uri);
    }
    return super.stream();
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
    this.#uri = uri;
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

export default {
  FileSystemDirectory,
  FileSystemFile,
  FileSystemUploadTask,
  FileSystemDownloadTask,
  downloadFileAsync: () => {
    return Promise.reject(
      unavailable(
        'File.downloadFileAsync',
        'Use `fetch()` and wrap the result with `File.fromWebFile()`.'
      )
    );
  },
  cancelDownloadAsync: () => {},
  addListener: () => ({ remove() {} }),
  pickDirectoryAsync: () => {
    return Promise.reject(
      unavailable('Directory.pickDirectoryAsync', 'Browsers do not give access to directories.')
    );
  },
  pickFileAsync: () => {
    return Promise.reject(
      unavailable('File.pickFileAsync', 'Use an `<input type="file">` and `File.fromWebFile()`.')
    );
  },
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
