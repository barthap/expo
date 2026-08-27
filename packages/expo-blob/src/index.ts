// The Blob implementation lives in the `expo` package so that the winter runtime can install
// it as a global without a dependency cycle. `expo-blob` stays as a compatibility layer and
// re-exports the very same class, so `instanceof` keeps working across both import paths.
export { Blob, isBlobLike } from 'expo/blob';
export type { BlobPart } from 'expo/blob';
