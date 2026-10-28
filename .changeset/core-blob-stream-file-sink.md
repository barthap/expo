---
"expo": patch
---

On Android and iOS, piping `blob.stream()` into `File.writableStream()` from `expo-file-system` copies the `Blob` to the file natively instead of moving every chunk through JavaScript. The file gets the same bytes as `blob.bytes()`. A pipe with `preventClose`, `preventAbort`, `preventCancel`, or `signal`, a stream that was already read or written to, and `pipeThrough()` still go through JavaScript.
