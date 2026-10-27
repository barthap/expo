---
"expo": minor
---

On Android and iOS, `Blob.stream()` reads the `Blob` in chunks of up to 64 KiB instead of loading all of it into memory first, so streaming a `Blob` backed by a file reads the file one chunk at a time.
