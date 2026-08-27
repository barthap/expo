import { Blob, isBlobLike, type BlobPart } from '../blob';

/**
 * W3C File API-compliant `File` — an immutable `Blob` snapshot with a `name` and
 * `lastModified` timestamp. Installed as the global `File` on native, replacing
 * React Native's polyfill (which extends React Native's built-in `Blob`, not the
 * `expo/blob` implementation installed as the global `Blob`).
 *
 * This is the standard snapshot type required by WinterTC — distinct from
 * `expo-file-system`'s `File`, which is a filesystem path handle.
 *
 * @see https://w3c.github.io/FileAPI/#file-section
 */
export class File extends Blob {
  static [Symbol.hasInstance](instance: any): boolean {
    // Subclasses inherit this method, but duck-typing must not apply to them, see the same
    // check in `Blob[Symbol.hasInstance]`.
    if (this !== File) {
      return Function.prototype[Symbol.hasInstance].call(this, instance);
    }
    // Real File instances (checked without `instanceof` to avoid recursing into this method)
    if (Object.prototype.isPrototypeOf.call(File.prototype, instance)) {
      return true;
    }
    // Duck-typed File-like implementations: Blob-like with a file name,
    // such as expo-file-system's File
    return isBlobLike(instance) && typeof instance.name === 'string';
  }

  private readonly _name: string;
  private readonly _lastModified: number;

  constructor(
    fileBits: BlobPart[] | Iterable<BlobPart>,
    fileName: string,
    options?: FilePropertyBag
  ) {
    if (!new.target) {
      throw new TypeError("File constructor requires 'new' operator");
    }
    if (arguments.length < 2) {
      throw new TypeError(
        `File constructor requires 2 arguments, but only ${arguments.length} present`
      );
    }
    // `fileBits` is a required `sequence<BlobPart>`, so unlike in the Blob constructor,
    // `undefined` is not an empty list.
    if (fileBits === undefined) {
      throw new TypeError("File constructor requires 'fileBits' to be an iterable object");
    }
    super(fileBits, options);
    this._name = String(fileName);
    this._lastModified =
      options?.lastModified !== undefined ? toLongLong(options.lastModified) : Date.now();
  }

  // `name` and `lastModified` are readonly attributes, exposed as getters on the prototype
  // rather than as own data properties. Anything holding a reference to a File would
  // otherwise be able to rewrite its metadata — React Native's `FormData` did exactly that
  // to carry the optional `append(name, value, filename)` argument, which silently renamed
  // the caller's File and leaked one entry's filename into every other entry sharing the
  // object. Our `FormData` patch keeps that filename per entry instead, see `FormData.ts`.
  // https://w3c.github.io/FileAPI/#file-attrs

  get name(): string {
    return this._name;
  }

  get lastModified(): number {
    return this._lastModified;
  }

  toString(): string {
    return '[object File]';
  }

  get [Symbol.toStringTag](): string {
    return 'File';
  }
}

/**
 * Converts a value the way WebIDL converts to `long long`, without the modulo 2^64 wrap-around:
 * `NaN` and infinities become 0, and fractions are truncated toward zero.
 * @see https://webidl.spec.whatwg.org/#es-long-long
 */
function toLongLong(value: unknown): number {
  const number = Number(value);
  // `|| 0` also turns -0 into +0, as the spec does.
  return Number.isFinite(number) ? Math.trunc(number) || 0 : 0;
}
