import type { SharedObject } from 'expo-modules-core';

import type { Directory as PublicDirectory } from '../Directory';
import type { DirectoryCreateOptions, DirectoryInfo } from '../Directory.types';
import type { File as PublicFile } from '../File';
import type {
  FileCreateOptions,
  FileCanPreviewOptions,
  FileHandle,
  FileDigestAlgorithm,
  FileInfo,
  FileMode,
  FilePreviewOptions,
  FileWriteOptions,
  InfoOptions,
  PickMultipleFilesOptions,
  PickMultipleFilesResult,
  PickSingleFileOptions,
  PickSingleFileResult,
  RelocationOptions,
} from '../File.types';
import type {
  WatchEvent,
  WatchEventType,
  WatchOptions,
  WatchSubscription,
} from '../FileSystemWatcher.types';
import type { DownloadTask, UploadTask } from '../NetworkTasks';
import type {
  DownloadOptions,
  DownloadProgress,
  DownloadTaskOptions,
  UploadOptions,
  UploadProgress,
  UploadResult,
} from '../NetworkTasks.types';
export declare class NativeFileSystemDirectory {
  /**
   * Creates an instance of a directory.
   * @param uris An array of: `file:///` string URIs, `File` instances, `Directory` instances representing an arbitrary location on the file system. The location does not need to exist, or it may already contain a file.
   * @example
   * ```ts
   * const directory = new Directory("file:///path/to/directory");
   * ```
   */
  constructor(...uris: (string | PublicFile | PublicDirectory)[]);

  /**
   * Represents the directory URI. The field is read-only, but it may change as a result of calling some methods such as `move`.
   */
  readonly uri: string;

  /**
   * Validates a directory path.
   * @hidden This method is not meant to be used directly. It is called by the JS constructor.
   */
  validatePath(): void;

  /**
   * Deletes a directory. Also deletes all files and directories inside the directory.
   *
   * @throws Error if the directory does not exist or cannot be deleted.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  delete(): void;

  /**
   * A boolean representing if a directory exists and can be accessed.
   *
   * > **Note:** On web, `Paths.bundle` exists and holds nothing, and a directory in `Paths.cache` or
   * > `Paths.document` exists when it is stored in the Origin Private File System. Call
   * > `await Paths.ready()` before you read it there.
   */
  exists: boolean;

  /**
   * Creates a directory that the current uri points to.
   *
   * @throws Error if the containing folder doesn't exist, the application has no read access to it or the directory (or a file with the same path) already exists (unless `idempotent` is `true`).
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  create(options?: DirectoryCreateOptions): void;

  createFile(name: string, mimeType: string | null): PublicFile;

  createDirectory(name: string): PublicDirectory;

  /**
   * @hidden The shared `Directory` documents it. On Android, iOS, and tvOS, it calls `create()`.
   */
  createAsync(options?: DirectoryCreateOptions): Promise<void>;

  /**
   * @hidden The shared `Directory` documents it. On Android, iOS, and tvOS, it calls `delete()`.
   */
  deleteAsync(): Promise<void>;

  /**
   * @hidden The shared `Directory` documents it. On Android, iOS, and tvOS, it calls `createFile()`.
   */
  createFileAsync(name: string, mimeType: string | null): Promise<PublicFile>;

  /**
   * @hidden The shared `Directory` documents it. On Android, iOS, and tvOS, it
   * calls `createDirectory()`.
   */
  createDirectoryAsync(name: string): Promise<PublicDirectory>;

  /**
   * Watches this directory for changes to its contents.
   */
  watch(
    callback: (event: WatchEvent<PublicFile | PublicDirectory>) => void,
    options?: WatchOptions
  ): WatchSubscription;

