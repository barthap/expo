---
"expo-file-system": minor
---

On Android and iOS, `file.slice()` no longer reads the entire file into memory. It returns a `Blob` from `expo/blob` that reads its range of the file on every read, so it can be a part of `new Blob([...])`, `FormData`, and `fetch()` without copying the file. `new Blob([file])` works in the same way for the whole file. The `size` of the `Blob` is fixed when you call `slice()`. A read sees the current content of the file: it returns fewer bytes when the file got shorter, and rejects when the file was deleted. `slice()` throws when the file does not exist or cannot be read, and when the slice is larger than 2147483647 bytes (2 GiB).
