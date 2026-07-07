---
'expo-blob': patch
---

Throw a descriptive `TypeError` when a duck-typed Blob-like object is passed to the `Blob` constructor, instead of silently stringifying it to `"[object Object]"`.