  /**
   * Copies a directory.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  copy(destination: PublicDirectory | PublicFile, options?: RelocationOptions): Promise<void>;

  /**
   * Copies a directory synchronously.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  copySync(destination: PublicDirectory | PublicFile, options?: RelocationOptions): void;

  /**
   * Moves a directory. Updates the `uri` property that now points to the new location.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  move(destination: PublicDirectory | PublicFile, options?: RelocationOptions): Promise<void>;

  /**
   * Moves a directory synchronously. Updates the `uri` property that now points to the new location.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  moveSync(destination: PublicDirectory | PublicFile, options?: RelocationOptions): void;

  /**
   * Renames a directory.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  rename(newName: string): void;

  /**
   * @hidden
   * Lists the contents of a directory. Should not be used directly, as it returns a list of paths.
   * This function is internal and will be removed in the future (when returning arrays of shared objects is supported).
   */
  listAsRecords(): { isDirectory: boolean; uri: string }[];

  /**
   * Lists the contents of a directory.
   */
  list(): (PublicDirectory | PublicFile)[];

  /**
   * Retrieves an object containing properties of a directory.
   *
   * > **Note:** On web, it works for a directory in `Paths.cache` or `Paths.document` after
   * > `await Paths.ready()`, and throws for any other directory. The result has no `creationTime`
   * > and no `modificationTime`, because the Origin Private File System does not store them for a
   * > directory.
   *
   * @throws Error If the application does not have read access to the directory, or if the path does not point to a directory (e.g., it points to a file).
   * @returns An object with directory metadata (for example, size, creation date, and so on).
   */
  info(): DirectoryInfo;

  /**
   * A size of the directory in bytes. Null if the directory does not exist, or it cannot be read.
   *
   * > **Note:** On web, for a directory in `Paths.cache` or `Paths.document`, it is the sum of the
   * > sizes of the files inside it. Reading it throws an `ERR_NOT_INITIALIZED` error until
   * > `await Paths.ready()` resolves. It throws for any other directory.
   */
  size: number | null;

  /**
   * A static method that opens a file picker to select a directory.
   *
   * On iOS, the selected directory grants temporary read and write access for the current app session only. After the app restarts, you must prompt the user again to regain access.
   *
   * @param initialUri An optional uri pointing to an initial folder on which the directory picker is opened.
   * @returns a `Directory` instance. On Android, the underlying uri will be a content URI.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  static pickDirectoryAsync(initialUri?: string): Promise<PublicDirectory>;
}

export declare class NativeFileSystemFile {
  /**
   * Creates an instance of File.
   *
   * @param uris A `file:///` URI representing an arbitrary location on the file system. The location does not need to exist, or it may already contain a directory.
   */
  constructor(...uris: (string | PublicFile | PublicDirectory)[]);

  /**
   * Represents the file URI. The field is read-only, but it may change as a result of calling some methods such as `move`.
   */
  get uri(): string;

  /**
   * @hidden This method is not meant to be used directly. It is called by the JS constructor.
   * Validates a directory path.
   */
  validatePath(): void;

  /**
   * Retrieves text from the file.
   *
   * > **Note:** On web, a file in `Paths.cache` or `Paths.document` is read from the Origin Private
   * > File System on every call. A file that only has a URI is read with `fetch()`, so the promise
   * > rejects when the request fails.
   * @returns A promise that resolves to the contents of the file as string.
   */
  text(): Promise<string>;

  /**
   * Retrieves text from the file.
   * @returns The contents of the file as string.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  textSync(): string;

  /**
   * Retrieves content of the file as base64.
   * @returns A promise that resolves to the contents of the file as a base64 string.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  base64(): Promise<string>;

  /**
   * Retrieves content of the file as base64.
   * @returns The contents of the file as a base64 string.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  base64Sync(): string;

  /**
   * Retrieves byte content of the entire file.
   *
   * > **Note:** On web, a file in `Paths.cache` or `Paths.document` is read from the Origin Private
   * > File System on every call. A file that only has a URI is read with `fetch()`, so the promise
   * > rejects when the request fails.
   * @returns A promise that resolves to the contents of the file as a `Uint8Array`.
   */
  bytes(): Promise<Uint8Array<ArrayBuffer>>;

