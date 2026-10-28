// Copyright 2015-present 650 Industries. All rights reserved.

package expo.modules.fetch

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import com.facebook.soloader.SoLoader
import com.google.common.truth.Truth.assertThat
import expo.modules.blob.BlobStoreTestApplication
import expo.modules.blob.ExpoBlobProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.net.MalformedURLException

/**
 * A provider that answers each URI the way a real one can: with bytes, with no `query` answer, or
 * with the exceptions that `DocumentsProvider`s and androidx `FileProvider` throw.
 */
class TestContentProvider : ContentProvider() {
  override fun onCreate() = true

  override fun getType(uri: Uri) = "text/plain"

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?
  ): Cursor? = when (uri.lastPathSegment) {
    "ok" -> MatrixCursor(arrayOf(OpenableColumns.SIZE)).apply { addRow(arrayOf(2L)) }
    else -> null
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = when (uri.lastPathSegment) {
    "ok", "no-size" -> {
      val file = File.createTempFile("content", ".txt").apply { writeText("hi") }
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }
    "denied" -> throw SecurityException("Permission Denial: no grant for $uri")
    "invalid" -> throw IllegalArgumentException("Invalid URI: $uri")
    else -> throw FileNotFoundException("No file for $uri")
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?) = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?) = 0
}

@RunWith(RobolectricTestRunner::class)
@Config(application = BlobStoreTestApplication::class)
class OkHttpContentUriTest {
  private val authority = "test.ExpoBlobProvider"
  private val testAuthority = "test.content"
  private val application get() = ApplicationProvider.getApplicationContext<BlobStoreTestApplication>()

  // The same steps as `NativeRequest.start`, but synchronous
  private fun fetch(url: String): Response {
    val client = OkHttpClient.Builder()
      .addInterceptor(OkHttpFileUrlInterceptor(application))
      .build()
    val request = Request.Builder().url(OkHttpFileUrlInterceptor.handleFileUrl(url)).build()
    return client.newCall(request).execute()
  }

  @Before
  fun registerProvider() {
    // React Native's BlobModule loads a JNI library that does not exist on the JVM; the store does not need it
    SoLoader.setInTestMode()
    Robolectric.buildContentProvider(ExpoBlobProvider::class.java).create(authority)
    Robolectric.buildContentProvider(TestContentProvider::class.java).create(testAuthority)
  }

  @Test
  fun `loads the bytes of a Blob URL from its content provider`() {
    // `URL.createObjectURL` returns this URI on Android; the range in its query must reach the provider
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3, 4, 5))

    fetch("content://$authority/$blobId?offset=1&size=3").use { response ->
      assertThat(response.code).isEqualTo(200)
      assertThat(response.body!!.contentType().toString()).isEqualTo("application/octet-stream")
      assertThat(response.body!!.contentLength()).isEqualTo(3L)
      assertThat(response.body!!.bytes()).isEqualTo(byteArrayOf(2, 3, 4))
    }
  }

  @Test
  fun `rejects a Blob URL whose bytes are gone`() {
    // A revoked `blob:` URL is a network error on iOS and on the web, so `fetch` must reject here too
    assertThrows(FileNotFoundException::class.java) {
      fetch("content://$authority/unknown-blob-id?offset=0&size=3")
    }
  }

  @Test
  fun `serves the type and the size the provider reports`() {
    fetch("content://$testAuthority/ok").use { response ->
      assertThat(response.code).isEqualTo(200)
      assertThat(response.body!!.contentType().toString()).isEqualTo("text/plain")
      assertThat(response.body!!.contentLength()).isEqualTo(2L)
      assertThat(response.body!!.string()).isEqualTo("hi")
    }
  }

  @Test
  fun `still reads the bytes when the provider does not answer query`() {
    // Many providers serve streams with no `OpenableColumns`; the size is then unknown, not an error
    fetch("content://$testAuthority/no-size").use { response ->
      assertThat(response.code).isEqualTo(200)
      assertThat(response.body!!.contentLength()).isEqualTo(-1L)
      assertThat(response.body!!.string()).isEqualTo("hi")
    }
  }

  @Test
  fun `rejects a URI the app has no grant for`() {
    val error = assertThrows(IOException::class.java) { fetch("content://$testAuthority/denied") }
    // The cause tells the app why, which a 404 body would hide
    assertThat(error.cause).isInstanceOf(SecurityException::class.java)
  }

  @Test
  fun `rejects a URI the provider does not know, without killing the app`() {
    // `FileProvider` and every `DocumentsProvider` throw `IllegalArgumentException` here. OkHttp
    // rethrows anything but an `IOException` on its dispatcher thread, and Android then kills the app.
    val error = assertThrows(IOException::class.java) { fetch("content://$testAuthority/invalid") }
    assertThat(error.cause).isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `rejects a URI the provider has no file for`() {
    assertThrows(FileNotFoundException::class.java) { fetch("content://$testAuthority/missing") }
  }

  @Test
  fun `keeps percent-encoded path segments of document URIs`() {
    // Document providers put `%3A` and `%2F` in one segment; decoding them would open another document
    val uri = "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fa%20b.txt?x=1"

    val request = Request.Builder().url(OkHttpFileUrlInterceptor.handleFileUrl(uri)).build()

    assertThat(request.url.toString())
      .isEqualTo("http://contentprovider.local/com.android.externalstorage.documents/document/primary%3ADownload%2Fa%20b.txt?x=1")
  }

  @Test
  fun `still rejects a malformed URL that is not content`() {
    // Only `content://` skips `java.net.URL`, so other URLs fail as they did before
    assertThrows(MalformedURLException::class.java) {
      OkHttpFileUrlInterceptor.handleFileUrl("foo://bar")
    }
  }
}
