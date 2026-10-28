import { CodedError } from 'expo-modules-core';

import type { OpfsPath, OpfsRoot } from './opfsPaths';
import {
  getOpfsStore,
  opfsPathOrThrow,
  type OpfsEntry,
  type OpfsListEntry,
  type OpfsStore,
  type OpfsWriteData,
} from './opfsStore';
import { isOpfsAvailable } from './opfsSupport';

/** Why a sync reader threw: `ready()` has not finished. */
export const NOT_INITIALIZED_MESSAGE =
  'expo-file-system web storage is not initialized yet; await `Paths.ready()` before you read `Paths.cache` or `Paths.document` synchronously.';

const ROOTS: readonly OpfsRoot[] = ['cache', 'document'];
const DIRECTORY_ENTRY: OpfsEntry = { kind: 'directory', size: null, lastModified: null };

// What the sync readers answer when the browser has no OPFS: the placeholder roots of D25, empty
// directories that always exist, and nothing below them.
const PLACEHOLDER_ENTRIES: ReadonlyMap<string, OpfsEntry> = new Map(
  ROOTS.map((root) => [root, DIRECTORY_ENTRY])
);

/**
 * The key of an entry in the index: the root and the decoded names joined with `/`, for example
 * `cache/a b.txt`. URIs are not keys, because `file:///cache/a%20b.txt` and
 * `file:///cache/a b.txt` name the same entry, and a directory URI ends with `/` while the same
 * path as a file URI does not. Names never contain `/`, so a key has one meaning.
 */
export function opfsKeyOf(path: OpfsPath): string {
  return path.join('/');
}

function isBelow(key: string, ancestor: string): boolean {
  return key.startsWith(`${ancestor}/`);
}

/**
 * Keeps the kind, size, and modification time of every entry in `Paths.cache` and
 * `Paths.document` in memory, so `exists`, `size`, `lastModified`, `list()`, and `info()` can
 * answer synchronously. OPFS on the main thread is only asynchronous.
 *
 * `ready()` fills the index with one walk of both roots. Before that, the sync readers throw. The
 * write methods call the store and then update the entries of the paths they touched, also when
 * the store call fails, because a failed call can leave a change behind (an empty file, some of
 * the intermediate directories). When the index cannot read a path again after a failed call, it
 * forgets that path and everything below it, so `exists` is `false` there until `refresh()`
 * instead of an answer that may be stale.
 *
 * Every update of the entries runs on one queue, in the order the operations finished, so a
 * re-walk cannot drop a write that landed while it read OPFS. After an awaited mutation, the sync
 * readers agree with OPFS for that path.
 *
 * When the browser has no OPFS, the sync readers answer like the placeholder `Paths.cache` and
 * `Paths.document`: each root is an empty directory and nothing exists below it. The write
 * methods reject with `ERR_OPFS_UNAVAILABLE` from the store.
 *
 * The index only sees the changes made through it. Another tab or the browser developer tools can
 * change OPFS without it; `refresh()` reads a path again.
 */
