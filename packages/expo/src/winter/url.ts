/**
 * Copyright © 2023-present 650 Industries, Inc. (aka Expo)
 * Copyright © Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// This file should not import `react-native` in order to remain self-contained.

import { URL, URLSearchParams } from 'whatwg-url-minimum';

declare namespace globalThis {
  const RN$Bridgeless: undefined | boolean;
  const nativeModuleProxy: undefined | Record<string, unknown>;
  const __turboModuleProxy: undefined | ((name: string) => unknown);
}

// TODO(@kitten): Provide BlobModule types matching native module
interface NativeBlobModule {
  BLOB_URI_SCHEME: string;
  BLOB_URI_HOST: string;
}
interface TurboBlobModule {
  getConstants(): {
    BLOB_URI_SCHEME: string;
    BLOB_URI_HOST: string;
  };
}

let isSetup = false;
let BLOB_URL_PREFIX: string | null = null;

function getBlobUrlPrefix() {
  if (isSetup) return BLOB_URL_PREFIX;
  isSetup = true;
  // if iOS: let BLOB_URL_PREFIX = 'blob:'

  // Pull the blob module without importing React Native, the same way `TurboModuleRegistry` does:
  // `__turboModuleProxy` only exists with the legacy bridge, while bridgeless mode exposes all
  // modules through `nativeModuleProxy`.
  const BlobModule = (globalThis.__turboModuleProxy?.('BlobModule') ??
    globalThis.nativeModuleProxy?.['BlobModule']) as NativeBlobModule | TurboBlobModule | undefined;
  if (BlobModule == null) {
    return BLOB_URL_PREFIX;
  }

  const constants =
    typeof (BlobModule as TurboBlobModule).getConstants === 'function'
      ? (BlobModule as TurboBlobModule).getConstants()
      : (BlobModule as NativeBlobModule);

  if (constants && typeof constants.BLOB_URI_SCHEME === 'string') {
    BLOB_URL_PREFIX = encodeURIComponent(constants.BLOB_URI_SCHEME) + ':';
    if (typeof constants.BLOB_URI_HOST === 'string') {
      BLOB_URL_PREFIX += `//${encodeURIComponent(constants.BLOB_URI_HOST)}/`;
    }
  }
  return BLOB_URL_PREFIX;
}

declare module 'whatwg-url-minimum' {
  // TODO(@kitten): Clarify where this came from
  type BlobLike = Blob & { data?: { blobId: string; offset: number } };

  interface URLConstructor {
    createObjectURL(blob: BlobLike): string;
    revokeObjectURL(url: string | URL): void;
  }
}

// Maps each URL created for an expo `Blob` to the React Native blob store id that backs it,
// so `revokeObjectURL` can release the bytes. RN-created URLs are never added here: RN owns
// those ids and releases them through its own `Blob.close()` / garbage collection.
const expoBlobUrls = new Map<string, string>();

/**
 * Creates a `blob:` URL that serves the bytes of the given `Blob`, for example as an `Image` source.
 *
 * React Native's own `Blob` (such as the response of `XMLHttpRequest` with `responseType = 'blob'`)
 * is served from React Native's native blob store as before. For Expo's `Blob` and `File`, the bytes
 * are copied into that store and stay there until `URL.revokeObjectURL` is called with the returned
 * URL, even after the `Blob` itself is garbage collected. Like on the web, a URL that is never
 * revoked keeps its bytes in memory for the lifetime of the app.
 *
 * Other Blob-like objects, such as expo-file-system's `File`, are not supported and throw an error.
 *
 * On Android, React Native serves these URLs as `content://` URIs through its `BlobProvider`.
 * To allow Blobs be accessed via `content://` URIs,
 * you need to register `BlobProvider` as a ContentProvider in your app's `AndroidManifest.xml`:
 *
 * ```xml
 * <manifest>
 *   <application>
 *     <provider
 *       android:name="com.facebook.react.modules.blob.BlobProvider"
 *       android:authorities="@string/blob_provider_authority"
 *       android:exported="false"
 *     />
 *   </application>
 * </manifest>
 * ```
 * And then define the `blob_provider_authority` string in `res/values/strings.xml`.
 * Use a dotted name that's entirely unique to your app:
 *
 * ```xml
 * <resources>
 *   <string name="blob_provider_authority">your.app.package.blobs</string>
 * </resources>
 * ```
 */
URL.createObjectURL = function createObjectURL(
  blob: Blob & { data?: { blobId: string; offset: number } }
) {
  const prefix = getBlobUrlPrefix();
  if (prefix == null) {
    // React Native's BlobModule exports no URL scheme. On Android, it exports one only when the
    // app registers `BlobProvider`, see the docs above.
    throw new Error(
      'Cannot create URL for blob, because React Native exports no blob URL scheme. On Android, ' +
        "register React Native's BlobProvider in AndroidManifest.xml and define the " +
        'blob_provider_authority string resource.'
    );
  }
  // React Native's built-in Blob: its bytes are already in the native blob store.
  if (blob?.data?.blobId != null) {
    return `${prefix}${encodeURIComponent(blob.data.blobId)}?offset=${encodeURIComponent(
      blob.data.offset
    )}&size=${encodeURIComponent(blob.size)}`;
  }
  // Required lazily: `expo/blob` loads the `ExpoBlob` native module as soon as it is evaluated,
  // and this module is evaluated as soon as anything reads the global `URL`.
  const { Blob: ExpoBlob, storeBlobInReactNativeBlobStore } =
    require('../blob') as typeof import('../blob');
  // Prototype chain check instead of `instanceof`: `ExpoBlob[Symbol.hasInstance]` also matches
  // duck-typed Blob-likes, whose bytes cannot be copied into the store synchronously.
  if (Object.prototype.isPrototypeOf.call(ExpoBlob.prototype, blob)) {
    // Build the URL from the id instead of wrapping it in React Native's `Blob`: that wrapper
    // removes the id from the store when it is garbage collected, which would revoke the URL.
    const blobId = storeBlobInReactNativeBlobStore(blob as InstanceType<typeof ExpoBlob>);
    const url = `${prefix}${encodeURIComponent(blobId)}?offset=0&size=${encodeURIComponent(
      blob.size
    )}`;
    expoBlobUrls.set(url, blobId);
    return url;
  }
  throw new Error(
    'URL.createObjectURL is not supported for this Blob implementation, because its ' +
      'bytes are not registered in the native blob store that serves blob: URLs. ' +
      'Read the data directly instead (e.g. `await blob.arrayBuffer()`), or write it ' +
      'to a file with expo-file-system and use the file URI.'
  );
};

/**
 * Releases the bytes behind a URL created by `URL.createObjectURL` for Expo's `Blob` or `File`.
 * After that, loading the URL fails.
 *
 * Revoking an unknown or already revoked URL does nothing, like on the web. This includes URLs
 * created for React Native's own `Blob`, whose bytes React Native releases when that `Blob` is
 * closed or garbage collected.
 */
URL.revokeObjectURL = function revokeObjectURL(url) {
  const key = String(url);
  const blobId = expoBlobUrls.get(key);
  if (blobId == null) {
    return;
  }
  expoBlobUrls.delete(key);
  const { releaseBlobFromReactNativeBlobStore } = require('../blob') as typeof import('../blob');
  releaseBlobFromReactNativeBlobStore(blobId);
};

export { URL, URLSearchParams };
