import ExpoModulesCore

/**
 Loads URLs the way native code outside of React Native does, so test-suite can check that
 `URL.createObjectURL` URLs work there.
 */
public final class BlobUrlTesterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BlobUrlTester")

    // Reads the URL with `URLSession.shared`, like a native library would.
    AsyncFunction("readWithSharedURLSession") { (url: URL) async throws -> Data in
      let (data, _) = try await URLSession.shared.data(from: url)
      return data
    }
  }
}
