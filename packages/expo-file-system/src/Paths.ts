import { Directory } from './Directory';
import ExpoFileSystem from './ExpoFileSystem';
import type { PathInfo } from './Paths.types';
import { PathUtilities } from './pathUtilities';

export class Paths extends PathUtilities {
  /**
   * A property containing the cache directory – a place to store files that can be deleted by the system when the device runs low on storage.
   *
   * > **Note:** On web, this is the placeholder `file:///cache/`. It exists, but it cannot hold files yet, so
   * > every `File` or `Directory` inside it does not exist.
   */
  static get cache() {
    return new Directory(ExpoFileSystem.cacheDirectory);
  }

  /**
   * A property containing the bundle directory – the directory where assets bundled with the application are stored.
   *
   * > **Note:** On web, this is the placeholder `file:///bundle/`. It exists, but it cannot hold files yet, so
   * > every `File` or `Directory` inside it does not exist.
   */
  static get bundle() {
    return new Directory(ExpoFileSystem.bundleDirectory);
  }

  /**
   * A property containing the document directory – a place to store files that are safe from being deleted by the system.
   *
   * > **Note:** On web, this is the placeholder `file:///document/`. It exists, but it cannot hold files yet, so
   * > every `File` or `Directory` inside it does not exist.
   */
  static get document() {
    return new Directory(ExpoFileSystem.documentDirectory);
  }
  /**
   * Prepares the storage behind `Paths.cache` and `Paths.document` and resolves when it is ready.
   * Call it once at startup, before you use files in them.
   *
   * On web, files in `Paths.cache` and `Paths.document` are stored in the Origin Private File
   * System (OPFS) of the browser. The first call reads the names, sizes, and modification times of
   * all stored files into memory, so `exists`, `size`, `lastModified`, `list()`, and `info()` can
   * answer synchronously. Until the returned promise resolves, those members throw an
   * `ERR_NOT_INITIALIZED` error. Later calls return the same promise. When the browser has no OPFS
   * (for example on a page that is not served over HTTPS or from `localhost`), it resolves at
   * once. If reading the storage fails, the promise rejects and the next call tries again.
   *
   * On Android, iOS, and tvOS, it resolves at once and does nothing.
   *
   * @example
   * ```ts
   * await Paths.ready();
   * const settings = new File(Paths.document, 'settings.json');
   * if (settings.exists) {
   *   console.log(await settings.json());
   * }
   * ```
   */
  static ready(): Promise<void> {
    return ExpoFileSystem.ready?.() ?? Promise.resolve();
  }

  static get appleSharedContainers() {
    const containers: Record<string, string> = ExpoFileSystem.appleSharedContainers ?? {};
    const result: Record<string, Directory> = {};
    for (const appGroupId in containers) {
      if (containers[appGroupId]) {
        result[appGroupId] = new Directory(containers[appGroupId]);
      }
    }
    return result;
  }

  /**
   * A property that represents the total space on device's internal storage, represented in bytes.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  static get totalDiskSpace() {
    return ExpoFileSystem.totalDiskSpace;
  }

  /**
   * A property that represents the available space on device's internal storage, represented in bytes.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  static get availableDiskSpace() {
    return ExpoFileSystem.availableDiskSpace;
  }

  /**
   * Returns an object that indicates if the specified path represents a directory.
   *
   * @platform android
   * @platform ios
   * @platform tvos
   */
  static info(...uris: string[]): PathInfo {
    return ExpoFileSystem.info(uris.join('/'));
  }
}
