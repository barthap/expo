// Copyright 2015-present 650 Industries. All rights reserved.

package expo.modules.fetch

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.buffer
import okio.source
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.lang.ref.WeakReference
import java.net.URL
import java.net.URLConnection

private const val fakeHttpUrlPrefix = "http://filesystem.local"
private const val assetUrl = "file:///android_asset/"
private const val fileScheme = "file://"
private const val fakeContentUrlPrefix = "http://contentprovider.local/"
private const val contentScheme = "content://"

/**
 * OkHttp does not support `file://` scheme under the hood.
 * We add fake "http://filesystem.local" prefix to the URL
 * and use this interceptor to support local file.
 * `content://` URIs get the fake "http://contentprovider.local/" prefix in place of the scheme,
 * so the authority, path and query survive, and are read through the `ContentResolver`.
 */
internal class OkHttpFileUrlInterceptor(context: Context) : Interceptor {
  private val context: WeakReference<Context> = WeakReference(context)

  override fun intercept(chain: Interceptor.Chain): Response {
    val request: Request = chain.request()
    val requestUrl = request.url.toString()
    if (requestUrl.startsWith(fakeContentUrlPrefix)) {
      return createContentResponse(request, contentScheme + requestUrl.removePrefix(fakeContentUrlPrefix))
    }
    val url = restoreFileUrl(request.url)

    if (!url.startsWith(fileScheme)) {
      return chain.proceed(request)
    }

    if (url.startsWith(assetUrl)) {
      val fileName = url.removePrefix(assetUrl)
      val context = context.get() ?: throw FetchAndroidContextLostException()
      try {
        val responseBody = createAssetResponseBody(context, fileName)
        return Response.Builder()
          .request(request)
          .protocol(Protocol.HTTP_1_1)
          .code(200)
          .message("OK")
          .body(responseBody)
          .build()
      } catch (_: IOException) {
        return createFileNotFoundResponse(request)
      }
    }

    val filePath = url.substring(fileScheme.length)
    val file = File(filePath)

    if (!file.exists()) {
      return createFileNotFoundResponse(request)
    }

    val responseBody = file.source().buffer().asResponseBody(
      createMediaType(file.name),
      file.length()
    )
    return Response.Builder()
      .request(request)
      .protocol(Protocol.HTTP_1_1)
      .code(200)
      .message("OK")
      .body(responseBody)
      .build()
  }

  private fun createContentResponse(request: Request, uriString: String): Response {
    val context = context.get() ?: throw FetchAndroidContextLostException()
    val contentResolver = context.contentResolver
    val uri = Uri.parse(uriString)
    // A URI that cannot be opened rejects the request, as a revoked `blob:` URL does on iOS and on
    // the web; the 404 response is for `file://` URLs only. `FileNotFoundException` is an `IOException`.
    try {
      val inputStream = contentResolver.openInputStream(uri) ?: throw FileNotFoundException("Cannot open $uri")
      try {
        val defaultType = "application/octet-stream"
        val mediaType = contentResolver.getType(uri)?.toMediaTypeOrNull() ?: defaultType.toMediaType()
        val responseBody = inputStream.source().buffer().asResponseBody(
          mediaType,
          queryContentLength(contentResolver, uri)
        )
        return Response.Builder()
          .request(request)
          .protocol(Protocol.HTTP_1_1)
          .code(200)
          .message("OK")
          .body(responseBody)
          .build()
      } catch (e: Throwable) {
        inputStream.close()
        throw e
      }
    } catch (e: RuntimeException) {
      // A provider throws `SecurityException` without a grant and `IllegalArgumentException` for a URI
      // it does not know. OkHttp rethrows anything but an `IOException` on its thread, which kills the app.
      throw IOException(e.message, e)
    }
  }

  /**
   * The size the provider reports for the URI, or -1 (unknown) when it does not answer `query`.
   */
  private fun queryContentLength(contentResolver: ContentResolver, uri: Uri): Long {
    return try {
      contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) cursor.getLong(index) else -1L
      } ?: -1L
    } catch (_: RuntimeException) {
      // A provider may reject `query` (or this column) while it still serves the bytes
      -1L
    }
  }

  private fun restoreFileUrl(url: HttpUrl): String {
    val urlString = url.toString()
    return urlString.replaceFirst(fakeHttpUrlPrefix, fileScheme)
  }

  private fun createFileNotFoundResponse(request: Request): Response {
    return Response.Builder()
      .request(request)
      .protocol(Protocol.HTTP_1_1)
      .code(404)
      .message("File not found")
      .body("File not found".toResponseBody("text/plain".toMediaType()))
      .build()
  }

  private fun createMediaType(fileName: String): MediaType {
    val defaultType = "application/octet-stream"
    val mimeType = URLConnection.guessContentTypeFromName(fileName) ?: defaultType
    return mimeType.toMediaTypeOrNull() ?: defaultType.toMediaType()
  }

  @Throws(IOException::class)
  fun createAssetResponseBody(context: Context, fileName: String): ResponseBody {
    val assetManager = context.assets
    val inputStream = assetManager.open(fileName)
    return inputStream.source().buffer().asResponseBody(createMediaType(fileName))
  }

  companion object {
    fun handleFileUrl(url: String): URL {
      return if (url.startsWith(contentScheme)) {
        URL(fakeContentUrlPrefix + url.removePrefix(contentScheme))
      } else {
        // `java.net.URL` keeps parsing every other URL as before, including its exceptions
        handleFileUrl(URL(url))
      }
    }

    private fun handleFileUrl(url: URL): URL {
      return if (url.protocol == "file") {
        URL(fakeHttpUrlPrefix + url.path)
      } else {
        url
      }
    }
  }
}
