package expo.modules.blob

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.blob.BlobModule as ReactBlobModule
import com.facebook.soloader.SoLoader
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.FileNotFoundException

/**
 * An app whose running React Native instance holds a real React Native blob store, like an app
 * after `URL.createObjectURL` stored a Blob's bytes there.
 */
class BlobStoreTestApplication : Application(), ReactApplication {
  // The store itself is real; its React context is only held, not used, by `store`/`resolve`/`remove`
  val blobModule by lazy { ReactBlobModule(mockk<ReactApplicationContext>(relaxed = true)) }
  var isReactRunning = true

  override val reactHost: ReactHost by lazy {
    val reactContext = mockk<ReactContext> {
      every { getNativeModule(ReactBlobModule::class.java) } answers { blobModule }
    }
    mockk { every { currentReactContext } answers { if (isReactRunning) reactContext else null } }
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = BlobStoreTestApplication::class)
class ExpoBlobProviderTest {
  private val authority = "test.ExpoBlobProvider"
  private val application get() = ApplicationProvider.getApplicationContext<BlobStoreTestApplication>()
  private val contentResolver get() = application.contentResolver

  private fun blobUri(blobId: String, offset: Int, size: Int): Uri =
    Uri.parse("content://$authority/$blobId?offset=$offset&size=$size")

  @Before
  fun registerProvider() {
    // React Native's BlobModule loads a JNI library that does not exist on the JVM; the store does not need it
    SoLoader.setInTestMode()
    Robolectric.buildContentProvider(ExpoBlobProvider::class.java).create(authority)
  }

  @Test
  fun `serves the stored bytes of the range in the URI`() {
    // `URL.createObjectURL` builds this URI for a stored Blob; any app that opens it must get those bytes
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3, 4, 5))

    val whole = contentResolver.openInputStream(blobUri(blobId, 0, 5))!!.use { it.readBytes() }
    val range = contentResolver.openInputStream(blobUri(blobId, 1, 3))!!.use { it.readBytes() }

    assertThat(whole).isEqualTo(byteArrayOf(1, 2, 3, 4, 5))
    assertThat(range).isEqualTo(byteArrayOf(2, 3, 4))
  }

  @Test
  fun `serves bytes larger than the pipe buffer`() {
    // Past 64 KiB the bytes are written from another thread; a same-thread write would block forever
    val bytes = ByteArray(300_000) { (it % 251).toByte() }
    val blobId = application.blobModule.store(bytes)

    val read = contentResolver.openInputStream(blobUri(blobId, 0, bytes.size))!!.use { it.readBytes() }

    assertThat(read).isEqualTo(bytes)
  }

  @Test
  fun `fails for an id that is not in the store, such as a revoked URL`() {
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))
    application.blobModule.remove(blobId)

    assertThrows(FileNotFoundException::class.java) {
      contentResolver.openInputStream(blobUri(blobId, 0, 3))
    }
    assertThrows(FileNotFoundException::class.java) {
      contentResolver.openInputStream(blobUri("unknown-blob-id", 0, 3))
    }
  }

  @Test
  fun `fails for a range outside of the stored bytes instead of padding it`() {
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))

    assertThrows(FileNotFoundException::class.java) {
      contentResolver.openInputStream(blobUri(blobId, 2, 5))
    }
  }

  @Test
  fun `fails for a negative offset`() {
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))

    assertThrows(FileNotFoundException::class.java) {
      contentResolver.openInputStream(Uri.parse("content://$authority/$blobId?offset=-1&size=2"))
    }
  }

  @Test
  fun `fails for an offset that is not a number`() {
    // Any app can build the URI by hand, so a bad query must fail the read, not crash the provider
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))

    assertThrows(FileNotFoundException::class.java) {
      contentResolver.openInputStream(Uri.parse("content://$authority/$blobId?offset=abc&size=2"))
    }
  }

  @Test
  fun `fails while React Native is not running`() {
    // The store lives in the React instance, so a URI granted before a restart cannot be served
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))
    application.isReactRunning = false
    try {
      assertThrows(FileNotFoundException::class.java) {
        contentResolver.openInputStream(blobUri(blobId, 0, 3))
      }
    } finally {
      application.isReactRunning = true
    }
  }

  @Test
  fun `rejects every mode other than read`() {
    // The bytes are a snapshot owned by the app; other apps must not be able to change them
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3))

    for (mode in listOf("w", "rw", "wt", "wa", "rwt")) {
      assertThrows(FileNotFoundException::class.java) {
        contentResolver.openFileDescriptor(blobUri(blobId, 0, 3), mode)
      }
    }
  }

  @Test
  fun `reports the name and size that share targets read`() {
    val blobId = application.blobModule.store(byteArrayOf(1, 2, 3, 4, 5))

    contentResolver.query(blobUri(blobId, 1, 3), null, null, null, null)!!.use { cursor ->
      assertThat(cursor.moveToFirst()).isTrue()
      assertThat(cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))).isEqualTo(blobId)
      assertThat(cursor.getLong(cursor.getColumnIndexOrThrow(OpenableColumns.SIZE))).isEqualTo(3L)
    }
    assertThat(contentResolver.getType(blobUri(blobId, 0, 5))).isEqualTo("application/octet-stream")
  }
}
