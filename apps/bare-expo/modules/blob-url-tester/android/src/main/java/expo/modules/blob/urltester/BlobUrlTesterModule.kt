package expo.modules.blob.urltester

import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.FileNotFoundException

/**
 * Loads URIs the way native code outside of React Native does, so test-suite can check that
 * `URL.createObjectURL` URIs work there.
 */
class BlobUrlTesterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BlobUrlTester")

    // Reads the URI with `ContentResolver.openInputStream`, like another app or a native library would.
    AsyncFunction("readWithContentResolver") { uri: String ->
      val contentResolver = appContext.reactContext?.contentResolver ?: throw Exceptions.ReactContextLost()
      val stream = contentResolver.openInputStream(Uri.parse(uri))
        ?: throw FileNotFoundException("No stream for $uri")
      stream.use { it.readBytes() }
    }
  }
}
