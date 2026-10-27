import ExpoModulesCore

@ExpoModule("ExpoBlob", classes: [Blob.self])
public final class ExpoBlob: Module {
  @JS
  func store(blob: Blob) throws -> String {
    return try RNBlobStore(appContext: appContext).store(Data(try blob.bytesSync()))
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

  // A Blob with one file-backed part, which the JS constructor passes on as a Blob part.
  // The file is not read here: its bytes are read on every read of the Blob.
  @JS
  func fromFileRange(reference: FileRangeReference) throws -> Blob {
    let url = try fileUrl(fromUri: reference.uri)
    guard reference.offset >= 0, reference.size >= 0, reference.size <= Int(Int32.max) else {
      throw FileRangeInvalidRangeException(reference.uri)
    }
    return Blob(parts: [.file(url: url, offset: reference.offset, length: reference.size)], options: BlobOptions())
  }
}
