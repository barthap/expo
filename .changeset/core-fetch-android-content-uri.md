---
'expo': minor
---

[Android] The global `fetch` (which is `expo/fetch` in Expo apps) now loads `content://` URIs, such as the `URL.createObjectURL` URLs of Expo's `Blob` or URIs from other apps' content providers that the app can read. A URI that cannot be opened makes `fetch` reject.
