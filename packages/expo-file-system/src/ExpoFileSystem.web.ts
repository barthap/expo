import { CodedError, UnavailabilityError } from 'expo-modules-core';

import type { DirectoryCreateOptions } from './Directory.types';
import type {
  FileCreateOptions,
  FileWriteOptions,
  InfoOptions,
  PickFileOptions,
} from './File.types';
import type { DownloadOptions } from './NetworkTasks.types';
import { toFileSystemError } from './internal/opfsErrors';
import { getOpfsIndex, opfsKeyOf, type OpfsIndex } from './internal/opfsIndex';
import { normalizeFileUri, opfsPathOf } from './internal/opfsPaths';
import { OPFS_UNAVAILABLE_MESSAGE } from './internal/opfsSupport';
import { PathUtilities } from './pathUtilities';

// Files and directories under `Paths.cache` and `Paths.document` are OPFS-backed: they are stored
// in the origin private file system, and an in-memory index answers the sync readers (see
// `internal/opfsIndex.ts`). Every other file is either snapshot-backed (it holds the data of a
// browser `File` or `Blob`) or uri-backed (it only knows a `uri`). Snapshots are kept in this
// registry under a `blob:` URL, so `new File(file.uri)` finds the same data again.
type RegistryEntry = { blob: Blob; name: string };
const blobRegistry = new Map<string, RegistryEntry>();

// `Paths.cache` and `Paths.document` are the OPFS roots. `Paths.bundle` is a placeholder that
// exists and holds nothing.
const cacheDirectory = 'file:///cache/';
const documentDirectory = 'file:///document/';
const bundleDirectory = 'file:///bundle/';
const virtualRoots = [cacheDirectory, documentDirectory, bundleDirectory].map(stripTrailingSlash);

const NOT_STORED = 'Only files in `Paths.cache` and `Paths.document` can be written on web.';
const USE_BROWSER_APIS =
  'Read the file with `text()`, `bytes()`, `arrayBuffer()`, or `stream()`, or pass it directly to `fetch()` or `FormData`.';
const NOT_IMPLEMENTED = 'expo-file-system does not implement it on web.';

function unavailable(member: string, reason: string): UnavailabilityError {
  const error = new UnavailabilityError('expo-file-system', member);
  error.message = `${member} is not available on web. ${reason}`;
  return error;
}

function stripTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

function unsupportedFileMember(member: string): UnavailabilityError {
  return unavailable(`File.${member}`, `${NOT_STORED} ${USE_BROWSER_APIS}`);
}

function unsupportedDirectoryMember(member: string): UnavailabilityError {
  return unavailable(
    `Directory.${member}`,
    'Only `Paths.cache`, `Paths.document`, and the directories in them are stored on web. Other directories are only paths.'
  );
}

// A sync member of an OPFS-backed file or directory. OPFS on the main thread is only asynchronous,
// so it points at the async member that does the same.
function syncOnWeb(member: string, instead: string): UnavailabilityError {
  return unavailable(
    member,
    `Browser storage is asynchronous, so it has no synchronous form. Use \`${instead}\` instead.`
  );
}

function uriBackedError(member: string, uri: string): UnavailabilityError {
  return unavailable(
    `File.${member}`,
    `The file at "${uri}" only has a URI, so its data is read with \`fetch()\` and is not available synchronously. Read it first and build a browser \`File\`: \`new globalThis.File([await file.bytes()], file.name, { type: file.type })\`.`
  );
}

// `slice()` and `toWebFile()` return data synchronously, and an OPFS file is only read
// asynchronously. A `Blob` with the size from the index would still hold no bytes, and
// `new Blob([...])`, `FormData`, and `fetch()` read the bytes, not the size.
function opfsBackedError(member: string, uri: string): UnavailabilityError {
  return unavailable(
    `File.${member}`,
    `The file at "${uri}" is stored in the origin private file system, which is read asynchronously. Read it first and build a browser \`File\`: \`new globalThis.File([await file.bytes()], file.name, { type: file.type })\`.`
  );
}

