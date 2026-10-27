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
}
