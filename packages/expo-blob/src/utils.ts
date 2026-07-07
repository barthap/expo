/**
 * Normalizes the content type string for a `Blob`.
 *
 * Returns the lowercased content type if it is valid, or an empty string otherwise.
 *
 * A valid content type:
 *  - Is not undefined
 *  - Contains only printable ASCII characters (0x20–0x7E)
 *
 * If any of these conditions are not met, returns an empty string to indicate an invalid or unsafe content type.
 *
 * @param type The content type string to normalize.
 * @returns The normalized (lowercased) content type, or an empty string if invalid.
 */
export function normalizedContentType(type?: string): string {
  const str = '' + type;
  const asciiPrintable = /^[\x20-\x7E]+$/;
  if (type === undefined || !asciiPrintable.test(str)) return '';
  return str.toLowerCase();
}

/**
 * Checks if the given object is a JavaScript `TypedArray`.
 *
 * This function detects all standard `TypedArray` types including:
 * - `Int8Array`, `Int16Array`, `Int32Array`, `BigInt64Array`
 * - `Uint8Array`, `Uint16Array`, `Uint32Array`, `BigUint64Array`
 * - `Float32Array`, `Float64Array`
 *
 * @param obj The object to check.
 * @returns `true` if the object is a TypedArray, `false` otherwise.
 */
export function isTypedArray(obj: any): boolean {
  return (
    obj instanceof Int8Array ||
    obj instanceof Int16Array ||
    obj instanceof Int32Array ||
    obj instanceof BigInt64Array ||
    obj instanceof Uint8Array ||
    obj instanceof Uint16Array ||
    obj instanceof Uint32Array ||
    obj instanceof BigUint64Array ||
    obj instanceof Float32Array ||
    obj instanceof Float64Array
  );
}

/**
 * Processes the options object if defined and not null.
 * The function coerces `options.type` value and rest of `options` to `string` (if they are defined objects).
 * `TypeError` is thrown when the options is not an object or `options.endings` value is invalid.
 *
 * @param options The `BlobPropertyBag` object to preprocess.
 * @returns `BlobPropertyBag` object.
 */
export const preprocessOptions = (options?: BlobPropertyBag): BlobPropertyBag | undefined => {
  if (!options) return options;
  if (!(options instanceof Object)) {
    throw TypeError("The 'options' argument must be a dictionary. Received type " + typeof options);
  }

  let endings: string | undefined = options.endings;
  let type: string | undefined = options.type;
  if (endings && typeof endings === 'object') {
    endings = String(endings);
  }
  if (type && typeof type === 'object') {
    type = String(type);
  }
  if (endings !== undefined && endings !== 'native' && endings !== 'transparent') {
    throw TypeError(
      "Provided '" +
        endings +
        "' endings value is not a valid enum value of EndingType, try 'native' or 'transparent'"
    );
  }

  return {
    endings,
    type: normalizedContentType(type),
  };
};

/**
 * The default chunk size (64 kB) used for binary streaming operations.
 *
 * This value is not specified by the W3C File API specification or MDN documentation.
 * It is chosen as a widely adopted industry standard that balances performance
 * (by reducing the number of read operations) and memory usage (by avoiding excessively large buffers).
 * This value is commonly used in Node.js streams and V8 engine implementations.
 *
 * @see [Node.js commit: set default chunk size to 64kB](https://github.com/nodejs/node/commit/1abff073921bcb0631602032aef0135bccfaee0d#diff-b290649355ee6b2639720a644520e93878144584f931f60f06d5c15eecd9067fR12)
 */
export const DEFAULT_CHUNK_SIZE = 65_536;

/**
 * Checks whether the given value implements the `Blob` interface shape, without requiring
 * it to inherit from any particular `Blob` class. Matches objects like `expo-file-system`'s
 * `File`, which implement Blob methods but have their own prototype chain.
 *
 * This is the single source of truth for "Blob-like" duck-typing — keep `Blob[Symbol.hasInstance]`
 * and expo's fetch body normalization in sync through this predicate.
 *
 * @param value The value to check.
 * @returns `true` if the value is Blob-like, `false` otherwise.
 */
export function isBlobLike(value: any): boolean {
  // React Native's built-in Blob (produced by RN XHR with `responseType: 'blob'` or
  // WebSocket with `binaryType: 'blob'`) lacks `arrayBuffer()`/`text()` — its bytes live
  // in the native blob store keyed by `data.blobId` and are read through FileReader.
  // Recognize it by that shape so RN-produced blobs keep passing `instanceof Blob`.
  if (isReactNativeBlob(value)) {
    return true;
  }
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.arrayBuffer === 'function' &&
    typeof value.slice === 'function' &&
    typeof value.text === 'function' &&
    typeof value.size === 'number' &&
    // `expo-file-system`'s `File.type` is `null` when the extension maps to no known MIME type
    (typeof value.type === 'string' || value.type === null)
  );
}

/**
 * Checks whether the given value is a React Native built-in `Blob`
 * (`react-native/Libraries/Blob/Blob.js`).
 *
 * RN keeps the native handle in the `_data` own property and exposes it through a `data`
 * getter that throws once `close()` released it — as do the `size` and `type` getters, which
 * read through `data`. Since `instanceof` must never throw, the `data` read is guarded, and a
 * closed blob still counts as a Blob: releasing the bytes does not change what class the
 * object belongs to, and the web platform has no `close()` at all.
 */
function isReactNativeBlob(value: any): boolean {
  if (value == null || typeof value !== 'object' || typeof value.slice !== 'function') {
    return false;
  }
  let data: any;
  try {
    data = value.data;
  } catch {
    // The `data` getter threw, which is what RN does after `close()`. Fall back to the
    // backing field, which `close()` sets to `null` and which has no getter to throw.
    return typeof value.close === 'function' && value._data === null;
  }
  return typeof data?.blobId === 'string' && typeof value.size === 'number';
}
