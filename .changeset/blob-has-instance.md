---
'expo-blob': minor
---

Added `Symbol.hasInstance` to `Blob` so `instanceof Blob` also matches duck-typed Blob-like objects, such as `expo-file-system`'s `File`.
