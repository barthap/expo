// This file configures the runtime environment to increase compatibility with WinterCG.
// https://wintercg.org/

// WARN(@kitten): We must ensure that the core react-native globals are initialized before ours
// Otherwise we're relying on `getModulesRunBeforeMainModule` which is unstable or can be missing
import './setupReactNativeEnvironment';
import '../../types';
import { installFormDataPatch } from './FormData';
import { installGlobal as install } from './installGlobal';

// https://encoding.spec.whatwg.org/#interface-textdecoderstream
install('TextDecoderStream', () => require('./TextDecoderStream').TextDecoderStream);
// https://encoding.spec.whatwg.org/#interface-textencoderstream
install('TextEncoderStream', () => require('./TextDecoderStream').TextEncoderStream);
// https://url.spec.whatwg.org/#url
install('URL', () => require('./url').URL);
// https://url.spec.whatwg.org/#urlsearchparams
install('URLSearchParams', () => require('./url').URLSearchParams);
// https://webidl.spec.whatwg.org/#idl-DOMException
install('DOMException', () => require('./DOMException').DOMException);
// https://streams.spec.whatwg.org/#rs
// ReadableStream is injected by Metro as a global

install('__ExpoImportMetaRegistry', () => require('./ImportMetaRegistry').ImportMetaRegistry);

// https://html.spec.whatwg.org/multipage/structured-data.html#structuredclone
install('structuredClone', () => require('@ungap/structured-clone').default);

installFormDataPatch(FormData);

// https://tc39.es/proposal-arraybuffer-base64/spec/
// Hermes does not ship these yet. The install keeps any of them the engine has natively, and the
// module is not loaded at all when the engine has every one.
if (
  typeof Uint8Array.fromBase64 !== 'function' ||
  typeof Uint8Array.fromHex !== 'function' ||
  typeof Uint8Array.prototype.toBase64 !== 'function' ||
  typeof Uint8Array.prototype.toHex !== 'function' ||
  typeof Uint8Array.prototype.setFromBase64 !== 'function' ||
  typeof Uint8Array.prototype.setFromHex !== 'function'
) {
  require('./Uint8ArrayBase64').installUint8ArrayBase64();
}

// Polyfill async iterator symbol for Hermes.
// @ts-expect-error: readonly property only applies when the engine supports it
Symbol.asyncIterator ??= Symbol.for('Symbol.asyncIterator');

const useRnBlob =
  process.env.EXPO_PUBLIC_USE_RN_BLOB === '1' || process.env.EXPO_PUBLIC_USE_RN_BLOB === 'true';

if (!useRnBlob) {
  // Override the global Blob with the W3C-compliant implementation from `expo/blob`, which
  // supports ArrayBuffer and TypedArray parts and the full read API (arrayBuffer, bytes,
  // text, stream).
  // https://w3c.github.io/FileAPI/#blob-section
  install('Blob', () => require('../blob').Blob);
  // The global File must extend the global Blob, so React Native's File polyfill
  // (which extends React Native's built-in Blob) is replaced together with it.
  // https://w3c.github.io/FileAPI/#file-section
  install('File', () => require('./File').File);
}

const useRnFetch =
  process.env.EXPO_PUBLIC_USE_RN_FETCH === '1' || process.env.EXPO_PUBLIC_USE_RN_FETCH === 'true';

if (!useRnFetch) {
  // Reading `Headers` triggers RN's polyfill chain, which also installs
  // `Request` and `Response`. Must run before we replace `fetch` below.
  if (!globalThis.Headers) {
    throw new Error(
      "expo/fetch expected `globalThis.Headers` to be installed by React Native's fetch polyfill."
    );
  }
  install('fetch', () => require('./fetch').fetch);
}
