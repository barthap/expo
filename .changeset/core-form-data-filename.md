---
'expo': patch
---

`FormData.append(name, value, filename)` now keeps the filename on the entry instead of writing it onto the value, so appending the same `File` twice no longer renames it or reuses one filename for every entry.