// The `FileAlreadyExistsException` of iOS. Android says "Unable to create file or directory: it
// already exists" with `ERR_UNABLE_TO_CREATE`.
function alreadyExists(uri: string): CodedError {
  return new CodedError('ERR_FILE_ALREADY_EXISTS', `File '${uri}' already exists`);
}

// The `UnableToDeleteException` of both native platforms, with the Android reason.
function nothingToDelete(uri: string): CodedError {
  return new CodedError(
    'ERR_UNABLE_TO_DELETE',
    `Unable to delete file or directory: uri '${uri}' does not exist`
  );
}

// The `DestinationAlreadyExistsException` of iOS, for `copy()`, `move()`, and downloads.
function destinationExists(uri: string): CodedError {
  return new CodedError('ERR_DESTINATION_ALREADY_EXISTS', `Destination already exists: '${uri}'`);
}

// The error OPFS throws for an entry of the other kind, mapped like an OPFS call that hit it.
function wrongKind(uri: string, operation: string, expected: 'file' | 'directory'): unknown {
  return toFileSystemError(new DOMException('The entry has the wrong kind.', 'TypeMismatchError'), {
    uri,
    operation,
    expected,
  });
}

function notFound(uri: string, operation: string, expected: 'file' | 'directory'): unknown {
  return toFileSystemError(new DOMException('The entry does not exist.', 'NotFoundError'), {
    uri,
    operation,
    expected,
  });
}

// The index after `ready()`. Every async member that touches OPFS waits for it, so the sync
// readers answer right after the awaited call, also when the app never called `Paths.ready()`.
async function readyIndex(): Promise<OpfsIndex> {
  const index = getOpfsIndex();
  await index.ready();
  return index;
}

function isOpfsUri(uri: string): boolean {
  return opfsPathOf(uri) !== null;
}

// Whether two OPFS URIs name the same entry, whatever their percent-encoding.
function isSameOpfsEntry(a: string, b: string): boolean {
  const pathA = opfsPathOf(a);
  const pathB = opfsPathOf(b);
  return !!pathA && !!pathB && opfsKeyOf(pathA) === opfsKeyOf(pathB);
}

// The uri of the child `name` of the directory at `directoryUri`, spelled like the constructors
// spell it, so `new File(directory, name).uri` gives the same string.
function childUri(directoryUri: string, name: string, kind: 'file' | 'directory'): string {
  return normalizeFileUri(PathUtilities.join(directoryUri, name), kind);
}

// Like Android `validateFileSystemChildName`: a child name is one entry name, so it cannot reach
// another directory.
function checkChildName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new CodedError(
      'ERR_UNABLE_TO_CREATE',
      `Unable to create file or directory: "${name}" is not a valid name`
    );
  }
}

