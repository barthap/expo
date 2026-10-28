import { Platform } from 'react-native';

import type { DirectoryCreateOptions } from './Directory.types';
import ExpoFileSystem from './ExpoFileSystem';
import { File } from './File';
import type { WatchEvent, WatchOptions, WatchSubscription } from './FileSystemWatcher.types';
import { Paths } from './Paths';
import { FileSystemWatcher } from './internal/FileSystemWatcher';

/**
 * Represents a directory on the filesystem.
 *
 * A `Directory` instance can be created for any path, and does not need to exist on the filesystem during creation.
 *
 * The constructor accepts an array of strings that are joined to create the directory URI. The first argument can also be a `Directory` instance (like `Paths.cache`).
 * @example
 * ```ts
 * const directory = new Directory(Paths.cache, "subdirName");
 * ```
 */
export class Directory extends ExpoFileSystem.FileSystemDirectory {
  static pickDirectoryAsync: (initialUri?: string) => Promise<Directory>;

  /**
   * Creates an instance of a directory. It can be created for any path, and does not need to exist on the filesystem during creation.
   *
   * The constructor accepts an array of strings that are joined to create the directory URI. The first argument can also be a `Directory` instance (like `Paths.cache`).
   * @param uris An array of: `file:///` string URIs, `File` instances, and `Directory` instances representing an arbitrary location on the file system.
   * @example
   * ```ts
   * const directory = new Directory(Paths.cache, "subdirName");
   * ```
   */
  constructor(...uris: (string | File | Directory)[]) {
    super(Paths.join(...uris));
    this.validatePath();
  }

  /*
   * Directory containing the file.
   */
  get parentDirectory() {
    return new Directory(Paths.join(this.uri, '..'));
  }

  /**
   * Lists the contents of a directory.
   * Calling this method if the parent directory does not exist will throw an error.
   *
   * > **Note:** On web, it lists a directory in `Paths.cache` or `Paths.document` from the Origin
   * > Private File System, and throws an `ERR_NOT_INITIALIZED` error until `await Paths.ready()`
   * > resolves. It throws for any other directory.
   *
   * @returns An array of `Directory` and `File` instances.
   */
  override list(): (Directory | File)[] {
    return super
      .listAsRecords()
      .map(({ isDirectory, uri }) => (isDirectory ? new Directory(uri) : new File(uri)));
  }

  /**
   * Directory name.
   */
  get name() {
    return Paths.basename(this.uri);
  }

  /**
   * Creates a file with the given name in this directory.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  createFile(name: string, mimeType: string | null): File {
    return new File(super.createFile(name, mimeType).uri);
  }

  /**
   * Creates a directory with the given name in this directory.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  createDirectory(name: string): Directory {
    return new Directory(super.createDirectory(name).uri);
  }

  /**
   * Creates the directory, like `create()`, and returns a promise, so code that runs on every
   * platform can `await` it. On Android, iOS, and tvOS, it calls `create()` with the same options.
   *
   * > **Note:** On web, it creates the directory in the Origin Private File System for a directory
   * > in `Paths.cache` or `Paths.document`, and rejects for any other directory. With
   * > `overwrite: true`, an existing directory and everything in it is removed first, except for
   * > `Paths.cache` and `Paths.document` themselves, which always exist and keep their content.
   *
   * @param options Options for creating the directory.
   * @returns A promise that resolves when the directory is created, or rejects with the error
   * that `create()` throws.
   *
   * @example
   * ```ts
   * const directory = new Directory(Paths.document, 'albums', '2026');
   * await directory.createAsync({ intermediates: true, idempotent: true });
   * ```
   */
  async createAsync(options?: DirectoryCreateOptions): Promise<void> {
    if (Platform.OS === 'web') {
      return super.createAsync(options);
    }
    this.create(options);
  }

  /**
   * Deletes the directory and everything inside it, like `delete()`, and returns a promise, so
   * code that runs on every platform can `await` it. On Android, iOS, and tvOS, it calls
   * `delete()`.
   *
   * > **Note:** On web, it works for a directory in `Paths.cache` or `Paths.document`, and rejects
   * > for any other directory.
   *
   * @returns A promise that resolves when the directory is deleted, or rejects with the error that
   * `delete()` throws.
   */
  async deleteAsync(): Promise<void> {
    if (Platform.OS === 'web') {
      return super.deleteAsync();
    }
    this.delete();
  }

  /**
   * Creates a file with the given name in this directory, like `createFile()`, and returns a
   * promise, so code that runs on every platform can `await` it. On Android, iOS, and tvOS, it
   * calls `createFile()`.
   *
   * > **Note:** On web, it works for a directory in `Paths.cache` or `Paths.document`, like
   * > `createAsync()` on the new file, and rejects for any other directory.
   *
   * @param name The name of the file.
   * @param mimeType The MIME type of the file. Only Android uses it, for SAF `content://`
   * directories.
   * @returns A promise that resolves to the created file.
   */
  async createFileAsync(name: string, mimeType: string | null): Promise<File> {
    if (Platform.OS === 'web') {
      return new File((await super.createFileAsync(name, mimeType)).uri);
    }
    return this.createFile(name, mimeType);
  }

  /**
   * Creates a directory with the given name in this directory, like `createDirectory()`, and
   * returns a promise, so code that runs on every platform can `await` it. On Android, iOS, and
   * tvOS, it calls `createDirectory()`.
   *
   * > **Note:** On web, it works for a directory in `Paths.cache` or `Paths.document`, like
   * > `createAsync()` on the new directory, and rejects for any other directory.
   *
   * @param name The name of the directory.
   * @returns A promise that resolves to the created directory.
   */
  async createDirectoryAsync(name: string): Promise<Directory> {
    if (Platform.OS === 'web') {
      return new Directory((await super.createDirectoryAsync(name)).uri);
    }
    return this.createDirectory(name);
  }

  /**
   * Watches this directory for changes to its contents or the directory itself.
   *
   * Events are emitted when files or subdirectories are created, modified, deleted, or renamed
   * within this directory. On iOS, child changes are surfaced as a coarse-grained `modified` event
   * on the directory itself, so filtering for child-level `created`, `deleted`, or `renamed` events
   * is not reliable. The watcher automatically stops when the directory is deleted or renamed.
   * To stop watching manually, call `remove()` on the returned subscription.
   *
   * @param callback Invoked when a change is detected. Receives a `WatchEvent` describing what changed.
   * @param options Configuration for debouncing and filtering events.
   * @return A subscription handle. Call `remove()` to stop watching.
   *
   * @example
   * ```ts
   * const cacheDir = new Directory(Paths.cache);
   * const subscription = cacheDir.watch((event) => {
   *   console.log(`${event.type}: ${event.target.uri}`);
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
  watch(
    callback: (event: WatchEvent<File | Directory>) => void,
    options?: WatchOptions
  ): WatchSubscription {
    return new FileSystemWatcher<File | Directory>(
      this.uri,
      callback,
      options,
      (uri, isDirectory) => (isDirectory ? new Directory(uri) : new File(uri))
    );
  }
}

Directory.pickDirectoryAsync = async function (initialUri?: string) {
  const directory = (await ExpoFileSystem.pickDirectoryAsync(initialUri)).uri;
  return new Directory(directory);
};