  /**
   * Retrieves byte content of the entire file.
   * @returns The contents of the file as a `Uint8Array`.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  bytesSync(): Uint8Array;

  /**
   * Writes content to the file.
   *
   * > **Note:** On web, it writes a file in `Paths.cache` or `Paths.document` to the Origin Private
   * > File System and creates the file when it is missing. Its parent directory must exist. It
   * > rejects for any other file.
   * >
   * > A write rejects with `ERR_FILE_LOCKED` while another write to the same file is open (browsers
   * > that ignore the exclusive lock let the last write win instead), with `ERR_QUOTA_EXCEEDED` when
   * > the storage quota of the origin is used up (see `navigator.storage.estimate()`), and with
   * > `ERR_OPFS_UNAVAILABLE` when the browser has no OPFS, for example on a page that is not served
   * > over HTTPS or from `localhost`.
   * @param content The content to write into the file.
   */
  write(content: string | Uint8Array | ArrayBuffer, options?: FileWriteOptions): Promise<void>;

  /**
   * Writes content to the file.
   * @param content The content to write into the file.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  writeSync(content: string | Uint8Array | ArrayBuffer, options?: FileWriteOptions): void;

  /**
   * Deletes a file.
   *
   * > **Note:** On web, `delete()` throws for a file in `Paths.cache` or `Paths.document`: use
   * > `deleteAsync()`. For other files, it releases the data that the module holds for a file from
   * > `File.fromWebFile()`, `File.pickFileAsync()`, or `File.downloadFileAsync()`, and revokes its
   * > `blob:` URL. After that, `exists` is `false`, but the same instance can still read the data it
   * > already holds. For a file that only has a URI, `delete()` does nothing.
   *
   * @throws Error if the directory does not exist or cannot be deleted.
   */
  delete(): void;

  /**
   * Retrieves an object containing properties of a file.
   *
   * > **Note:** On web, it works for a file in `Paths.cache` or `Paths.document` after
   * > `await Paths.ready()`, and throws for any other file. The result has no `creationTime`,
   * > because the Origin Private File System does not store it, and `info({ md5: true })` throws.
   *
   * @throws Error If the application does not have read access to the file, or if the path does not point to a file (for example, it points to a directory).
   * @returns An object with file metadata (for example, size, creation date, and so on).
   */
  info(options?: InfoOptions): FileInfo;

  /**
   * Calculates the digest of the file's contents.
   * @param algorithm The digest algorithm to use.
   * @returns A promise that resolves to the lowercase hexadecimal digest.
   * @throws Error if the file does not exist or cannot be read.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  digest(algorithm: FileDigestAlgorithm): Promise<string>;

  /**
   * A boolean representing if a file exists. `true` if the file exists, `false` otherwise.
   * Also, `false` if the application does not have read access to the file.
   *
   * > **Note:** On web, a file in `Paths.cache` or `Paths.document` exists when it is stored in the
   * > Origin Private File System; call `await Paths.ready()` before you read it there. Any other
   * > file exists while the module holds its data (see `delete()`) and for `data:` URIs. It is
   * > `false` for other URIs, including `http:` and `https:` URLs, because checking them would need
   * > a request.
   */
  exists: boolean;

  /**
   * Creates a file.
   *
   * @throws Error if the containing folder doesn't exist, the application has no read access to it or the file (or directory with the same path) already exists.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  create(options?: FileCreateOptions): void;

  /**
   * @hidden The shared `File` documents it. On Android, iOS, and tvOS, it calls `create()`.
   */
  createAsync(options?: FileCreateOptions): Promise<void>;

  /**
   * @hidden The shared `File` documents it. On Android, iOS, and tvOS, it calls `delete()`.
   */
  deleteAsync(): Promise<void>;

  /**
   * Copies a file.
   *
   * > **Note:** On web, the destination must be in `Paths.cache` or `Paths.document`, and it is
   * > written to the Origin Private File System. The source can be a file stored there, a file
   * > that holds its data, or a file that only has a URI, which is read with `fetch()`. The write
   * > rejects like `write()` does.
   */
  copy(destination: PublicDirectory | PublicFile, options?: RelocationOptions): Promise<void>;

