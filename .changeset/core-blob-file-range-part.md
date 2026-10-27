---
"expo": minor
---

On Android and iOS, `new Blob([...])` accepts a `File` from `expo-file-system` as a part without copying the file into memory. The `Blob` holds a byte range of the file and reads it on every read: its `size` is fixed when the `Blob` is created, a read returns fewer bytes when the file got shorter in the meantime, and rejects when the file was deleted. A file range can be at most 2147483647 bytes (2 GiB) long.
