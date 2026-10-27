import { UnavailabilityError } from 'expo-modules-core';

// React Native's native blob store does not exist on web.

export function storeBlobInReactNativeBlobStore(_blob: Blob): string {
  throw new UnavailabilityError('ExpoBlob', 'storeBlobInReactNativeBlobStore');
}

export function releaseBlobFromReactNativeBlobStore(_blobId: string): void {
  throw new UnavailabilityError('ExpoBlob', 'releaseBlobFromReactNativeBlobStore');
}
