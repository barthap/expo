import ExpoModulesCore

enum BlobPart {
  case string(String)
  case blob(Blob)
  case data(Data)

  func size() -> Int {
    switch self {
    case .string(let str):
      return str.lengthOfBytes(using: .utf8)
    case .data(let data):
      return data.count
    case .blob(let blob):
      return blob.size
    }
  }

  func bytes() async -> [UInt8] {
    return bytesSync()
  }

  /// All part kinds hold their bytes in memory, so they can also be read synchronously.
  func bytesSync() -> [UInt8] {
    switch self {
    case .string(let str):
      return [UInt8](str.utf8)
    case .data(let data):
      return [UInt8](data)
    case .blob(let blob):
      return blob.bytesSync()
    }
  }
}
