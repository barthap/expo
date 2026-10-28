---
'expo': minor
---

`URL.createObjectURL` URLs of Expo's `Blob` now work outside React Native's networking. On Android, they are `content://` URIs served by a content provider of the `expo` package, so they need no `BlobProvider` entry in the app manifest, and other apps can read them when the app grants access. On iOS, the global `fetch` (which is `expo/fetch` in Expo apps) and `URLSession.shared` load the `blob:` URLs. The bytes are copied when the URL is created (a file-backed `Blob` is read at that point), stay in memory until `URL.revokeObjectURL` is called, and are gone after the app restarts. Each file part is limited to 2 GiB.