  /**
   * Copies a file synchronously.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  copySync(destination: PublicDirectory | PublicFile, options?: RelocationOptions): void;

  /**
   * Moves a file. Updates the `uri` property that now points to the new location.
   *
   * > **Note:** On web, the destination must be in `Paths.cache` or `Paths.document`. The file is
   * > copied there and the source is removed: a stored file is deleted, and a file that holds its
   * > data, such as one from `File.pickFileAsync()`, releases it and revokes its `blob:` URL. A file
   * > that only has a URI cannot be moved. After the move, `name` is the name of the destination.
   * > When the source held its data, only the browser `File` slots of the instance, which
   * > `FormData` and `fetch()` read, keep the old data and name.
   */
  move(destination: PublicDirectory | PublicFile, options?: RelocationOptions): Promise<void>;

  /**
   * Moves a file synchronously. Updates the `uri` property that now points to the new location.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  moveSync(destination: PublicDirectory | PublicFile, options?: RelocationOptions): void;

  /**
   * Renames a file.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  rename(newName: string): void;

  /**
   * Returns A `FileHandle` object that can be used to read and write data to the file.
   *
   * @param mode - The {@link FileMode} to use.
   * - On **Android**, SAF `content://` URIs do not support `ReadWrite` mode.
   * - **Defaults**:
   *   - For SAF `content://` URIs, the default is `FileMode.ReadOnly`.
   *   - For standard `file://` URIs, the default is `FileMode.ReadWrite`.
   *
   * @throws Error if the file does not exist or cannot be opened.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  open(mode?: FileMode): FileHandle;
  /**
   * Determines whether the platform can preview this file.
   */
  canPreview(options?: FileCanPreviewOptions): Promise<boolean>;
  /**
   * Opens this file with the platform's file preview flow.
   */
  preview(options?: FilePreviewOptions): Promise<void>;
  upload(url: string, options?: UploadOptions): Promise<UploadResult>;
  createUploadTask(url: string, options?: UploadOptions): UploadTask;
  watch(
    callback: (event: WatchEvent<PublicFile>) => void,
    options?: WatchOptions
  ): WatchSubscription;

  static downloadFileAsync(
    url: string,
    destination: PublicDirectory | PublicFile,
    options?: DownloadOptions
  ): Promise<PublicFile>;
  static pickFileAsync(options?: PickSingleFileOptions): Promise<PickSingleFileResult>;
  static pickFileAsync(options?: PickMultipleFilesOptions): Promise<PickMultipleFilesResult>;
  static pickFileAsync(initialUri?: string, mimeType?: string): Promise<PublicFile | PublicFile[]>;
  static createDownloadTask(
    url: string,
    destination: PublicDirectory | PublicFile,
    options?: DownloadTaskOptions
  ): DownloadTask;

