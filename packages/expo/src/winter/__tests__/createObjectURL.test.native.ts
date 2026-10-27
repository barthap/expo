// `URL.createObjectURL` hands Blob bytes to native consumers (such as `Image`) through React
// Native's blob store. The ExpoBlob native module, including its stand-in for that store,
// resolves to the in-memory mock in `mocks/ExpoBlob.ts`.

import { reactNativeBlobStore } from '../../../mocks/ExpoBlob';
import { URL } from '../url';

beforeAll(() => {
  // React Native's BlobModule as bridgeless mode exposes it (only through `nativeModuleProxy`,
  // there is no `__turboModuleProxy`), with the constants it has on iOS
  (globalThis as any).RN$Bridgeless = true;
  delete (globalThis as any).__turboModuleProxy;
  (globalThis as any).nativeModuleProxy = {
    BlobModule: { getConstants: () => ({ BLOB_URI_SCHEME: 'blob', BLOB_URI_HOST: null }) },
  };
});

describe('URL.createObjectURL with other Blobs', () => {
  it('keeps serving React Native Blobs from their own store entry', () => {
    const rnBlob = { data: { blobId: 'rn-blob-id', offset: 2, size: 3 }, size: 3 };
    const storeSize = reactNativeBlobStore.size;

    const url = URL.createObjectURL(rnBlob as any);

    expect(url).toBe('blob:rn-blob-id?offset=2&size=3');
    // No copy: the URL points at the bytes React Native already holds.
    expect(reactNativeBlobStore.size).toBe(storeSize);
  });
});
