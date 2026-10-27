import { reactNativeBlobStore } from '../../../mocks/ExpoBlob';
import {
  Blob,
  releaseBlobFromReactNativeBlobStore,
  storeBlobInReactNativeBlobStore,
} from '../index';

// `URL.createObjectURL` builds on these helpers: the id must point at the Blob's bytes in
// React Native's store for as long as the URL lives, and revoking must be safe to repeat.
describe('React Native blob store helpers', () => {
  it('registers the blob bytes under a new id', () => {
    const blob = new Blob(['hello']);

    const blobId = storeBlobInReactNativeBlobStore(blob);

    expect(typeof blobId).toBe('string');
    expect(Array.from(reactNativeBlobStore.get(blobId)!)).toEqual(
      Array.from(new TextEncoder().encode('hello'))
    );
  });

  it('gives each stored blob its own id', () => {
    const blob = new Blob(['hello']);
    expect(storeBlobInReactNativeBlobStore(blob)).not.toBe(storeBlobInReactNativeBlobStore(blob));
  });

  it('removes the bytes on release', () => {
    const blobId = storeBlobInReactNativeBlobStore(new Blob(['hello']));

    releaseBlobFromReactNativeBlobStore(blobId);

    expect(reactNativeBlobStore.has(blobId)).toBe(false);
  });

  it('does not throw when releasing an unknown or already released id', () => {
    const blobId = storeBlobInReactNativeBlobStore(new Blob(['hello']));
    releaseBlobFromReactNativeBlobStore(blobId);

    expect(() => releaseBlobFromReactNativeBlobStore(blobId)).not.toThrow();
    expect(() => releaseBlobFromReactNativeBlobStore('unknown-id')).not.toThrow();
  });
});
