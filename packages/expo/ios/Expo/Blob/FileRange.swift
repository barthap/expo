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

internal final class BlobWriteUnsupportedUriException: GenericException<String> {
  override var reason: String {
    "A Blob can be written only to a file:// URI, but received '\(param)'"
  }
}

internal final class BlobWriteException: GenericException<String> {
  override var reason: String {
    "Unable to write the Blob to '\(param)'"
  }
}

// The largest number of bytes held in memory at once when a file-backed part is copied to a file
private let fileCopyChunkSize = 1024 * 1024

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

/// Copies up to `length` bytes of the file at `url`, starting at `offset`, to `output` in chunks of
/// at most 1 MiB, so the range is never held in memory at once. Like `readFileRange`, fewer bytes are
/// copied when the file is now shorter than the range, and a missing or unreadable file throws.
internal func copyFileRange(url: URL, offset: Int, length: Int, to output: FileHandle) throws {
  let source: FileHandle
  do {
    source = try FileHandle(forReadingFrom: url)
  } catch {
    throw FileRangeReadException(url.absoluteString).causedBy(error)
  }
  defer {
    try? source.close()
  }
  do {
    try source.seek(toOffset: UInt64(offset))
  } catch {
    throw FileRangeReadException(url.absoluteString).causedBy(error)
  }
  var remaining = length
  while remaining > 0 {
    // Drains the autoreleased buffers of every chunk, so a large copy does not pile them up
    let copied: Int = try autoreleasepool {
      let chunk: Data
      do {
        chunk = try source.read(upToCount: min(remaining, fileCopyChunkSize)) ?? Data()
      } catch {
        throw FileRangeReadException(url.absoluteString).causedBy(error)
      }
      try output.write(contentsOf: chunk)
      return chunk.count
    }
    if copied == 0 {
      break
    }
    remaining -= copied
  }
}
