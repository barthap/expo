---
"expo": patch
---

Type `Blob.bytes()` as `Promise<Uint8Array<ArrayBuffer>>`, like the DOM `Blob`, so a `Blob` from `expo/blob` can be passed where TypeScript expects the DOM `Blob` type.
