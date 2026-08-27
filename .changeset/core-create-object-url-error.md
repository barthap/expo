---
'expo': patch
---

`URL.createObjectURL` now throws a descriptive error for `Blob` implementations whose bytes are not in react-native's blob store, instead of crashing on an internal field access.
