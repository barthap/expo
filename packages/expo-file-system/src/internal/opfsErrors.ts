import { CodedError } from 'expo-modules-core';

/** What the failed OPFS call was doing, for the error message. */
export type OpfsErrorContext = {
  /** The `uri` of the `File` or `Directory`. */
  uri: string;
  /** The operation in the message, for example `write` or `delete`. */
  operation: string;
  /** Whether the call expected a file or a directory at `uri`. */
  expected: 'file' | 'directory';
};

function describe(name: string, { expected }: OpfsErrorContext): [code: string, reason: string] {
  switch (name) {
    case 'NotFoundError':
      return ['ERR_NOT_FOUND', `the ${expected} or one of its parent directories does not exist`];
    case 'TypeMismatchError':
      // `ERR_INVALID_TYPE_FILE` matches both native platforms. `ERR_INVALID_TYPE_DIRECTORY` matches
      // iOS, while Android reports `ERR_INVALID_TYPE_FOLDER`.
      return expected === 'file'
        ? ['ERR_INVALID_TYPE_FILE', 'a directory with the same name exists at this path']
        : ['ERR_INVALID_TYPE_DIRECTORY', 'a file with the same name exists at this path'];
    case 'NoModificationAllowedError':
      return [
        'ERR_FILE_LOCKED',
        'another writer holds a lock on the file, for example an open write in another tab',
      ];
    case 'QuotaExceededError':
      return [
        'ERR_QUOTA_EXCEEDED',
        'the storage quota of this site is exceeded. Check the usage and the quota with `navigator.storage.estimate()`',
      ];
    case 'NotAllowedError':
      return [
        'ERR_MISSING_PERMISSION',
        'the browser denied access to the storage, which needs a secure context (HTTPS or localhost)',
      ];
    case 'SecurityError':
      return [
        'ERR_STORAGE_UNAVAILABLE',
        'the browser cannot open the storage of this site, for example in private browsing mode',
      ];
    case 'InvalidModificationError':
      return ['ERR_DIRECTORY_NOT_EMPTY', 'the directory is not empty'];
    default:
      return ['ERR_FILE_SYSTEM', ''];
  }
}

function isDOMException(error: unknown): error is DOMException {
  return typeof DOMException !== 'undefined' && error instanceof DOMException;
}

/**
 * Turns an error thrown by an OPFS call into an expo-file-system error with a `code`, a message
 * that names the `uri`, and the original error as `cause`. The known `DOMException` names are
 * matched by `name`, because an error from another realm or a `QuotaExceededError` from its own
 * class may fail `instanceof DOMException`. Other `DOMException`s get `ERR_FILE_SYSTEM`. Errors
 * that are not `DOMException`s, such as the `TypeError` for an invalid name, are returned
 * unchanged.
 */
export function toFileSystemError(error: unknown, context: OpfsErrorContext): unknown {
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') {
    return error;
  }
  const [code, reason] = describe(name, context);
  if (code === 'ERR_FILE_SYSTEM' && !isDOMException(error)) {
    return error;
  }
  const detail = reason || `${name}: ${(error as Error).message}`;
  const mapped = new CodedError(
    code,
    `Failed to ${context.operation} the ${context.expected} at "${context.uri}": ${detail}.`
  );
  mapped.cause = error;
  return mapped;
}
