import ExpoModulesCore
import Foundation

internal final class FileRangeUnsupportedUriException: GenericException<String> {
  override var reason: String {
    "A file-backed Blob part needs a valid file:// URI, but received '\(param)'"
  }
}

internal final class FileRangeInvalidRangeException: GenericException<String> {
  override var reason: String {
    "The range of the file-backed Blob part for '\(param)' is invalid: "
      + "the offset and size must be non-negative and the size must not exceed 2147483647 bytes"
  }
}

internal final class FileRangeReadException: GenericException<String> {
  override var reason: String {
    "Unable to read the file-backed Blob part from '\(param)'. The file may have been deleted or moved"
  }
}

/// Points at a byte range of a file. Built by `expo-file-system` for `File` and `File.slice()`.
@Record
internal struct FileRangeReference {
  var uri: String = ""
  var offset: Int = 0
  var size: Int = 0
}

/// Resolves the URI of a file-backed Blob part to a file URL. Only `file://` URIs are supported.
internal func fileUrl(fromUri uri: String) throws -> URL {
  guard let url = URL(string: uri), url.isFileURL else {
    throw FileRangeUnsupportedUriException(uri)
  }
  return url
}

/// Reads up to `length` bytes of the file at `url`, starting at `offset`. The file is read as it is
/// at the time of the call: fewer bytes are returned when the file is now shorter than the range,
/// and a missing or unreadable file throws.
internal func readFileRange(url: URL, offset: Int, length: Int) throws -> Data {
  do {
    let handle = try FileHandle(forReadingFrom: url)
    defer {
      try? handle.close()
    }
    try handle.seek(toOffset: UInt64(offset))
    return try handle.read(upToCount: length) ?? Data()
  } catch {
    throw FileRangeReadException(url.absoluteString).causedBy(error)
  }
}
