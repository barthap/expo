// `URL.createObjectURL` hands Blob bytes to native consumers (such as `Image`) through React
// Native's blob store. The ExpoBlob native module, including its stand-in for that store,
// resolves to the in-memory mock in `mocks/ExpoBlob.ts`.

import { reactNativeBlobStore } from '../../../mocks/ExpoBlob';
import { Blob } from '../../blob';
import { File } from '../File';
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

// React Native resolves `blob:<id>?offset=<n>&size=<n>` by looking up `<id>` in its store.
function parseBlobUrl(url: string) {
  const match = /^blob:([^?]+)\?offset=(\d+)&size=(\d+)$/.exec(url);
  if (!match) {
    throw new Error(`Not a React Native blob URL: ${url}`);
  }
  return {
    blobId: decodeURIComponent(match[1]!),
    offset: Number(match[2]),
    size: Number(match[3]),
  };
}

describe('URL.createObjectURL with an Expo Blob', () => {
  it('returns a URL that React Native can resolve to the blob bytes', () => {
    const url = URL.createObjectURL(new Blob(['hello']));

    expect(typeof url).toBe('string');
    const { blobId, offset, size } = parseBlobUrl(url);
    expect(offset).toBe(0);
    expect(size).toBe(5);
    expect(Array.from(reactNativeBlobStore.get(blobId)!)).toEqual(
      Array.from(new TextEncoder().encode('hello'))
    );
  });

  it('supports File, which is a Blob', () => {
    const url = URL.createObjectURL(new File(['abc'], 'a.txt'));

    const { blobId, size } = parseBlobUrl(url);
    expect(size).toBe(3);
    expect(reactNativeBlobStore.has(blobId)).toBe(true);
  });

  it('supports slices, which are Blobs too', () => {
    const url = URL.createObjectURL(new Blob(['hello']).slice(1, 4));

    const { blobId, size } = parseBlobUrl(url);
    expect(size).toBe(3);
    expect(new TextDecoder().decode(reactNativeBlobStore.get(blobId))).toBe('ell');
  });

  it('gives each call its own URL, so revoking one keeps the other working', () => {
    const blob = new Blob(['hello']);
    const first = URL.createObjectURL(blob);
    const second = URL.createObjectURL(blob);
    expect(first).not.toBe(second);

    URL.revokeObjectURL(first);

    expect(reactNativeBlobStore.has(parseBlobUrl(first).blobId)).toBe(false);
    expect(reactNativeBlobStore.has(parseBlobUrl(second).blobId)).toBe(true);
  });
});

describe('URL.revokeObjectURL', () => {
  it('releases the bytes of a URL created for an Expo Blob', () => {
    const url = URL.createObjectURL(new Blob(['hello']));
    const { blobId } = parseBlobUrl(url);

    URL.revokeObjectURL(url);

    expect(reactNativeBlobStore.has(blobId)).toBe(false);
  });

  it('accepts a URL object', () => {
    const url = URL.createObjectURL(new Blob(['hello']));
    const { blobId } = parseBlobUrl(url);

    URL.revokeObjectURL(new URL(url));

    expect(reactNativeBlobStore.has(blobId)).toBe(false);
  });

  it('does nothing for unknown or already revoked URLs', () => {
    const url = URL.createObjectURL(new Blob(['hello']));
    URL.revokeObjectURL(url);

    expect(() => URL.revokeObjectURL(url)).not.toThrow();
    expect(() => URL.revokeObjectURL('blob:unknown?offset=0&size=1')).not.toThrow();
  });
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

  it('leaves React Native Blob ids to React Native when revoking', () => {
    // RN releases these ids itself; releasing them here would break the RN Blob behind the URL.
    reactNativeBlobStore.set('rn-owned-id', new Uint8Array([1, 2, 3]));
    const url = URL.createObjectURL({
      data: { blobId: 'rn-owned-id', offset: 0, size: 3 },
      size: 3,
    } as any);

    URL.revokeObjectURL(url);

    expect(reactNativeBlobStore.has('rn-owned-id')).toBe(true);
    reactNativeBlobStore.delete('rn-owned-id');
  });

  it('rejects Blob-like objects whose bytes are not in memory, with a hint', () => {
    // Shaped like expo-file-system's File: passes `instanceof Blob`, but has no bytes to copy
    const fileLike = {
      arrayBuffer: async () => new ArrayBuffer(0),
      bytes: async () => new Uint8Array(0),
      slice: () => fileLike,
      stream: () => null,
      text: async () => '',
      size: 0,
      type: 'text/plain',
    };
    expect(fileLike instanceof Blob).toBe(true);

    expect(() => URL.createObjectURL(fileLike as any)).toThrow(/arrayBuffer/);
  });
});

