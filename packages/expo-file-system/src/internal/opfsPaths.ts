import { CodedError } from 'expo-modules-core';

import { normalize } from '../pathUtilities/path';
import { asUrl } from '../pathUtilities/url';

/**
 * Cleans up a `file:` URI the way the native `File` and `Directory` constructors do, so the same
 * path gives the same `uri` on every platform. `file:/p` and `file://localhost/p` become
 * `file:///p`, `.` and `..` segments are resolved, repeated slashes are joined, a file URI loses
 * its trailing slash, and a directory URI gains one. Like iOS `standardizedFileURL`, it drops any
 * host (`file://server/a` becomes `file:///a`) and the query. Other URIs, such as `blob:`,
 * `data:`, or `https:`, are returned unchanged.
 */
export function normalizeFileUri(uri: string, kind: 'file' | 'directory'): string {
  if (uri.slice(0, 'file:'.length).toLowerCase() !== 'file:') {
    return uri;
  }
  const url = asUrl(uri);
  if (!url) {
    return uri;
  }
  let pathname = normalize(url.pathname);
  if (kind === 'directory' && !pathname.endsWith('/')) {
    pathname += '/';
  } else if (kind === 'file' && pathname.length > 1 && pathname.endsWith('/')) {
    // The root `/` stays, because a file URI needs a path.
    pathname = pathname.slice(0, -1);
  }
  return `file://${pathname}`;
}

/** The roots under the OPFS directory: `Paths.cache` and `Paths.document`. */
export type OpfsRoot = 'cache' | 'document';

/** A root followed by the decoded names of the entries below it. */
export type OpfsPath = [root: OpfsRoot, ...names: string[]];

/** The OPFS directory that holds the two roots. */
export const OPFS_BASE_DIRECTORY = 'expo-file-system';

const OPFS_ROOTS: readonly string[] = ['cache', 'document'] satisfies OpfsRoot[];
const FILE_URI_PREFIX = 'file:///';

function invalidPath(uri: string, reason: string): CodedError {
  return new CodedError('ERR_INVALID_PATH', `The path "${uri}" is not valid: ${reason}.`);
}

/**
 * Maps a normalized `file:///cache/...` or `file:///document/...` URI to its OPFS root and entry
 * names, for example `file:///cache/a/b%20c.txt` to `['cache', 'a', 'b c.txt']`. A trailing slash
 * (a directory URI) is allowed. Returns `null` for every other URI, including `file:///bundle/`.
 *
 * It does not resolve `..` or `.`, because the `File` and `Directory` constructors already did.
 * A URI under a root that still has them, an empty segment, or a name that OPFS rejects (empty,
 * `.`, `..`, or with a `/`) throws `ERR_INVALID_PATH`, so a path can never leave its root. The
 * constructors never produce an empty or dot segment, so this rejection only guards hand-built
 * URIs.
 *
 * The query and fragment check runs after the root check, so `file:///bundle/a?x` returns `null`
 * while `file:///cache/a?x` throws.
 */
export function opfsPathOf(uri: string): OpfsPath | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) {
    return null;
  }
  const segments = uri.slice(FILE_URI_PREFIX.length).split('/');
  const root = segments.shift()!;
  if (!OPFS_ROOTS.includes(root)) {
    return null;
  }
  if (/[?#]/.test(uri)) {
    throw invalidPath(uri, 'it has a query or a fragment');
  }
  if (segments[segments.length - 1] === '') {
    segments.pop();
  }
  const names = segments.map((segment) => {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      throw invalidPath(uri, `"${segment}" is not a valid percent-encoded name`);
    }
    if (name === '') {
      throw invalidPath(uri, 'it has an empty segment');
    }
    if (name === '.' || name === '..') {
      throw invalidPath(uri, `it has a "${name}" segment`);
    }
    if (name.includes('/')) {
      throw invalidPath(uri, `the name "${name}" has a "/"`);
    }
    return name;
  });
  return [root as OpfsRoot, ...names];
}
