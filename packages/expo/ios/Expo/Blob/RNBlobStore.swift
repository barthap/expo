import ExpoModulesCore

internal final class RNBlobModuleUnavailableException: Exception {
  override var reason: String {
    "React Native's BlobModule is not available, so bytes cannot be exchanged with the React Native blob store"
  }
}

internal final class RNBlobStoreException: Exception {
  override var reason: String {
    "React Native's BlobModule failed to store the Blob's bytes in the React Native blob store"
  }
}

internal final class RNBlobResolveException: GenericException<String> {
  override var reason: String {
    "Blob with id '\(param)' could not be resolved from the React Native blob store. "
      + "The React Native Blob may have been closed or garbage collected before the Blob was constructed"
  }
}

internal final class RNBlobRangeException: GenericException<String> {
  override var reason: String {
    "The range of the React Native Blob with id '\(param)' lies outside of its bytes in the React Native blob store"
  }
}

/// Points at bytes in React Native's blob store. Mirrors the `data` property of React Native's JS `Blob`.
@Record
internal struct RNBlobReference {
  var blobId: String = ""
  var offset: Int = 0
  var size: Int = 0
}

/// Thin wrapper around React Native's `RCTBlobManager`. It is reached through the app context
/// and called with selectors, so that the `expo` package does not link against React Native.
/// `RCTBlobManager` guards its storage with a mutex, so these calls are safe from any thread.
internal struct RNBlobStore {
  private let blobManager: NSObject

  init(appContext: AppContext?) throws {
    guard let blobManager: NSObject = appContext?.nativeModule(named: "BlobModule") else {
      throw RNBlobModuleUnavailableException()
    }
    self.blobManager = blobManager
  }

  /// Registers a copy of the given bytes in the store and returns the assigned blob id.
  /// The bytes stay in the store until `remove(blobId:)` is called.
  func store(_ data: Data) throws -> String {
    // - (NSString *)store:(NSData *)data;
    let selector = NSSelectorFromString("store:")
    guard blobManager.responds(to: selector),
      let blobId = blobManager.perform(selector, with: data as NSData)?.takeUnretainedValue() as? String
    else {
      throw RNBlobStoreException()
    }
    return blobId
  }

  /// Returns a copy of the referenced bytes, so they stay valid after the entry is removed from the store.
  func resolve(_ reference: RNBlobReference) throws -> Data {
    // - (NSData *)resolve:(NSDictionary<NSString *, id> *)blob;
    // Without `offset` and `size` it returns the whole entry. The range is cut here instead,
    // because React Native's `subdataWithRange:` raises an exception Swift cannot catch for a range out of bounds.
    let selector = NSSelectorFromString("resolve:")
    let blobDictionary: NSDictionary = ["blobId": reference.blobId]
    guard blobManager.responds(to: selector),
      let data = blobManager.perform(selector, with: blobDictionary)?.takeUnretainedValue() as? Data
    else {
      throw RNBlobResolveException(reference.blobId)
    }
    let start = reference.offset
    let end = start + reference.size
    guard start >= 0, reference.size >= 0, end <= data.count else {
      throw RNBlobRangeException(reference.blobId)
    }
    return Data(data[start..<end])
  }

  /// Removes the bytes registered under the given blob id. Removing an unknown id is a no-op.
  func remove(blobId: String) throws {
    // - (void)remove:(NSString *)blobId;
    let selector = NSSelectorFromString("remove:")
    guard blobManager.responds(to: selector) else {
      throw RNBlobModuleUnavailableException()
    }
    _ = blobManager.perform(selector, with: blobId as NSString)
  }
}
