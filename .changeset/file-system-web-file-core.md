---
"expo-file-system": minor
---

[web] Add web support for `File` and `Directory`. `File.fromWebFile()` wraps a browser `File`. The result is also a browser `File`, so `fetch()` and `FormData` accept it. `toWebFile()` returns a plain browser `File`. Files and directories in `Paths.cache` and `Paths.document` are stored in the Origin Private File System (OPFS): call `await Paths.ready()` before reading their sync members such as `exists`, `size`, and `list()`, and use `createAsync()` and `deleteAsync()` instead of `create()` and `delete()`. `write()`, `copy()`, `move()`, and `File.downloadFileAsync()` write there. `Paths.bundle` is a placeholder directory, and other members that need a file system throw `UnavailabilityError` on web. `file:` URIs are cleaned up like on Android and iOS: `file:/a` and `file://localhost/a` become `file:///a`, `.` and `..` are resolved, a `File` URI loses its trailing slash and a `Directory` URI gains one.

Add `File.createAsync()`, `File.deleteAsync()`, `Directory.createAsync()`, `Directory.deleteAsync()`, `Directory.createFileAsync()`, `Directory.createDirectoryAsync()`, and `Paths.ready()` on all platforms. On Android, iOS, and tvOS, the `*Async` methods call the sync ones and `Paths.ready()` resolves at once, so the same code can `await` them on every platform.
