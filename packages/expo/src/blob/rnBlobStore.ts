import { requireNativeModule } from 'expo-modules-core';

import type { Blob } from './ExpoBlob';
import type { ExpoBlobModule } from './ExpoBlob.types';

const NativeBlobModule = requireNativeModule<ExpoBlobModule>('ExpoBlob');

/**
 * Copies the Blob's bytes into React Native's native blob store (the store behind
 * React Native's `Blob`, `FileReader` and `blob:` URLs) and returns the assigned blob id.
 *
 * The copied bytes stay in the store until `releaseBlobFromReactNativeBlobStore` is called
 * with the returned id, even after the source Blob is garbage collected.
 * @hidden
 */
export function storeBlobInReactNativeBlobStore(blob: Blob): string {
  return NativeBlobModule.store(blob);
}

/**
 * Removes bytes registered with `storeBlobInReactNativeBlobStore` from React Native's
 * native blob store. Releasing an unknown or already released id does nothing.
 * @hidden
 */
export function releaseBlobFromReactNativeBlobStore(blobId: string): void {
  NativeBlobModule.release(blobId);
}
