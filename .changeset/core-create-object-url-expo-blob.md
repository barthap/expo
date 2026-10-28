---
'expo': minor
---

`URL.createObjectURL` now works with Expo's `Blob` and `File` on Android and iOS. The bytes stay registered in React Native's blob store until `URL.revokeObjectURL` is called. On Android, URLs of React Native's own `Blob` still need React Native's `BlobProvider` with a `blob_provider_authority` string in the app manifest (see the `URL.createObjectURL` docs).
