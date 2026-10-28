/**
 * @jest-environment node
 */
// Node has the WHATWG `DOMException`, so the errors are built like the ones OPFS throws.
import { toFileSystemError, type OpfsErrorContext } from '../opfsErrors';

const FILE: OpfsErrorContext = { uri: 'file:///cache/a.txt', operation: 'write', expected: 'file' };
const DIRECTORY: OpfsErrorContext = {
  uri: 'file:///document/dir/',
  operation: 'delete',
  expected: 'directory',
};

function domException(name: string) {
  return new DOMException(`browser message for ${name}`, name);
}

describe('toFileSystemError', () => {
  it.each([
    ['NotFoundError', 'ERR_NOT_FOUND'],
    ['NoModificationAllowedError', 'ERR_FILE_LOCKED'],
    ['QuotaExceededError', 'ERR_QUOTA_EXCEEDED'],
    ['NotAllowedError', 'ERR_MISSING_PERMISSION'],
    ['SecurityError', 'ERR_STORAGE_UNAVAILABLE'],
    ['InvalidModificationError', 'ERR_DIRECTORY_NOT_EMPTY'],
  ])('maps %s to %s', (name, code) => {
    const original = domException(name);
    const error = toFileSystemError(original, FILE) as Error & { code: string };
    expect(error.code).toBe(code);
    expect(error.cause).toBe(original);
    expect(error.message).toContain('Failed to write the file at "file:///cache/a.txt"');
  });

  // The codes match the native `InvalidTypeFileException` and `InvalidTypeDirectoryException`, so
  // code that checks `error.code` works on every platform.
  it('maps TypeMismatchError by the kind of entry the call expected', () => {
    const original = domException('TypeMismatchError');
    expect(toFileSystemError(original, FILE)).toMatchObject({
      code: 'ERR_INVALID_TYPE_FILE',
      message: expect.stringContaining('a directory with the same name exists'),
      cause: original,
    });
    expect(toFileSystemError(original, DIRECTORY)).toMatchObject({
      code: 'ERR_INVALID_TYPE_DIRECTORY',
      message: expect.stringContaining('a file with the same name exists'),
      cause: original,
    });
  });

  it('points at `navigator.storage.estimate()` when the quota is exceeded', () => {
    const error = toFileSystemError(domException('QuotaExceededError'), FILE) as Error;
    expect(error.message).toContain('navigator.storage.estimate()');
  });

  it('mentions the secure context when access is denied', () => {
    const error = toFileSystemError(domException('NotAllowedError'), FILE) as Error;
    expect(error.message).toContain('secure context');
  });

  // Chrome throws `QuotaExceededError` from its own class, and an error from an iframe has another
  // realm's `DOMException`. Both fail `instanceof DOMException` but keep their `name`.
  it('matches a known error by name, not by class', () => {
    const original = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    expect(toFileSystemError(original, FILE)).toMatchObject({
      code: 'ERR_QUOTA_EXCEEDED',
      cause: original,
    });
  });

  it('keeps the name and the message of another DOMException', () => {
    const original = domException('InvalidStateError');
    const error = toFileSystemError(original, DIRECTORY) as Error & { code: string };
    expect(error.code).toBe('ERR_FILE_SYSTEM');
    expect(error.cause).toBe(original);
    expect(error.message).toBe(
      'Failed to delete the directory at "file:///document/dir/": InvalidStateError: browser message for InvalidStateError.'
    );
  });

  // A `TypeError` comes from an invalid name or from a bug, and both are clearer unchanged.
  it('returns errors that are not DOMExceptions unchanged', () => {
    for (const original of [new TypeError('invalid name'), new Error('bug'), 'text', null]) {
      expect(toFileSystemError(original, FILE)).toBe(original);
    }
  });
});
