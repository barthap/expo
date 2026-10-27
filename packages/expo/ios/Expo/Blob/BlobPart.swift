import ExpoModulesCore

enum BlobPart {
  case string(String)
  case blob(Blob)
  case data(Data)
  /**
   A byte range of a file. Its bytes are not held in memory: they are read from the file on every read.
   */
  case file(url: URL, offset: Int, length: Int)

  func size() -> Int {
    switch self {
    case .string(let str):
      return str.utf8.count
    case .data(let data):
      return data.count
    case .blob(let blob):
      return blob.size
    case .file(_, _, let length):
      return length
    }
  }

  /// The number of bytes the part holds in memory. File parts hold none.
  func inMemorySize() -> Int {
    switch self {
    case .blob(let blob):
      return blob.inMemorySize
    case .file:
      return 0
    default:
      return size()
    }
  }

  func bytes() async throws -> [UInt8] {
    return try bytesSync()
  }

  /// In-memory parts are copied. File parts read the file, which throws when it is missing or unreadable.
  func bytesSync() throws -> [UInt8] {
    switch self {
    case .string(let str):
      return [UInt8](str.utf8)
    case .data(let data):
      return [UInt8](data)
    case .blob(let blob):
      return try blob.bytesSync()
    case .file(let url, let offset, let length):
      return [UInt8](try readFileRange(url: url, offset: offset, length: length))
    }
  }
}
