---
"expo-file-system": minor
---

[web] Add `File.pickFileAsync()` and `File.downloadFileAsync()` on web. The picker opens the browser file dialog and must be called from a user gesture, such as a click handler, otherwise it throws an `ERR_USER_ACTIVATION` error. A second pick while one is open resolves as canceled. Downloads are kept in memory, so the location of the destination is ignored.