// On Android, the ExpoBlob module exports the authority of the `expo` package's own
// ExpoBlobProvider, which serves the store over content:// without any app manifest entry.
// The constant is read when `expo/blob` loads its native module, so these tests load fresh
// copies of the mock, `expo/blob` and `url.ts` with the constant set.
type AndroidModules = {
  URL: typeof URL;
  Blob: typeof Blob;
  store: typeof reactNativeBlobStore;
};
function withAndroidModules(
  test: (modules: AndroidModules) => void,
  reactNativeConstants: object = {
    BLOB_URI_SCHEME: 'content',
    BLOB_URI_HOST: 'dev.expo.test.blobs',
  }
) {
  const nativeModuleProxy = (globalThis as any).nativeModuleProxy;
  (globalThis as any).nativeModuleProxy = {
    BlobModule: { getConstants: () => reactNativeConstants },
  };
  try {
    jest.isolateModules(() => {
      const mock = require('../../../mocks/ExpoBlob');
      mock.blobProviderAuthority = 'dev.expo.test.ExpoBlobProvider';
      test({
        URL: (require('../url') as typeof import('../url')).URL,
        Blob: (require('../../blob') as typeof import('../../blob')).Blob,
        store: mock.reactNativeBlobStore,
      });
    });
  } finally {
    (globalThis as any).nativeModuleProxy = nativeModuleProxy;
  }
}

const CONTENT_URL = /^content:\/\/dev\.expo\.test\.ExpoBlobProvider\/([^?]+)\?offset=0&size=(\d+)$/;

describe('URL.createObjectURL with the Android content provider', () => {
  it('serves Expo Blobs from the content provider', () => {
    withAndroidModules(({ URL, Blob, store }) => {
      const url = URL.createObjectURL(new Blob(['hello']));

      const match = CONTENT_URL.exec(url);
      expect(match).not.toBeNull();
      expect(match![2]).toBe('5');
      // The provider resolves the last path segment in React Native's store
      expect(new TextDecoder().decode(store.get(decodeURIComponent(match![1]!)))).toBe('hello');
    });
  });

  it("keeps React Native's own prefix for React Native Blobs", () => {
    withAndroidModules(({ URL }) => {
      // Those ids are served by React Native's BlobProvider, which the app registered
      const url = URL.createObjectURL({
        data: { blobId: 'rn-blob-id', offset: 0, size: 3 },
        size: 3,
      } as any);

      expect(url).toBe('content://dev.expo.test.blobs/rn-blob-id?offset=0&size=3');
    });
  });

  it('revokes URLs of the content provider', () => {
    withAndroidModules(({ URL, Blob, store }) => {
      const url = URL.createObjectURL(new Blob(['hello']));
      const blobId = decodeURIComponent(CONTENT_URL.exec(url)![1]!);

      URL.revokeObjectURL(url);

      expect(store.has(blobId)).toBe(false);
    });
  });
});

describe('URL.createObjectURL without blob URL constants', () => {
  // On Android, React Native's BlobModule exports no constants unless the app registers
  // `BlobProvider` with a `blob_provider_authority` string.
  it('still serves Expo Blobs through the content provider', () => {
    withAndroidModules(({ URL, Blob }) => {
      expect(URL.createObjectURL(new Blob(['hello']))).toMatch(CONTENT_URL);
    }, {});
  });

  it('names the Android BlobProvider setup in the error for React Native Blobs', () => {
    withAndroidModules(({ URL }) => {
      const rnBlob = { data: { blobId: 'rn-blob-id', offset: 0, size: 3 }, size: 3 };
      expect(() => URL.createObjectURL(rnBlob as any)).toThrow(
        /BlobProvider.*blob_provider_authority/
      );
    }, {});
  });
});
