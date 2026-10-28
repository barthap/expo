package expo.modules.blob

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import com.facebook.react.ReactApplication
import com.facebook.react.modules.blob.BlobModule as ReactBlobModule
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Serves the bytes of `URL.createObjectURL` as `content://<applicationId>.ExpoBlobProvider/<blobId>?offset=<n>&size=<n>`
 * URIs. The bytes come from React Native's blob store, so they live until `URL.revokeObjectURL`
 * and are gone after the app restarts.
 *
 * The provider is not exported: another app can read a URI only when this app grants it,
 * for example with `Intent.FLAG_GRANT_READ_URI_PERMISSION`.
 * Based on React Native's `BlobProvider`, which needs a manifest entry in the app itself.
 */
class ExpoBlobProvider : ContentProvider() {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?
  ): Cursor? {
    val data = try {
      resolve(uri)
    } catch (_: FileNotFoundException) {
      return null
    }
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val values = columns.map { column ->
      when (column) {
        OpenableColumns.DISPLAY_NAME -> uri.lastPathSegment
        OpenableColumns.SIZE -> data.size.toLong()
        else -> null
      }
    }
    return MatrixCursor(columns, 1).apply { addRow(values) }
  }

  // The store keeps only the bytes, so the Blob's type is not known here.
  override fun getType(uri: Uri): String? = "application/octet-stream"

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?
  ): Int = 0

  @Throws(FileNotFoundException::class)
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
    if (mode != "r") {
      throw FileNotFoundException("Cannot open $uri in mode '$mode'")
    }
    val data = resolve(uri)

    val pipe = try {
      ParcelFileDescriptor.createPipe()
    } catch (exception: IOException) {
      throw FileNotFoundException("Cannot open $uri: ${exception.message}")
    }
    val readSide = pipe[0]
    val writeSide = pipe[1]
    val write = {
      try {
        ParcelFileDescriptor.AutoCloseOutputStream(writeSide).use { it.write(data) }
      } catch (_: IOException) {
        // The reader closed its side early
      }
    }
    if (data.size <= PIPE_CAPACITY) {
      // Fits in the pipe buffer, so the write does not wait for the reader.
      write()
    } else {
      // A larger write fills the buffer and blocks until the reader empties it,
      // so it runs on another thread while the read side is returned.
      executor.submit(write)
    }
    return readSide
  }

  /**
   * Returns the bytes of the range the URI points at. Throws `FileNotFoundException`, which
   * `ContentResolver` passes on to the caller, when React Native is not running, the id is not
   * in the store (for example after `URL.revokeObjectURL`), or the range is invalid.
   */
  @Throws(FileNotFoundException::class)
  private fun resolve(uri: Uri): ByteArray {
    val reactContext = (context?.applicationContext as? ReactApplication)?.reactHost?.currentReactContext
      ?: throw FileNotFoundException("Cannot open $uri, React Native is not running")
    val blobModule = reactContext.getNativeModule(ReactBlobModule::class.java)
      ?: throw FileNotFoundException("Cannot open $uri, React Native's BlobModule is not available")
    val blobId = uri.lastPathSegment
      ?: throw FileNotFoundException("Cannot open $uri, it has no blob id")
    // The whole entry is read and the range cut here: React Native's `resolve` pads a range past the end with zeros.
    val data = blobModule.resolve(blobId, 0, -1)
      ?: throw FileNotFoundException("Cannot open $uri, blob not found")
    val offset = uri.getQueryParameter("offset")?.let { it.toIntOrNull() ?: -1 } ?: 0
    val size = uri.getQueryParameter("size")?.let { it.toIntOrNull() ?: -1 } ?: (data.size - offset)
    if (offset < 0 || size < 0 || offset.toLong() + size > data.size) {
      throw FileNotFoundException("Cannot open $uri, the range lies outside of the blob")
    }
    return if (offset == 0 && size == data.size) data else data.copyOfRange(offset, offset + size)
  }

  private companion object {
    private const val PIPE_CAPACITY = 65536
  }
}