export class OpfsIndex {
  readonly store: OpfsStore;
  readonly #isAvailable: () => boolean;
  #entries = new Map<string, OpfsEntry>();
  #hydration: Promise<void> | null = null;
  #hydrated = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(store: OpfsStore, isAvailable: () => boolean = isOpfsAvailable) {
    this.store = store;
    this.#isAvailable = isAvailable;
  }

  /**
   * Fills the index on the first call and resolves when it is filled; later calls return the same
   * promise. Resolves at once, without touching OPFS, when the browser has no OPFS, so an app can
   * always await it at startup; the sync readers then answer the placeholder values. Rejects when the walk fails (for example `ERR_STORAGE_UNAVAILABLE`
   * in private browsing); the next call tries again.
   */
  ready(): Promise<void> {
    if (!this.#isAvailable()) {
      return Promise.resolve();
    }
    this.#hydration ??= this.#hydrate().catch((error) => {
      this.#hydration = null;
      throw error;
    });
    return this.#hydration;
  }

  /** Whether `ready()` has finished, so the sync readers can be used. */
  get isReady(): boolean {
    return this.#hydrated;
  }

  async #hydrate(): Promise<void> {
    const entries = new Map<string, OpfsEntry>();
    for (const root of ROOTS) {
      entries.set(root, DIRECTORY_ENTRY);
      for (const [names, entry] of await this.store.readTree(`file:///${root}/`)) {
        entries.set(opfsKeyOf([root, ...names]), entry);
      }
    }
    this.#entries = entries;
    this.#hydrated = true;
  }

  // The entries a sync reader uses and the key of `uri` in them. An invalid uri throws first, so
  // the error does not depend on the browser or on `ready()`.
  #lookup(uri: string): [entries: ReadonlyMap<string, OpfsEntry>, key: string] {
    const key = opfsKeyOf(opfsPathOrThrow(uri));
    if (!this.#isAvailable()) {
      return [PLACEHOLDER_ENTRIES, key];
    }
    if (!this.#hydrated) {
      throw new CodedError('ERR_NOT_INITIALIZED', NOT_INITIALIZED_MESSAGE);
    }
    return [this.#entries, key];
  }

  /** Returns the entry at `uri`, or `null` when there is none. */
  entry(uri: string): OpfsEntry | null {
    const [entries, key] = this.#lookup(uri);
    return entries.get(key) ?? null;
  }

  /** Whether an entry of any kind exists at `uri`. */
  exists(uri: string): boolean {
    return this.entry(uri) !== null;
  }

  /**
   * Returns the names and kinds of the children of the directory at `uri`. `null` means there is
   * no directory there: nothing, or a file. The caller checks `entry()` first and throws the error
   * native throws for that case.
   */
  list(uri: string): OpfsListEntry[] | null {
    const [entries, key] = this.#lookup(uri);
    if (entries.get(key)?.kind !== 'directory') {
      return null;
    }
    const children: OpfsListEntry[] = [];
    for (const [childKey, entry] of entries) {
      if (isBelow(childKey, key) && !childKey.includes('/', key.length + 1)) {
        children.push({ name: childKey.slice(key.length + 1), kind: entry.kind });
      }
    }
    return children;
  }

  /**
   * Returns the sum of the sizes of every file below the directory at `uri`, at any depth, like
   * native `Directory.size`. `0` for an empty or missing directory.
   */
  subtreeSize(uri: string): number {
    const [entries, key] = this.#lookup(uri);
    let size = 0;
    for (const [childKey, entry] of entries) {
      if (entry.kind === 'file' && isBelow(childKey, key)) {
        size += entry.size;
      }
    }
    return size;
  }

  #removeTree(key: string, keepKey: boolean): void {
    for (const childKey of [...this.#entries.keys()]) {
      if (isBelow(childKey, key) || (!keepKey && childKey === key)) {
        this.#entries.delete(childKey);
      }
    }
  }

  // Reads the entry at `path` from OPFS again. A path that is now a directory, but was not one
  // before, or any directory when `deep` is set, gets its whole subtree read again.
  async #refreshPath(path: OpfsPath, deep: boolean): Promise<void> {
    const key = opfsKeyOf(path);
    const uri = `file:///${path.map(encodeURIComponent).join('/')}`;
    const entry = await this.store.stat(uri);
    if (!entry) {
      this.#removeTree(key, path.length === 1);
      return;
    }
    const wasDirectory = this.#entries.get(key)?.kind === 'directory';
    if (entry.kind === 'file') {
      this.#removeTree(key, true);
      this.#entries.set(key, entry);
      return;
    }
    this.#entries.set(key, entry);
    if (deep || !wasDirectory) {
      const tree = await this.store.readTree(`${uri}/`);
      this.#removeTree(key, true);
      for (const [names, child] of tree) {
        this.#entries.set(opfsKeyOf([...path, ...names] as OpfsPath), child);
      }
    }
  }

  // Removes `path` and everything below it, so the index does not know the path any more. A root
  // keeps its entry, because it always exists.
  #forget(path: OpfsPath): void {
    this.#removeTree(opfsKeyOf(path), path.length === 1);
  }

  // Runs `change` after every earlier update, so two updates never interleave: a re-walk that
  // reads OPFS and then replaces a subtree cannot drop a write that landed in between. It also
  // waits for a running walk, so the walk cannot overwrite the update. Before `ready()` there is no
  // index to update: the walk reads the current state later.
  #update(change: () => void | Promise<void>): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#hydration?.catch(() => {});
      if (this.#hydrated) {
        await change();
      }
    });
    // A failed update must not stop the ones after it.
    this.#queue = run.catch(() => {});
    return run;
  }

  // Runs `operation`, then updates the index with `onSuccess`. When `operation` fails, the paths
  // are read again from OPFS with `refreshOnError`; when that fails too, `touched` is forgotten. An
  // error while updating the index is dropped in both cases, so the caller sees the result of
  // `operation`: an operation that succeeded must not look failed.
  async #mutate<T>(
    operation: () => Promise<T>,
    onSuccess: (result: T) => void | Promise<void>,
    refreshOnError: () => Promise<void>,
    touched: OpfsPath
  ): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await this.#update(async () => {
        try {
          await refreshOnError();
        } catch {
          this.#forget(touched);
        }
      }).catch(() => {});
      throw error;
    }
    await this.#update(() => onSuccess(result)).catch(() => {});
    return result;
  }

  /**
   * Reads the entry at `uri`, and everything below it when it is a directory, from OPFS again.
   * Use it after an OPFS error that suggests the index is stale, for example a file removed in
   * another tab. Does nothing before `ready()`.
   */
  async refresh(uri: string): Promise<void> {
    const path = opfsPathOrThrow(uri);
    await this.#update(() => this.#refreshPath(path, true));
  }

  /** `OpfsStore.writeFile()`, then updates the entry of the file. */
  writeFile(uri: string, data: OpfsWriteData, options?: { append?: boolean }): Promise<OpfsEntry> {
    const path = opfsPathOrThrow(uri);
    return this.#mutate(
      () => this.store.writeFile(uri, data, options),
      (entry) => {
        this.#entries.set(opfsKeyOf(path), entry);
      },
      () => this.#refreshPath(path, false),
      path
    );
  }

  /**
   * `OpfsStore.createDirectory()`, then adds the directory and each parent below the root. A
   * directory the index did not know gets its content read: it may have existed in OPFS already,
   * created in another tab. After a failure, the directories are read again from OPFS.
   */
  createDirectory(uri: string, options?: { intermediates?: boolean }): Promise<void> {
    const path = opfsPathOrThrow(uri);
    // Every directory from the first one below the root down to `uri`.
    const paths = path.slice(1).map((_, index) => path.slice(0, index + 2) as OpfsPath);
    const onSuccess = async () => {
      // The operation succeeded, so every one of them is a directory now. They are added before
      // any OPFS read, so a failed read below cannot leave them missing.
      const unknown = paths.filter(
        (directory) => this.#entries.get(opfsKeyOf(directory))?.kind !== 'directory'
      );
      for (const directory of paths) {
        this.#entries.set(opfsKeyOf(directory), DIRECTORY_ENTRY);
      }
      // `paths` goes from the top down, so the first unknown directory holds all the others, and
      // one walk of it reads every one of them.
      if (unknown[0]) {
        await this.#refreshPath(unknown[0], true);
      }
    };
    const refreshOnError = async () => {
      for (const directory of paths) {
        await this.#refreshPath(directory, false);
      }
    };
    // A failure forgets the first directory below the root: `refreshOnError` may have stopped at
    // any of them.
    return this.#mutate(
      () => this.store.createDirectory(uri, options),
      onSuccess,
      refreshOnError,
      paths[0] ?? path
    );
  }

  /** `OpfsStore.removeFile()`, then removes the entry of the file. */
  removeFile(uri: string): Promise<void> {
    const path = opfsPathOrThrow(uri);
    return this.#mutate(
      () => this.store.removeFile(uri),
      () => this.#forget(path),
      () => this.#refreshPath(path, false),
      path
    );
  }

  /**
   * `OpfsStore.removeDirectory()`, then removes the entries of the directory and everything below
   * it. A root keeps its own entry, because the store creates it again.
   */
  removeDirectory(uri: string, options?: { recursive?: boolean }): Promise<void> {
    const path = opfsPathOrThrow(uri);
    return this.#mutate(
      () => this.store.removeDirectory(uri, options),
      () => this.#forget(path),
      // A recursive removal can stop halfway, so the whole subtree is read again.
      () => this.#refreshPath(path, true),
      path
    );
  }
}

let defaultIndex: OpfsIndex | undefined;

/** The index over `getOpfsStore()`. Nothing touches OPFS until `ready()` is called. */
export function getOpfsIndex(): OpfsIndex {
  defaultIndex ??= new OpfsIndex(getOpfsStore());
  return defaultIndex;
}
