---
'expo-blob': patch
---

`expo-blob` now re-exports the `Blob` implementation from the `expo` package. The package no longer ships native code, and `import { Blob } from 'expo-blob'` keeps working.
