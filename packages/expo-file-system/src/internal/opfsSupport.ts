/**
 * Why `Paths.cache` and `Paths.document` cannot store files in this browser.
 */
export const OPFS_UNAVAILABLE_MESSAGE =
  'Persistent storage in expo-file-system on web requires the Origin Private File System (OPFS): a secure context (HTTPS or localhost) and a browser that supports `FileSystemFileHandle.createWritable()`.';

/**
 * Checks the browser for everything the OPFS storage uses: a secure context,
 * `navigator.storage.getDirectory()`, and `FileSystemFileHandle.createWritable()`. Reads the globals
 * on every call. Use `isOpfsAvailable()` outside tests.
 */
export function detectOpfs(): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof globalThis.navigator?.storage?.getDirectory === 'function' &&
    typeof globalThis.FileSystemFileHandle === 'function' &&
    'createWritable' in globalThis.FileSystemFileHandle.prototype
  );
}

let opfsAvailable: boolean | undefined;

/**
 * Whether the OPFS storage can be used. It is checked on the first call, and every later call
 * returns the same answer.
 */
export function isOpfsAvailable(): boolean {
  opfsAvailable ??= detectOpfs();
  return opfsAvailable;
}
