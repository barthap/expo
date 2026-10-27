---
'expo': minor
---

`new Blob([...])` now accepts React Native's built-in `Blob` (for example an `XMLHttpRequest` response with `responseType: 'blob'`) as a part on Android and iOS. The bytes are copied out of React Native's blob store when the `Blob` is constructed.
