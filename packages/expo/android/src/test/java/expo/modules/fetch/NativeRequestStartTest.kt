// Copyright 2015-present 650 Industries. All rights reserved.

package expo.modules.fetch

import com.google.common.truth.Truth.assertThat
import expo.modules.kotlin.AppContext
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.FileNotFoundException
import java.net.URL
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit

/**
 * Runs every OkHttp async call inline on the thread that calls `enqueue`. This makes the
 * callback arrive before `enqueue` returns, which is the worst case of the real race: on a
 * device the OkHttp dispatcher thread can call `onFailure` before the module thread runs the
 * next line after `enqueue`.
 */
private class InlineExecutorService : AbstractExecutorService() {
  override fun execute(command: Runnable) = command.run()
  override fun shutdown() = Unit
  override fun shutdownNow(): List<Runnable> = emptyList()
  override fun isShutdown() = false
  override fun isTerminated() = false
  override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
}

@RunWith(RobolectricTestRunner::class)
class NativeRequestStartTest {
  @Test
  fun `a request that fails while it is being enqueued still settles with an error`() {
    // Same failure as `OkHttpFileUrlInterceptor` reading a `file://` URL without permission:
    // the interceptor throws before any network work, so `onFailure` comes immediately.
    val failure = FileNotFoundException("open failed: EACCES (Permission denied)")
    val client = OkHttpClient.Builder()
      .dispatcher(Dispatcher(InlineExecutorService()))
      .addInterceptor { throw failure }
      .build()
    val appContext = mockk<AppContext>(relaxed = true)
    val response = NativeResponse(appContext, CoroutineScope(Dispatchers.Unconfined))
    val request = NativeRequest(appContext, response)

    request.start(client, URL("https://example.test/"), NativeRequestInit(), null)

    // `ExpoFetchModule` waits for one of these states to settle the JS promise. If the failure
    // was dropped, no state change ever comes and `fetch` hangs forever.
    var settledState: ResponseState? = null
    response.waitForStates(listOf(ResponseState.RESPONSE_RECEIVED, ResponseState.ERROR_RECEIVED)) {
      settledState = it
    }
    assertThat(settledState).isEqualTo(ResponseState.ERROR_RECEIVED)
    assertThat(response.error).isSameInstanceAs(failure)
  }
}
