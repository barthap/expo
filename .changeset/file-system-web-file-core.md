---
"expo-file-system": minor
---

[web] Add web support for `File` and `Directory`. `File.fromWebFile()` wraps a browser `File`. The result is also a browser `File`, so `fetch()` and `FormData` accept it. `toWebFile()` returns a plain browser `File`. `Paths.cache`, `Paths.document`, and `Paths.bundle` are placeholder directories, and members that need persistent storage throw `UnavailabilityError` on web.
