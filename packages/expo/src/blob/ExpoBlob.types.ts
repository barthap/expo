import type { NativeModule, SharedObject } from 'expo-modules-core';

export declare class Blob {
  /**
   * The size of the `Blob` in bytes.
   */
  readonly size: number;
  /**
   * The MIME type of the `Blob`, or the empty string if the type cannot be determined.
   */
  readonly type: string;

  /**
   * Creates a new `Blob` object from the given parts and options.
   *
   * On Android and iOS, a `File` from `expo-file-system` can also be a part. Its bytes are not
   * copied: the `Blob` reads them from the file every time it is read.
   * @param blobParts An array of `BlobPart` to include in the `Blob`.
   * @param options An optional `BlobPropertyBag` dictionary.
   */
  constructor(blobParts?: BlobPart[], options?: BlobPropertyBag);

  /**
   * @param start The starting byte index (inclusive) represented as a signed 32 bit integer (up to 2^31 - 1).
   * @param end The ending byte index (exclusive) represented as a signed 32 bit integer (up to 2^31 - 1).
   * @param contentType The MIME type of the new `Blob`. If not provided, defaults to an empty string.
   * @returns A new `Blob` object containing the data in the specified range of bytes of the source `Blob`.
   */
  slice(start?: number, end?: number, contentType?: string): Blob;

  /**
   * @returns Promise resolving to the `Blob`'s binary data as a `Uint8Array`.
   */
  bytes(): Promise<Uint8Array<ArrayBuffer>>;

  /**
   * @returns Promise that resolves with the entire contents of the `Blob` as a UTF-8 string.
   */
  text(): Promise<string>;
  /**
   * Reads the `Blob` in chunks of up to 64 KiB, or up to the size of the view for a BYOB reader,
   * so a `Blob` that reads from a file, such as the result of `File.slice()` from
   * `expo-file-system`, is not loaded into memory all at once.
   * @returns A `ReadableStream` of the `Blob`'s data.
   */
  stream(): ReadableStream;

  /**
   * @returns Promise resolving to the `Blob`'s binary data as an `ArrayBuffer`.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * @hidden
 * @private
 */
export declare class NativeBlob extends SharedObject {
  readonly size: number;
  readonly type: string;

  constructor(blobParts?: (BlobPart | NativeBlob)[], options?: BlobPropertyBag);

  slice(start?: number, end?: number, contentType?: string): Blob;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  text(): Promise<string>;
}

/**
 * Points at bytes in React Native's native blob store. Mirrors the `data` property of
 * React Native's built-in `Blob`.
 * @hidden
 * @private
 */
export type ReactNativeBlobReference = {
  blobId: string;
  offset: number;
  size: number;
};

/**
 * Points at a byte range of a file, for a Blob part whose bytes are read from the file on every
 * read. `uri` is a `file://` URI, or a `content://` URI on Android.
 * @hidden
 * @private
 */
export type FileRangeReference = {
  uri: string;
  offset: number;
  size: number;
};

/**
 * Marks a `WritableStream` that writes to a file from its start, such as the result of
 * `File.writableStream()` from `expo-file-system`, so that piping `Blob.stream()` into it can copy the
 * Blob to the file natively. `uri` is the URI of the file. `offset` returns the position the stream
 * writes its next chunk at, or `null` when it is unknown, and never throws.
 * @hidden
 * @private
 */
export type FileSinkReference = {
  uri: string;
  offset: () => number | null;
};

/**
 * @hidden
 * @private
 */
export declare class ExpoBlobModule extends NativeModule {
  Blob: typeof NativeBlob;
  /**
   * Copies the Blob's bytes into React Native's native blob store and returns the assigned blob id.
   */
  store(blob: NativeBlob): string;
  /**
   * Removes bytes registered with `store` from React Native's native blob store.
   */
  release(blobId: string): void;
  /**
   * Creates a Blob with a copy of the referenced bytes from React Native's native blob store.
   */
  fromReactNativeBlob(reference: ReactNativeBlobReference): NativeBlob;
  /**
   * Creates a Blob with one part that reads the referenced range of a file on every read.
   */
  fromFileRange(reference: FileRangeReference): NativeBlob;
  /**
   * Writes the Blob to the existing file at the `file://` URI from its start, without truncating it.
   */
  writeToFile(blob: NativeBlob, uri: string): Promise<void>;
}

/**
 * Represents a part of a `Blob`. Can be a `string`, `ArrayBuffer`, `ArrayBufferView`, or another `Blob`.
 */
export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;
