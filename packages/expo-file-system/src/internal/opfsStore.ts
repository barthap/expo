import { CodedError } from 'expo-modules-core';

import { toFileSystemError, type OpfsErrorContext } from './opfsErrors';
import { OPFS_BASE_DIRECTORY, opfsPathOf, type OpfsPath, type OpfsRoot } from './opfsPaths';
import { OPFS_UNAVAILABLE_MESSAGE, isOpfsAvailable } from './opfsSupport';

/**
 * What OPFS knows about an entry. OPFS has no size or modification time for a directory, so both
 * are `null` there.
 */
export type OpfsEntry =
  | { kind: 'file'; size: number; lastModified: number }
  | { kind: 'directory'; size: null; lastModified: null };

/** A child of a directory, as `OpfsStore.list()` returns it. */
export type OpfsListEntry = { name: string; kind: 'file' | 'directory' };

/** The data `OpfsStore.writeFile()` accepts. A stream is piped into the file. */
export type OpfsWriteData = string | BufferSource | Blob | ReadableStream<Uint8Array>;

/** Returns the root of the origin private file system, `navigator.storage.getDirectory()`. */
export type OpfsRootGetter = () => Promise<FileSystemDirectoryHandle>;

const DIRECTORY_ENTRY: OpfsEntry = { kind: 'directory', size: null, lastModified: null };