// `FileWriteOptions.encoding: 'base64'` means the string holds base64 data, like on native.
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
  // `move()` changes these: the file then lives at the destination, in OPFS.
  #uri: string;
  #isSnapshot: boolean;
  #isOpfs: boolean;
  // The MIME type of the last successful read of a uri-backed `http(s):` or foreign `blob:` file,
  // or of an OPFS file.
  #fetchedType: string | null = null;

  static fromWebFile(webFile: globalThis.File): FileSystemFile {
    return new this(registerBlob(webFile, webFile.name));
  }

  // Like native, a `file:` uri is cleaned up here and `validatePath()` has nothing left to do. An
  // invalid path under `Paths.cache` or `Paths.document` throws `ERR_INVALID_PATH` here.
  constructor(uri: string) {
    const normalizedUri = normalizeFileUri(uri, 'file');
    super(...superArgsFor(normalizedUri));
    this.#uri = normalizedUri;
    this.#isSnapshot = blobRegistry.has(normalizedUri);
    this.#isOpfs = isOpfsUri(normalizedUri);
  }

  get uri(): string {
    return this.#uri;
  }

  // The browser `File` name slot is fixed at construction. Only a snapshot keeps that name (the
  // original name of a picked or wrapped file); any other file is named by its uri, so a moved
  // file gets the name of its destination.
  get name(): string {
    return this.#isSnapshot ? super.name : PathUtilities.basename(this.#uri);
  }

  validatePath(): void {}

  // Like native, `false` when a directory is at this path.
  get exists(): boolean {
    if (this.#isOpfs) {
      return getOpfsIndex().entry(this.#uri)?.kind === 'file';
    }
    return blobRegistry.has(this.#uri) || hasScheme(this.#uri, 'data');
  }

  // A snapshot keeps the type of its data. A `data:` uri names its MIME type. Other files learn it
  // from the last successful read.
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

  // Reads the current data of an OPFS file. A failed read may mean that the index is stale (the
  // file was removed in another tab), so the index reads the path again.
  async #readOpfs(): Promise<globalThis.File> {
    const index = await readyIndex();
    try {
      const file = await index.store.readFile(this.#uri);
      this.#fetchedType = normalizeType(file.type);
      return file;
    } catch (error) {
      await index.refresh(this.#uri).catch(() => {});
      throw error;
    }
  }

  // The OPFS entry of this file, when it is a file.
  #opfsEntry() {
    const entry = getOpfsIndex().entry(this.#uri);
    return entry?.kind === 'file' ? entry : null;
  }

  // A uri-backed file has empty internal data, so it throws instead of reporting size 0. An OPFS
  // file that does not exist has size 0, like native.
  get size(): number {
    if (this.#isOpfs) {
      return this.#opfsEntry()?.size ?? 0;
    }
    if (!this.#isSnapshot) {
      throw uriBackedError('size', this.#uri);
    }
    return super.size;
  }

  // @ts-expect-error: the browser `File` declares `lastModified` as a number, but a uri-backed
  // file does not know it and returns `null` like a missing native file.
  get lastModified(): number | null {
    if (this.#isOpfs) {
      return this.#opfsEntry()?.lastModified ?? null;
    }
    return this.#isSnapshot ? super.lastModified : null;
  }

  async text(): Promise<string> {
    if (this.#isOpfs) {
      return (await this.#readOpfs()).text();
    }
    if (!this.#isSnapshot) {
      return (await this.#fetch()).text();
    }
    return super.text();
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#isOpfs) {
      return new Uint8Array(await (await this.#readOpfs()).arrayBuffer());
    }
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
    if (this.#isOpfs) {
      return (await this.#readOpfs()).arrayBuffer();
    }
    if (!this.#isSnapshot) {
      return (await this.#fetch()).arrayBuffer();
    }
    return super.arrayBuffer();
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    if (this.#isOpfs) {
      return this.#lazyStream(
        async () => (await this.#readOpfs()).stream() as ReadableStream<Uint8Array<ArrayBuffer>>
      );
    }
    if (!this.#isSnapshot) {
      return this.#lazyStream(async (signal) => (await this.#fetch(signal)).body);
    }
    return super.stream();
  }

  readableStream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.stream();
  }

  // `stream()` is synchronous, so the stream opens its source (a fetch or an OPFS read) when it is
  // first read. A high-water mark of 0 stops the stream from pulling (and opening) before anyone
  // reads from it. Cancelling before the source is open aborts `signal`; after that it cancels the
  // source.
  #lazyStream(
    open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array<ArrayBuffer>> | null>
  ): ReadableStream<Uint8Array<ArrayBuffer>> {
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull: async (controller) => {
          if (!reader) {
            const body = await open(abort.signal);
            if (!body) {
              controller.close();
              return;
            }
            reader = body.getReader();
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
    if (this.#isOpfs) {
      throw opfsBackedError('slice', this.#uri);
    }
    if (!this.#isSnapshot) {
      throw uriBackedError('slice', this.#uri);
    }
    return super.slice(start, end, contentType);
  }

  toWebFile(): globalThis.File {
    if (this.#isOpfs) {
      throw opfsBackedError('toWebFile', this.#uri);
    }
    if (!this.#isSnapshot) {
      throw uriBackedError('toWebFile', this.#uri);
    }
    return new globalThis.File([this], this.name, {
      type: this.type,
      lastModified: super.lastModified,
    });
  }

  delete(): void {
    if (this.#isOpfs) {
      throw syncOnWeb('File.delete', 'await file.deleteAsync()');
    }
    if (blobRegistry.delete(this.#uri)) {
      URL.revokeObjectURL(this.#uri);
    }
  }

  async deleteAsync(): Promise<void> {
    if (!this.#isOpfs) {
      this.delete();
      return;
    }
    const index = await readyIndex();
    if (!index.entry(this.#uri)) {
      throw nothingToDelete(this.#uri);
    }
    await index.removeFile(this.#uri);
  }

  // Like native `create()`: an existing file is an error unless `overwrite` is set, and a directory
  // at this path is always one (Android). `FileCreateOptions` has no `idempotent`.
  async createAsync(options: FileCreateOptions = {}): Promise<void> {
    if (!this.#isOpfs) {
      throw unsupportedFileMember('createAsync');
    }
    const index = await readyIndex();
    const entry = index.entry(this.#uri);
    if (entry?.kind === 'directory') {
      throw wrongKind(this.#uri, 'create', 'file');
    }
    if (entry && !options.overwrite) {
      throw alreadyExists(this.#uri);
    }
    if (options.intermediates) {
      await index.createDirectory(PathUtilities.dirname(this.#uri), { intermediates: true });
    }
    await index.writeFile(this.#uri, '');
  }

  // Like native, the file is created when it is missing, and its parent directory must exist.
  async write(
    content: string | Uint8Array | ArrayBuffer,
    options: FileWriteOptions = {}
  ): Promise<void> {
    if (!this.#isOpfs) {
      throw unsupportedFileMember('write');
    }
    const index = await readyIndex();
    const data =
      options.encoding === 'base64' && typeof content === 'string'
        ? base64ToBytes(content)
        : content;
    await index.writeFile(this.#uri, data as string | BufferSource, { append: !!options.append });
  }

  // The data to copy: the snapshot, the current OPFS data, or the fetched data of a uri.
  async #data(): Promise<Blob> {
    if (this.#isOpfs) {
      return this.#readOpfs();
    }
    if (this.#isSnapshot) {
      // `this.slice()`, because Babel compiles a `super` getter read in this async private method
      // as a read on the prototype, which the `Blob` getters reject. `super.slice()` would work.
      return this.slice();
    }
    return (await this.#fetch()).blob();
  }

  // The OPFS uri that `copy()` or `move()` writes to, checked like native: a directory destination
  // must exist and gets a file with the name of this one; an existing file is replaced only with
  // `overwrite`.
  #destinationUri(
    index: OpfsIndex,
    destination: FileSystemFile | FileSystemDirectory,
    overwrite: boolean,
    operation: string
  ): string {
    let uri = destination.uri;
    if (destination instanceof FileSystemDirectory) {
      if (index.entry(uri)?.kind !== 'directory') {
        throw notFound(uri, operation, 'directory');
      }
      uri = childUri(uri, this.name, 'file');
    }
    const entry = index.entry(uri);
    if (entry?.kind === 'directory') {
      throw wrongKind(uri, operation, 'file');
    }
    if (entry && !overwrite) {
      throw destinationExists(uri);
    }
    return uri;
  }

  // Copies the data of this file into OPFS. Only an OPFS destination can hold it.
  async copy(
    destination: FileSystemFile | FileSystemDirectory,
    options: { overwrite?: boolean } = {}
  ): Promise<void> {
    if (!destination || !isOpfsUri(destination.uri)) {
      throw unsupportedFileMember('copy');
    }
    const index = await readyIndex();
    const uri = this.#destinationUri(index, destination, !!options.overwrite, 'copy');
    if (this.#isOpfs && isSameOpfsEntry(uri, this.#uri)) {
      return;
    }
    await index.writeFile(uri, await this.#data());
  }

  // `copy()`, then removes the source: the OPFS file, or the snapshot under its `blob:` URL. A
  // uri-backed source cannot be removed. Afterwards this file is the OPFS file at the destination.
  async move(
    destination: FileSystemFile | FileSystemDirectory,
    options: { overwrite?: boolean } = {}
  ): Promise<void> {
    if (!destination || !isOpfsUri(destination.uri) || (!this.#isOpfs && !this.#isSnapshot)) {
      throw unsupportedFileMember('move');
    }
    const index = await readyIndex();
    const uri = this.#destinationUri(index, destination, !!options.overwrite, 'move');
    if (this.#isOpfs && isSameOpfsEntry(uri, this.#uri)) {
      return;
    }
    const data = await this.#data();
    // After the read, which is where an OPFS source learns its type.
    const type = this.type;
    await index.writeFile(uri, data);
    if (this.#isOpfs) {
      await index.removeFile(this.#uri);
    } else if (blobRegistry.delete(this.#uri)) {
      URL.revokeObjectURL(this.#uri);
    }
    this.#uri = uri;
    this.#isSnapshot = false;
    this.#isOpfs = true;
    this.#fetchedType = type;
  }

  info(options?: InfoOptions): {
    exists: boolean;
    uri: string;
    size?: number;
    modificationTime?: number;
  } {
    if (!this.#isOpfs) {
      throw unsupportedFileMember('info');
    }
    if (options?.md5) {
      throw unavailable('File.info({ md5: true })', NOT_IMPLEMENTED);
    }
    const entry = this.#opfsEntry();
    if (!entry) {
      return { exists: false, uri: this.#uri };
    }
    // OPFS has no creation time.
    return {
      exists: true,
      uri: this.#uri,
      size: entry.size,
      modificationTime: entry.lastModified,
    };
  }

  #syncMember(member: string, instead: string): UnavailabilityError {
    return this.#isOpfs ? syncOnWeb(`File.${member}`, instead) : unsupportedFileMember(member);
  }

  // A member that an OPFS file does not have either. The default message suggests passing the file
  // to `fetch()` or `FormData`, which would send no bytes for an OPFS file.
  #notImplemented(member: string): UnavailabilityError {
    return this.#isOpfs
      ? unavailable(`File.${member}`, NOT_IMPLEMENTED)
      : unsupportedFileMember(member);
  }

  writableStream(): never {
    throw this.#notImplemented('writableStream');
  }
  writeSync(): never {
    throw this.#syncMember('writeSync', 'await file.write()');
  }
  create(): never {
    throw this.#syncMember('create', 'await file.createAsync()');
  }
  copySync(): never {
    throw this.#syncMember('copySync', 'await file.copy()');
  }
  moveSync(): never {
    throw this.#syncMember('moveSync', 'await file.move()');
  }
  rename(): never {
    throw this.#syncMember('rename', 'await file.move(new File(file.parentDirectory, newName))');
  }
  open(): never {
    throw this.#notImplemented('open');
  }
  textSync(): never {
    throw this.#syncMember('textSync', 'await file.text()');
  }
  bytesSync(): never {
    throw this.#syncMember('bytesSync', 'await file.bytes()');
  }
  base64(): Promise<never> {
    return Promise.reject(this.#notImplemented('base64'));
  }
  base64Sync(): never {
    throw this.#notImplemented('base64Sync');
  }
  digest(): Promise<never> {
    return Promise.reject(this.#notImplemented('digest'));
  }
  get md5(): never {
    throw this.#notImplemented('md5');
  }
  get modificationTime(): never {
    throw this.#notImplemented('modificationTime');
  }
  get creationTime(): never {
    throw this.#notImplemented('creationTime');
  }
  get contentUri(): never {
    throw this.#notImplemented('contentUri');
  }
  canPreview(): Promise<never> {
    return Promise.reject(this.#notImplemented('canPreview'));
  }
  preview(): Promise<never> {
    return Promise.reject(this.#notImplemented('preview'));
  }
}

class FileSystemDirectory {
  readonly #uri: string;
  readonly #isOpfs: boolean;

  constructor(uri: string) {
    this.#uri = normalizeFileUri(uri, 'directory');
    this.#isOpfs = isOpfsUri(this.#uri);
  }

  get uri(): string {
    return this.#uri;
  }

  validatePath(): void {}

  // Like native, `false` when a file is at this path.
  get exists(): boolean {
    if (this.#isOpfs) {
      return getOpfsIndex().entry(this.#uri)?.kind === 'directory';
    }
    return virtualRoots.includes(stripTrailingSlash(this.#uri));
  }

  // The sum of the sizes of every file inside, like native. `null` when there is no directory,
  // like iOS.
  get size(): number | null {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('size');
    }
    const index = getOpfsIndex();
    return index.entry(this.#uri)?.kind === 'directory' ? index.subtreeSize(this.#uri) : null;
  }

  // The shared `Directory.list()` calls this. The child URIs are spelled like the constructors
  // spell them, so `new File(directory, name).uri` is the same string.
  listAsRecords(): { isDirectory: boolean; uri: string }[] {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('list');
    }
    const index = getOpfsIndex();
    const entry = index.entry(this.#uri);
    if (!entry) {
      throw notFound(this.#uri, 'list', 'directory');
    }
    if (entry.kind !== 'directory') {
      throw wrongKind(this.#uri, 'list', 'directory');
    }
    return (index.list(this.#uri) ?? []).map(({ name, kind }) => ({
      isDirectory: kind === 'directory',
      uri: childUri(this.#uri, name, kind),
    }));
  }

  info(): {
    exists: boolean;
    uri: string;
    size?: number;
    files?: string[];
  } {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('info');
    }
    const index = getOpfsIndex();
    if (index.entry(this.#uri)?.kind !== 'directory') {
      return { exists: false, uri: this.#uri };
    }
    // OPFS has no modification or creation time for a directory.
    return {
      exists: true,
      uri: this.#uri,
      size: index.subtreeSize(this.#uri),
      files: (index.list(this.#uri) ?? []).map(({ name }) => name),
    };
  }

  // Like native `create()`, with `overwrite` removing the existing directory and everything in it
  // first (D79; iOS never deletes, Android deletes only an empty directory). A root always exists
  // and belongs to the module, so `overwrite` keeps it and its content, like `idempotent`.
  async createAsync(options: DirectoryCreateOptions = {}): Promise<void> {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('createAsync');
    }
    const index = await readyIndex();
    const entry = index.entry(this.#uri);
    if (entry?.kind === 'file') {
      throw wrongKind(this.#uri, 'create', 'directory');
    }
    if (entry) {
      if (options.idempotent || (options.overwrite && opfsPathOf(this.#uri)!.length === 1)) {
        return;
      }
      if (!options.overwrite) {
        throw alreadyExists(this.#uri);
      }
      await index.removeDirectory(this.#uri, { recursive: true });
    }
    await index.createDirectory(this.#uri, { intermediates: !!options.intermediates });
  }

  // Like native `delete()`, it removes everything inside.
  async deleteAsync(): Promise<void> {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('deleteAsync');
    }
    const index = await readyIndex();
    if (!index.entry(this.#uri)) {
      throw nothingToDelete(this.#uri);
    }
    await index.removeDirectory(this.#uri, { recursive: true });
  }

  // Like native `createFile()`: `create()` without options on the child.
  async createFileAsync(name: string, _mimeType: string | null): Promise<FileSystemFile> {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('createFileAsync');
    }
    checkChildName(name);
    const file = new FileSystemFile(childUri(this.#uri, name, 'file'));
    await file.createAsync();
    return file;
  }

  // Like native `createDirectory()`: `create()` without options on the child.
  async createDirectoryAsync(name: string): Promise<FileSystemDirectory> {
    if (!this.#isOpfs) {
      throw unsupportedDirectoryMember('createDirectoryAsync');
    }
    checkChildName(name);
    const directory = new FileSystemDirectory(childUri(this.#uri, name, 'directory'));
    await directory.createAsync();
    return directory;
  }

  #syncMember(member: string, instead: string): UnavailabilityError {
    return this.#isOpfs
      ? syncOnWeb(`Directory.${member}`, instead)
      : unsupportedDirectoryMember(member);
  }

  delete(): never {
    throw this.#syncMember('delete', 'await directory.deleteAsync()');
  }
  create(): never {
    throw this.#syncMember('create', 'await directory.createAsync()');
  }
  createFile(): never {
    throw this.#syncMember('createFile', 'await directory.createFileAsync()');
  }
  createDirectory(): never {
    throw this.#syncMember('createDirectory', 'await directory.createDirectoryAsync()');
  }
  copy(): Promise<never> {
    return Promise.reject(this.#notImplemented('copy'));
  }
  copySync(): never {
    throw this.#notImplemented('copySync');
  }
  move(): Promise<never> {
    return Promise.reject(this.#notImplemented('move'));
  }
  moveSync(): never {
    throw this.#notImplemented('moveSync');
  }
  rename(): never {
    throw this.#notImplemented('rename');
  }

  // Copying, moving, and renaming directories is not implemented for OPFS directories either.
  #notImplemented(member: string): UnavailabilityError {
    return this.#isOpfs
      ? unavailable(`Directory.${member}`, NOT_IMPLEMENTED)
      : unsupportedDirectoryMember(member);
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

// Downloads `url` and returns the uri of the downloaded file. With a destination in `Paths.cache`
// or `Paths.document`, the response body is piped into an OPFS file: the destination `File`, or a
// file in the destination `Directory` named from the response. Like native, an existing file is
// an error unless `idempotent` is set, which overwrites it; a `File` destination is checked before
// the request. Without OPFS in the browser, such a destination rejects before the request. With
// any other destination, the file is downloaded into memory and the returned `blob:` uri holds
// it; a `File` destination then only gives the name, and `idempotent` is ignored, because nothing
// is overwritten. The shared
// `File.downloadFileAsync` sends one progress event from the downloaded size, and `signal` goes
// straight to `fetch`, so `addListener` and `cancelDownloadAsync` have nothing to do.
async function downloadFileAsync(
  url: string,
  destination: FileSystemFile | FileSystemDirectory,
  options?: DownloadOptions
): Promise<string> {
  const toOpfs = isOpfsUri(destination.uri);
  // Before the request, so that nothing is fetched for a write that cannot happen.
  if (toOpfs && !getOpfsIndex().isAvailable) {
    throw new CodedError('ERR_OPFS_UNAVAILABLE', OPFS_UNAVAILABLE_MESSAGE);
  }
  const index = toOpfs ? await readyIndex() : null;
  const checkDestination = (uri: string) => {
    if (index?.exists(uri) && !options?.idempotent) {
      throw destinationExists(uri);
    }
  };
  if (destination instanceof FileSystemFile) {
    checkDestination(destination.uri);
  }
  const response = await fetchUri(
    url,
    { headers: options?.headers, signal: options?.signal },
    `Failed to download "${url}"`
  );
  const responseName = () =>
    contentDispositionName(response.headers.get('content-disposition')) ??
    // `response.url` is the URL after redirects, so its name matches the file that was served.
    urlName(response.url || url) ??
    'download';
  // A body that is never piped stays open. Once `pipeTo` has started, the body is locked and
  // `pipeTo` cancels it on failure itself.
  const cancelBody = async () => {
    if (response.body && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
  };
  if (index) {
    let uri = destination.uri;
    try {
      if (destination instanceof FileSystemDirectory) {
        uri = childUri(destination.uri, responseName(), 'file');
        checkDestination(uri);
      }
      await index.writeFile(uri, response.body ?? '');
    } catch (error) {
      await cancelBody();
      throw error;
    }
    return uri;
  }
  const blob = await response.blob();
  const name =
    (destination instanceof FileSystemFile ? destination.name || null : null) ?? responseName();
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
  // `Paths.ready()`: fills the in-memory index of the OPFS storage behind `Paths.cache` and
  // `Paths.document`.
  ready: () => getOpfsIndex().ready(),
  info: (uri: string) => {
    const normalizedUri = normalizeFileUri(uri, 'directory');
    if (!isOpfsUri(normalizedUri)) {
      throw unavailable(
        'Paths.info',
        'Only paths in `Paths.cache` and `Paths.document` point to stored files or directories on web.'
      );
    }
    const entry = getOpfsIndex().entry(normalizedUri);
    return { exists: entry !== null, isDirectory: entry ? entry.kind === 'directory' : null };
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
