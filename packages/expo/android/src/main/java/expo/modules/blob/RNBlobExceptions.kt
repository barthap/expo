package expo.modules.blob

import expo.modules.kotlin.exception.CodedException

internal class RNBlobModuleUnavailableException :
  CodedException("React Native's BlobModule is not available, so the Blob's bytes cannot be registered in the React Native blob store")
