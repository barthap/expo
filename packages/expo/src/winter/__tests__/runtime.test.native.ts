// The winter runtime installs the global `Blob` lazily, so that apps opting out with
// `EXPO_PUBLIC_USE_RN_BLOB=1` (or never touching `Blob`) don't load the `ExpoBlob` native module
// at startup. Any module the runtime imports eagerly must therefore stay off `expo/blob`'s entry,
// which calls `requireNativeModule('ExpoBlob')` as soon as it is evaluated.

// jest-expo replaces `FormData` with a stub in its setup, and `FormData` is the runtime's only
// eager import of blob code, so use the real module here.
jest.unmock('../FormData');

it('does not load the ExpoBlob native module until the global Blob is read', () => {
  // The lazy install requires `expo/blob` from the isolated registry only while it is active,
  // so the global has to be read inside the callback too.
  jest.isolateModules(() => {
    // jest-environment-node gives every test file in a worker the same host `FormData` class.
    // The real `installFormDataPatch` changes the prototype of the class it gets, which would
    // break `FormData` for later test files in this worker, so hand it a throwaway class.
    const hostFormData = globalThis.FormData;
    globalThis.FormData = class FormData {} as unknown as typeof globalThis.FormData;
    try {
      const requireNativeModule = jest.spyOn(require('expo-modules-core'), 'requireNativeModule');
      expect(jest.isMockFunction(require('../FormData').installFormDataPatch)).toBe(false);

      require('../runtime');
      // `URL` and `URLSearchParams` are lazy globals too, and apps read them early in startup.
      // Read them so that `url.ts` is evaluated here and the check below also covers its imports.
      expect(globalThis.URL).toBeDefined();
      expect(globalThis.URLSearchParams).toBeDefined();
      expect(requireNativeModule).not.toHaveBeenCalledWith('ExpoBlob');
      expect(globalThis.URL).toBe(require('../url').URL);

      // Reading the global runs the lazy install, which is what loads the native module.
      expect(globalThis.Blob).toBeDefined();
      expect(requireNativeModule).toHaveBeenCalledWith('ExpoBlob');
    } finally {
      globalThis.FormData = hostFormData;
    }
  });
});
