---
"expo-file-system": patch
---

On Android and iOS, piping a `Blob` into `File.writableStream()` now copies natively.
