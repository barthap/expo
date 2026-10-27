package expo.modules.blob

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel

internal class FileRangeUnsupportedUriException(uri: String) :
  CodedException("A file-backed Blob part supports only file:// and content:// URIs, but received '$uri'")

internal class FileRangeInvalidRangeException(uri: String) :
  CodedException(
    "The range of the file-backed Blob part for '$uri' is invalid: " +
      "the offset and size must be non-negative and the size must not exceed 2147483647 bytes"
  )

internal class BlobTooLargeException :
  CodedException("A Blob can hold at most 2147483647 bytes, but the sizes of its parts add up to more")

internal class FileRangeReadException(uri: Uri, cause: Throwable?) :
  CodedException("Unable to read the file-backed Blob part from '$uri'. The file may have been deleted or moved", cause)

/**
 * Points at a byte range of a file. Built by `expo-file-system` for `File` and `File.slice()`.
 */
@OptimizedRecord
internal class FileRangeReference : Record {
  @Field
  val uri: String = ""

  @Field
  val offset: Long = 0

  @Field
  val size: Long = 0
}

/**
 * Resolves the URI of a file-backed Blob part. Only `file://` and `content://` URIs are supported.
 */
internal fun fileUri(fromUri: String): Uri {
  val uri = Uri.parse(fromUri)
  if ((uri.scheme != ContentResolver.SCHEME_FILE || uri.path == null) && uri.scheme != ContentResolver.SCHEME_CONTENT) {
    throw FileRangeUnsupportedUriException(fromUri)
  }
  return uri
}

/**
 * Opens a channel for reading the file at `uri`: a `file://` path directly, a `content://` URI through
 * the content resolver. The caller closes the channel.
 */
internal fun openFileChannel(uri: Uri, contentResolver: ContentResolver): FileChannel {
  if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
    val descriptor = contentResolver.openFileDescriptor(uri, "r")
      ?: throw FileRangeReadException(uri, null)
    // The stream takes over the descriptor and closes it together with the channel
    return ParcelFileDescriptor.AutoCloseInputStream(descriptor).channel
  }
  return FileInputStream(File(requireNotNull(uri.path))).channel
}

/**
 * Writes up to `length` bytes of the file at `uri`, starting at `offset`, to `output`. The file is read
 * as it is at the time of the call: fewer bytes are written when the file is now shorter than the range,
 * and a missing or unreadable file throws.
 */
internal fun readFileRange(
  uri: Uri,
  offset: Long,
  length: Int,
  contentResolver: ContentResolver,
  output: ByteArrayOutputStream
) {
  try {
    openFileChannel(uri, contentResolver).use { channel ->
      channel.position(offset)
      val buffer = ByteBuffer.allocate(minOf(length, 64 * 1024))
      var remaining = length
      while (remaining > 0) {
        buffer.clear()
        buffer.limit(minOf(remaining, buffer.capacity()))
        val read = channel.read(buffer)
        if (read <= 0) {
          break
        }
        output.write(buffer.array(), 0, read)
        remaining -= read
      }
    }
  } catch (e: CodedException) {
    throw e
  } catch (e: Exception) {
    throw FileRangeReadException(uri, e)
  }
}
