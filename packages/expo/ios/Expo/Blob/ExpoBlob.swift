import ExpoModulesCore

@ExpoModule("ExpoBlob", classes: [Blob.self])
public final class ExpoBlob: Module {
  @JS
  func store(blob: Blob) throws -> String {
    return try RNBlobStore(appContext: appContext).store(Data(blob.bytesSync()))
  }

  @JS
  func release(blobId: String) throws {
    try RNBlobStore(appContext: appContext).remove(blobId: blobId)
  }

  // A Blob with a copy of the bytes of a React Native Blob, which the JS constructor passes on as a Blob part.
  // A separate function, because on Android a record cannot be a constructor part next to typed arrays.
  @JS
  func fromReactNativeBlob(reference: RNBlobReference) throws -> Blob {
    let data = try RNBlobStore(appContext: appContext).resolve(reference)
    return Blob(parts: [.data(data)], options: BlobOptions())
  }
}