  /**
   * A size of the file in bytes. 0 if the file does not exist, or it cannot be read.
   *
   * > **Note:** On web, for a file in `Paths.cache` or `Paths.document`, it is the size stored in
   * > the Origin Private File System, and reading it throws an `ERR_NOT_INITIALIZED` error until
   * > `await Paths.ready()` resolves. Reading `size` throws for a file that only has a URI, because
   * > its data is not loaded. Read the data with `bytes()` to get its length.
   */
  size: number;
  /**
   * A md5 hash of the file. Null if the file does not exist, or it cannot be read.
   * @deprecated Use `await file.digest('MD5')` instead.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  md5: string | null;
  /**
   * A last modification time of the file expressed in milliseconds since the epoch. Returns a `null` if the file does not exist, or if it cannot be read.
   * @deprecated In favor of `lastModified` to be more in line with web [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File)
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  modificationTime: number | null;
  /**
   * A last modification time of the file expressed in milliseconds since the epoch. Returns a `null` if the file does not exist, or if it cannot be read.
   *
   * > **Note:** On web, for a file in `Paths.cache` or `Paths.document`, it is the time stored in the
   * > Origin Private File System, and reading it throws an `ERR_NOT_INITIALIZED` error until
   * > `await Paths.ready()` resolves. It is `null` for a file that only has a URI.
   */
  lastModified: number | null;
  /**
   * A creation time of the file expressed in milliseconds since the epoch. Returns a `null` if the file does not exist, cannot be read or the Android version is earlier than API 26.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  creationTime: number | null;
  /**
   * A mime type of the file. An empty string if the file does not exist, or it cannot be read.
   *
   * > **Note:** On web, a file that holds its data has the type of that data, and a `data:` URI has
   * > the MIME type written in the URI. Other files that only have a URI have an empty string until
   * > they are read, and then the `Content-Type` of the last successful response, including
   * > parameters such as `charset`. A file in `Paths.cache` or `Paths.document` has an empty string
   * > until it is read, and then the type that the browser reports for the stored file.
   *
   * On Android, iOS, and tvOS, a file at a `file:` path reports a type from its extension without a
   * read.
   */
  type: string;
  /**
   * A content URI to the file that can be shared to external applications.
   * @platform android
   */
  contentUri: string;

  // The members below exist only on the web backend, which extends the browser `File`.
  // The shared `File` class reaches them through `super` behind a `Platform.OS === 'web'` check,
  // so native code never calls them.

  /**
   * @hidden The `File.name` slot on web. `undefined` on native.
   */
  get name(): string | undefined;
  /**
   * @hidden Web only.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * @hidden Web only.
   */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
  /**
   * @hidden Web only.
   */
  slice(start?: number, end?: number, contentType?: string): Blob;
  /**
   * @hidden Web only.
   */
  readableStream(): ReadableStream<Uint8Array<ArrayBuffer>>;
  /**
   * @hidden Web only.
   */
  writableStream(): WritableStream<Uint8Array>;
  /**
   * @hidden Web only.
   */
  toWebFile(): globalThis.File;
  /**
   * @hidden Web only.
   */
  static fromWebFile(webFile: globalThis.File): NativeFileSystemFile;
}

type UploadTaskEvents = {
  progress: (data: UploadProgress) => void;
};

type DownloadTaskEvents = {
  progress: (data: DownloadProgress) => void;
};

/**
 * @hidden
 */
export declare class FileSystemUploadTask extends SharedObject<UploadTaskEvents> {
  /**
   * @hidden
   */
  start(url: string, file: PublicFile, options: Record<string, any>): Promise<UploadResult>;
  /**
   * @hidden
   */
  cancel(): void;
}

/**
 * @hidden
 */
export declare class FileSystemDownloadTask extends SharedObject<DownloadTaskEvents> {
  /**
   * @hidden
   */
  start(
    url: string,
    to: PublicFile | PublicDirectory,
    options?: Record<string, any>
  ): Promise<string | null>;
  /**
   * @hidden
   */
  pause(): any;
  /**
   * @hidden
   */
  resume(
    url: string,
    to: PublicFile | PublicDirectory,
    resumeData: string,
    options?: Record<string, any>
  ): Promise<string | null>;
  /**
   * @hidden
   */
  acknowledgeBackgroundCompletionAsync(): Promise<void>;
  /**
   * @hidden
   */
  cancel(): void;
}

export type NativeFileSystemWatcherEvent = {
  type: WatchEventType;
  path: string;
  isDirectory: boolean;
  nativeEventFlags?: number;
  newPath?: string;
  newPathIsDirectory?: boolean;
};

type FileSystemWatcherEvents = {
  change: (event: NativeFileSystemWatcherEvent) => void;
};

/**
 * @hidden
 */
export declare class NativeFileSystemWatcher extends SharedObject<FileSystemWatcherEvents> {
  constructor(path: string, options?: WatchOptions);
  start(): void;
  stop(): void;
}
