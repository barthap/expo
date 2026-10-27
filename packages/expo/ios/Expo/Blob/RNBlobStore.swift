import ExpoModulesCore

internal final class RNBlobModuleUnavailableException: Exception {
  override var reason: String {
    "React Native's BlobModule is not available, so the Blob's bytes cannot be registered in the React Native blob store"
  }
}

internal final class RNBlobStoreException: Exception {
  override var reason: String {
    "React Native's BlobModule failed to store the Blob's bytes in the React Native blob store"
  }
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