function fileEntry(file: globalThis.File): OpfsEntry {
  return { kind: 'file', size: file.size, lastModified: file.lastModified };
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

// The error OPFS itself throws when a call finds a directory where it expected a file, or the
// other way around. Used for the roots, which OPFS never sees as a named child.
function typeMismatch(): DOMException {
  return new DOMException('The entry has the wrong kind.', 'TypeMismatchError');
}

/**
 * Maps a `file:///cache/...` or `file:///document/...` URI to its OPFS path, before any OPFS call.
 * Throws `ERR_INVALID_PATH` for any other URI, and for the URIs `opfsPathOf()` rejects.
 */
export function opfsPathOrThrow(uri: string): OpfsPath {
  const path = opfsPathOf(uri);
  if (!path) {
    throw new CodedError(
      'ERR_INVALID_PATH',
      `The path "${uri}" is not in \`Paths.cache\` or \`Paths.document\`, so it has no storage on web.`
    );
  }
  return path;
}

/**
 * The URI of the directory that holds the first `count` names of `uri`, with the encoding of
 * `uri`. Used in the message when a parent directory is missing or is a file.
 */
function ancestorUri(uri: string, count: number): string {
  const segments = uri.slice('file:///'.length).split('/').filter(Boolean);
  return `file:///${segments.slice(0, count + 1).join('/')}/`;
}

/**
 * Reads and writes the entries under `<OPFS root>/expo-file-system/<cache|document>/` through the
 * asynchronous main-thread handles. Every method takes the normalized `uri` of a `File` or
 * `Directory`, checks it with `opfsPathOrThrow()` before the first OPFS call, and turns OPFS
 * errors into expo-file-system errors with `toFileSystemError()`.
 *
 * The OPFS directory, `expo-file-system`, and both roots are created on the first call that needs
 * them, because `Paths.cache` and `Paths.document` always exist on native too. Handles are not
 * kept between calls: an entry removed in another tab or in the browser developer tools makes an
 * old handle throw `NotFoundError`.
 */
export class OpfsStore {
  readonly #getOpfsRoot: OpfsRootGetter;

  constructor(getOpfsRoot: OpfsRootGetter) {
    this.#getOpfsRoot = getOpfsRoot;
  }

  // An error here names `file:///`, the directory that holds both roots, not the caller's uri.
  async #base(context: OpfsErrorContext): Promise<FileSystemDirectoryHandle> {
    try {
      const opfsRoot = await this.#getOpfsRoot();
      return await opfsRoot.getDirectoryHandle(OPFS_BASE_DIRECTORY, { create: true });
    } catch (error) {
      throw toFileSystemError(error, { ...context, uri: 'file:///', expected: 'directory' });
    }
  }

  // An error here names the root, not the caller's uri.
  async #root(root: OpfsRoot, context: OpfsErrorContext): Promise<FileSystemDirectoryHandle> {
    const base = await this.#base(context);
    try {
      return await base.getDirectoryHandle(root, { create: true });
    } catch (error) {
      throw toFileSystemError(error, {
        ...context,
        uri: ancestorUri(context.uri, 0),
        expected: 'directory',
      });
    }
  }

  // Opens the directory that holds `names`, one name at a time from the root. A missing directory
  // is created when `create` is true. An error names the directory that failed, not `uri`.
  async #directory(
    path: OpfsPath,
    uri: string,
    operation: string,
    create = false
  ): Promise<FileSystemDirectoryHandle> {
    const [root, ...names] = path;
    let handle = await this.#root(root, { uri, operation, expected: 'directory' });
    for (const [index, name] of names.entries()) {
      try {
        handle = await handle.getDirectoryHandle(name, { create });
      } catch (error) {
        throw toFileSystemError(error, {
          uri: ancestorUri(uri, index + 1),
          operation,
          expected: 'directory',
        });
      }
    }
    return handle;
  }

  /**
   * Returns the kind, size, and modification time of the entry at `uri`, or `null` when there is
   * no entry there. A file in place of one of the parent directories also gives `null`, like
   * native `exists`. A root is always a directory.
   *
   * Like every other method, it creates the OPFS directories `expo-file-system/<root>` when they
   * are missing, so a call on a fresh origin writes to OPFS.
   */
  async stat(uri: string): Promise<OpfsEntry | null> {
    const [root, ...names] = opfsPathOrThrow(uri);
    const name = names.pop();
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await this.#directory([root, ...names], uri, 'open');
    } catch (error) {
      if (codeOf(error) === 'ERR_NOT_FOUND' || codeOf(error) === 'ERR_INVALID_TYPE_DIRECTORY') {
        return null;
      }
      throw error;
    }
    if (name === undefined) {
      return DIRECTORY_ENTRY;
    }
    try {
      const handle = await parent.getFileHandle(name);
      return fileEntry(await handle.getFile());
    } catch (error) {
      const errorName = (error as { name?: unknown } | null)?.name;
      if (errorName === 'NotFoundError') {
        return null;
      }
      if (errorName !== 'TypeMismatchError') {
        throw toFileSystemError(error, { uri, operation: 'read the info of', expected: 'file' });
      }
    }
    // OPFS found a directory with that name.
    try {
      await parent.getDirectoryHandle(name);
      return DIRECTORY_ENTRY;
    } catch (error) {
      // The entry was removed between the two calls.
      if ((error as { name?: unknown } | null)?.name === 'NotFoundError') {
        return null;
      }
      throw toFileSystemError(error, {
        uri,
        operation: 'read the info of',
        expected: 'directory',
      });
    }
  }

  /** Whether an entry of any kind exists at `uri`. */
  async exists(uri: string): Promise<boolean> {
    return (await this.stat(uri)) !== null;
  }

  async #fileHandle(uri: string, operation: string, create = false): Promise<FileSystemFileHandle> {
    const [root, ...names] = opfsPathOrThrow(uri);
    const name = names.pop();
    const context: OpfsErrorContext = { uri, operation, expected: 'file' };
    if (name === undefined) {
      throw toFileSystemError(typeMismatch(), context);
    }
    const parent = await this.#directory([root, ...names], uri, operation);
    try {
      return await parent.getFileHandle(name, { create });
    } catch (error) {
      throw toFileSystemError(error, context);
    }
  }

  /**
   * Returns the data of the file at `uri` as a browser `File`, read when this is called. The
   * browser may fail to read it after the file changes.
   */
  async readFile(uri: string): Promise<globalThis.File> {
    const handle = await this.#fileHandle(uri, 'read');
    try {
      return await handle.getFile();
    } catch (error) {
      throw toFileSystemError(error, { uri, operation: 'read', expected: 'file' });
    }
  }

  /**
   * Writes `data` to the file at `uri` and returns its new info. The file is created when it is
   * missing, but its parent directory must exist, like native `File.write()`. With `append`, the
   * data goes after the existing content; otherwise it replaces it.
   *
   * OPFS writes to a temporary file and replaces the content only when the write finishes, so a
   * failed write leaves the old content. A file that did not exist before stays as an empty file.
   *
   * The write takes an exclusive lock on the file (`mode: 'exclusive'`), so a second write to the
   * same file while one is open, also from another tab, throws `ERR_FILE_LOCKED`. Without the lock,
   * two concurrent appends would both start from the old content and the one that finishes last
   * would drop the other's data, while native appends never lose data. A browser that ignores
   * `mode` gives the default `'siloed'` behaviour instead: both writes succeed and the last one to
   * finish wins.
   */
  async writeFile(
    uri: string,
    data: OpfsWriteData,
    options: { append?: boolean } = {}
  ): Promise<OpfsEntry> {
    const handle = await this.#fileHandle(uri, 'write', true);
    const context: OpfsErrorContext = { uri, operation: 'write', expected: 'file' };
    let position: number;
    let writable: FileSystemWritableFileStream;
    try {
      position = options.append ? (await handle.getFile()).size : 0;
      // A variable, because `FileSystemCreateWritableOptions` in the TypeScript DOM types does not
      // have `mode` yet.
      const writableOptions = { keepExistingData: !!options.append, mode: 'exclusive' as const };
      writable = await handle.createWritable(writableOptions);
    } catch (error) {
      throw toFileSystemError(error, context);
    }
    let piping = false;
    try {
      if (position > 0) {
        await writable.seek(position);
      }
      if (data instanceof ReadableStream) {
        piping = true;
        // `pipeTo` closes the writable when the stream ends and aborts it when the stream fails.
        await data.pipeTo(writable);
      } else {
        await writable.write(data);
        await writable.close();
      }
    } catch (error) {
      if (!piping) {
        // Releases the lock and drops the temporary data. It rejects when the stream is already
        // errored, which changes nothing.
        await writable.abort(error).catch(() => {});
      }
      throw toFileSystemError(error, context);
    }
    try {
      return fileEntry(await handle.getFile());
    } catch (error) {
      throw toFileSystemError(error, context);
    }
  }

  /**
   * Creates the directory at `uri`. With `intermediates`, the missing parent directories are
   * created too, like native `Directory.create({ intermediates: true })`; without it, a missing
   * parent throws `ERR_NOT_FOUND`. An existing directory is not an error here: the caller applies
   * the `overwrite` and `idempotent` options of `Directory.create()` before it calls this. A file
   * at `uri` or in place of a parent throws `ERR_INVALID_TYPE_DIRECTORY`.
   */
  async createDirectory(uri: string, options: { intermediates?: boolean } = {}): Promise<void> {
    const [root, ...names] = opfsPathOrThrow(uri);
    const name = names.pop();
    const parent = await this.#directory([root, ...names], uri, 'create', !!options.intermediates);
    if (name === undefined) {
      return;
    }
    try {
      await parent.getDirectoryHandle(name, { create: true });
    } catch (error) {
      throw toFileSystemError(error, { uri, operation: 'create', expected: 'directory' });
    }
  }

  /**
   * Returns the names and kinds of the entries in the directory at `uri`, in the order OPFS gives
   * them.
   */
  async list(uri: string): Promise<OpfsListEntry[]> {
    const handle = await this.#directory(opfsPathOrThrow(uri), uri, 'list');
    const entries: OpfsListEntry[] = [];
    try {
      for await (const [name, child] of handle.entries()) {
        entries.push({ name, kind: child.kind });
      }
    } catch (error) {
      throw toFileSystemError(error, { uri, operation: 'list', expected: 'directory' });
    }
    return entries;
  }

  /**
   * Returns every entry below the directory at `uri`, each with its names relative to `uri`, in
   * one walk over the handles. An entry that disappears during the walk (removed in another tab)
   * is left out.
   */
  async readTree(uri: string): Promise<[names: string[], entry: OpfsEntry][]> {
    const handle = await this.#directory(opfsPathOrThrow(uri), uri, 'list');
    // Returns the entries of a subtree, so a directory that disappears drops all of them.
    const visit = async (
      directory: FileSystemDirectoryHandle,
      prefix: string[]
    ): Promise<[string[], OpfsEntry][]> => {
      const tree: [string[], OpfsEntry][] = [];
      for await (const [name, child] of directory.entries()) {
        const names = [...prefix, name];
        try {
          if (child.kind === 'file') {
            tree.push([names, fileEntry(await child.getFile())]);
          } else {
            const subtree = await visit(child, names);
            tree.push([names, DIRECTORY_ENTRY], ...subtree);
          }
        } catch (error) {
          if ((error as { name?: unknown } | null)?.name !== 'NotFoundError') {
            throw error;
          }
        }
      }
      return tree;
    };
    try {
      return await visit(handle, []);
    } catch (error) {
      throw toFileSystemError(error, { uri, operation: 'list', expected: 'directory' });
    }
  }

  /** Removes the file at `uri`. A directory at `uri` throws `ERR_INVALID_TYPE_FILE`. */
  async removeFile(uri: string): Promise<void> {
    const [root, ...names] = opfsPathOrThrow(uri);
    const name = names.pop();
    const context: OpfsErrorContext = { uri, operation: 'delete', expected: 'file' };
    if (name === undefined) {
      throw toFileSystemError(typeMismatch(), context);
    }
    const parent = await this.#directory([root, ...names], uri, 'delete');
    try {
      // `removeEntry` removes an entry of either kind, so the kind is checked first.
      await parent.getFileHandle(name);
      await parent.removeEntry(name);
    } catch (error) {
      throw toFileSystemError(error, context);
    }
  }

  /**
   * Removes the directory at `uri`. Without `recursive`, a directory that is not empty throws
   * `ERR_DIRECTORY_NOT_EMPTY`. Native `Directory.delete()` always removes the content, so the web
   * `Directory` passes `recursive: true`. A file at `uri` throws `ERR_INVALID_TYPE_DIRECTORY`.
   *
   * A root is removed and created again empty, because `Paths.cache` and `Paths.document` always
   * exist.
   */
  async removeDirectory(uri: string, options: { recursive?: boolean } = {}): Promise<void> {
    const [root, ...names] = opfsPathOrThrow(uri);
    const name = names.pop();
    const context: OpfsErrorContext = { uri, operation: 'delete', expected: 'directory' };
    const recursive = !!options.recursive;
    if (name === undefined) {
      const base = await this.#base(context);
      try {
        await base.removeEntry(root, { recursive });
      } catch (error) {
        // A root that was never created has nothing to remove.
        if ((error as { name?: unknown } | null)?.name !== 'NotFoundError') {
          throw toFileSystemError(error, context);
        }
      }
      await this.#root(root, context);
      return;
    }
    const parent = await this.#directory([root, ...names], uri, 'delete');
    try {
      await parent.getDirectoryHandle(name);
      await parent.removeEntry(name, { recursive });
    } catch (error) {
      throw toFileSystemError(error, context);
    }
  }
}

let defaultStore: OpfsStore | undefined;

/**
 * The store over `navigator.storage.getDirectory()`. Every call rejects with
 * `ERR_OPFS_UNAVAILABLE` when the browser has no OPFS (see `isOpfsAvailable()`).
 */
export function getOpfsStore(): OpfsStore {
  defaultStore ??= new OpfsStore(async () => {
    if (!isOpfsAvailable()) {
      throw new CodedError('ERR_OPFS_UNAVAILABLE', OPFS_UNAVAILABLE_MESSAGE);
    }
    return navigator.storage.getDirectory();
  });
  return defaultStore;
}
