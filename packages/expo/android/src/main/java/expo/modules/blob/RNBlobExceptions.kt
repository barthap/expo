package expo.modules.blob

import expo.modules.kotlin.exception.CodedException

internal class RNBlobModuleUnavailableException :
  CodedException("React Native's BlobModule is not available, so bytes cannot be exchanged with the React Native blob store")

internal class RNBlobResolveException(blobId: String) :
  CodedException(
    "Blob with id '$blobId' could not be resolved from the React Native blob store. " +
      "The React Native Blob may have been closed or garbage collected before the Blob was constructed"
  )

internal class RNBlobRangeException(blobId: String) :
  CodedException("The range of the React Native Blob with id '$blobId' lies outside of its bytes in the React Native blob store")
