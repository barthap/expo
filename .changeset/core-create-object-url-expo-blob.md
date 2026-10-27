---
'expo': minor
---

`URL.createObjectURL` now works with Expo's `Blob` and `File` on Android and iOS. The bytes stay registered in React Native's blob store until `URL.revokeObjectURL` is called. On Android, the app must register React Native's `BlobProvider` with a `blob_provider_authority` string (see the `URL.createObjectURL` docs), otherwise React Native exports no `blob:`/`content:` URI constants.
