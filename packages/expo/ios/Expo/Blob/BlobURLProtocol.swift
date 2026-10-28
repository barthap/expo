// Copyright 2015-present 650 Industries. All rights reserved.

import ExpoModulesCore
import Foundation

/// Serves `blob:<id>?offset=<n>&size=<n>` URLs, which `URL.createObjectURL` returns, to `URLSession`
/// from React Native's blob store. React Native resolves these URLs only in its own networking
/// and `Image`; this protocol makes them work in `fetch` and any `URLSession.shared` request.
internal final class BlobURLProtocol: URLProtocol, @unchecked Sendable {
  // The app context of the running React instance. `URLSession` creates the protocol
  // instances itself, so they cannot get it from a module.
  // One per process: the last `ExpoBlob.didCreate()` wins, and a reload installs the new context again.
  nonisolated(unsafe) private static weak var appContext: AppContext?
  nonisolated(unsafe) private static var isRegistered = false
  private static let lock = NSLock()

  /// Points the protocol at the blob store of the given app context, and registers it for
  /// `URLSession.shared` once per process.
  static func install(appContext: AppContext?) {
    lock.lock()
    defer { lock.unlock() }
    self.appContext = appContext
    if !isRegistered {
      URLProtocol.registerClass(BlobURLProtocol.self)
      isRegistered = true
    }
  }

  // MARK: URLProtocol

  override class func canInit(with request: URLRequest) -> Bool {
    return request.url?.scheme?.caseInsensitiveCompare("blob") == .orderedSame
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    return request
  }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let data: Data
    do {
      data = try Self.resolve(url: url)
    } catch {
      // The id is not in the store, for example after `URL.revokeObjectURL`, or the range is invalid
      client?.urlProtocol(
        self,
        didFailWithError: URLError(
          .fileDoesNotExist,
          userInfo: [
            NSURLErrorFailingURLErrorKey: url,
            NSLocalizedDescriptionKey: "The blob URL does not point at any stored bytes",
          ]
        )
      )
      return
    }
    // The store keeps only the bytes, so the Blob's type is not known here.
    let response = URLResponse(url: url, mimeType: nil, expectedContentLength: data.count, textEncodingName: nil)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {
    // The bytes are delivered at once in `startLoading`, so there is nothing to cancel.
  }

  private static func resolve(url: URL) throws -> Data {
    lock.lock()
    let appContext = self.appContext
    lock.unlock()

    // Parsed like `RCTBlobManager resolveURL:`, but the range is checked in Swift instead of raising an exception.
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), !components.path.isEmpty else {
      throw URLError(.badURL)
    }
    var offset = 0
    var size: Int?
    for item in components.queryItems ?? [] {
      if item.name == "offset" {
        offset = Int(item.value ?? "") ?? -1
      } else if item.name == "size" {
        size = Int(item.value ?? "") ?? -1
      }
    }
    return try RNBlobStore(appContext: appContext).resolve(blobId: components.path, offset: offset, size: size)
  }
}
