package expo.modules.blob

import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.max
import kotlin.math.min

// React Native's native blob store; aliased because this module class has the same name
private typealias ReactBlobModule = com.facebook.react.modules.blob.BlobModule

class BlobModule : Module() {
  // React Native's BlobModule guards its storage with `synchronized`, so it is safe to call
  // from the JS thread that runs synchronous functions.
  private val reactBlobModule: ReactBlobModule
    get() {
      val reactContext = appContext.reactContext as? ReactContext ?: throw Exceptions.ReactContextLost()
      return reactContext.getNativeModule(ReactBlobModule::class.java)
        ?: throw RNBlobModuleUnavailableException()
    }

  // Returns a copy of the referenced bytes, so they stay valid after the entry is removed from the store.
  private fun resolveRNBlob(reference: RNBlobReference): ByteArray {
    // The whole entry is read and the range cut here: React Native's `resolve` pads a range past the end with zeros.
    val data = reactBlobModule.resolve(reference.blobId, 0, -1)
      ?: throw RNBlobResolveException(reference.blobId)
    val start = reference.offset
    val end = start + reference.size
    if (start < 0 || reference.size < 0 || end > data.size) {
      throw RNBlobRangeException(reference.blobId)
    }
    return data.copyOfRange(start, end)
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoBlob")

    // Registers a copy of the Blob's bytes in React Native's blob store. They stay there until `release` is called.
    Function("store") { blob: Blob ->
      reactBlobModule.store(blob.bytes())
    }

    // Removing an unknown id is a no-op in React Native's BlobModule.
    Function("release") { blobId: String ->
      reactBlobModule.remove(blobId)
    }

    // A Blob with a copy of the bytes of a React Native Blob, which the JS constructor passes on as a Blob part.
    // A separate function, because a record cannot be a constructor part: the part type also accepts
    // typed arrays, and on Android both converters claim every JS object.
    Function("fromReactNativeBlob") { reference: RNBlobReference ->
      Blob(listOf(InternalBlobPart.BufferWrapper(resolveRNBlob(reference))))
    }

    Class(Blob::class) {
      Constructor { blobParts: List<BlobPart>?, options: BlobOptionsBag? ->
        makeBlob(blobParts, options)
      }

      Property("size") { blob: Blob ->
        blob.size
      }

      Property("type") { blob: Blob ->
        blob.type
      }

      Function("slice") { blob: Blob, start: Int?, end: Int?, contentType: String? ->
        var sliceStart: Int = start ?: 0
        var sliceEnd: Int = end ?: blob.size
        if (sliceStart < 0) {
          sliceStart = max(blob.size + sliceStart, 0)
        } else {
          sliceStart = min(sliceStart, blob.size)
        }
        if (sliceEnd < 0) {
          sliceEnd = max(blob.size + sliceEnd, 0)
        } else {
          sliceEnd = min(sliceEnd, blob.size)
        }
        blob.slice(sliceStart, sliceEnd, contentType ?: "")
      }

      AsyncFunction("bytes") { blob: Blob ->
        blob.bytes()
      }

      AsyncFunction("text") { blob: Blob ->
        blob.bytes().decodeToString()
      }
    }
  }
}
