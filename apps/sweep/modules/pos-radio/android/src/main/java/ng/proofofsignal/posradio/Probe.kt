package ng.proofofsignal.posradio

import android.net.Network
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Proxy
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

/**
 * HEAD pings and the 1.5 MB upload, through OkHttp bound to one cellular Network (its socket factory and its
 * DNS), timed with an EventListener. A failed upload is a measurement, never an exception.
 */
class Probe {
  private val base: OkHttpClient = OkHttpClient.Builder()
    .retryOnConnectionFailure(false) // a silent retry would double-count bytes and hide the failure
    .followRedirects(false)
    .followSslRedirects(false)
    .protocols(listOf(Protocol.HTTP_1_1)) // one request per connection: timings stay comparable across phones
    .build()

  // HEAD clients keep their connection between the three pings (the first one pays DNS + TCP + TLS).
  private val headClients = HashMap<Long, OkHttpClient>()

  private fun bound(network: Network, timeoutMs: Int, pool: ConnectionPool, listener: Timing?): OkHttpClient =
    base.newBuilder()
      .socketFactory(network.socketFactory)
      .dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = network.getAllByName(hostname).toList()
      })
      .connectionPool(pool)
      .callTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .connectTimeout(minOf(timeoutMs.toLong(), 30_000L), TimeUnit.MILLISECONDS)
      .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .apply { if (listener != null) eventListener(listener) }
      .build()

  suspend fun head(handle: Long, network: Network, url: String, timeoutMs: Int): Map<String, Any?> = withContext(Dispatchers.IO) {
    val client = synchronized(headClients) {
      headClients.getOrPut(handle) { bound(network, timeoutMs, ConnectionPool(1, 30, TimeUnit.SECONDS), null) }
    }
    val start = System.nanoTime()
    try {
      client.newCall(Request.Builder().url(url).head().header("cache-control", "no-store").build()).execute().use { res ->
        val ms = (System.nanoTime() - start) / 1_000_000
        mapOf("ms" to if (res.code in 200..399) ms.toDouble() else null, "status" to res.code, "err" to if (res.code in 200..399) null else "http_${res.code}")
      }
    } catch (e: IOException) {
      mapOf("ms" to null, "status" to null, "err" to errorClass(e))
    }
  }

  fun forget(handle: Long) {
    synchronized(headClients) { headClients.remove(handle) }?.connectionPool?.evictAll()
  }

  suspend fun upload(network: Network, url: String, size: Int, nonce: String, timeoutMs: Int): Map<String, Any?> = withContext(Dispatchers.IO) {
    val timing = Timing()
    // A fresh pool: the upload pays its own DNS, TCP and TLS, as a polling unit's upload would.
    val client = bound(network, timeoutMs, ConnectionPool(0, 1, TimeUnit.SECONDS), timing)
    val request = Request.Builder()
      .url(url)
      .put(SyntheticJpeg(size, nonce))
      .header("cache-control", "no-store")
      .build()
    var status: Int? = null
    var err: String? = null
    try {
      client.newCall(request).execute().use { res ->
        status = res.code
        res.body?.let { runCatching { it.bytes() } }
        if (res.code != 200) err = "http_${res.code}"
      }
    } catch (e: IOException) {
      err = errorClass(e)
    }
    timing.finish()
    mapOf(
      "ok" to (status == 200 && err == null),
      "bytes" to timing.bytesSent.toDouble(),
      "dns_ms" to timing.dnsMs,
      "connect_ms" to timing.connectMs,
      "tls_ms" to timing.tlsMs,
      "ttfb_ms" to timing.ttfbMs,
      "total_ms" to timing.totalMs,
      "http_status" to status,
      "err" to err
    )
  }

  companion object {
    fun errorClass(e: Throwable): String = when {
      e is SocketTimeoutException -> "timeout"
      e is InterruptedIOException && (e.message?.contains("timeout", true) == true) -> "timeout"
      e is InterruptedIOException -> "timeout"
      e is UnknownHostException -> "dns"
      e is ConnectException || e is NoRouteToHostException -> "connect"
      e is SSLException -> "tls"
      e is SocketException && (e.message?.contains("reset", true) == true) -> "reset"
      else -> "io"
    }
  }
}

/** Timings in ms from OkHttp's call events. Fields stay null when a phase did not happen (e.g. reused connection). */
class Timing : EventListener() {
  private fun now() = System.nanoTime()
  private var callStart = 0L
  private var dnsStart = 0L
  private var connectStart = 0L
  private var secureStart = 0L
  private var requestSent = 0L

  var dnsMs: Double? = null
  var connectMs: Double? = null
  var tlsMs: Double? = null
  var ttfbMs: Double? = null
  var totalMs: Double? = null
  var bytesSent = 0L

  private fun ms(from: Long, to: Long) = ((to - from) / 1_000_000).toDouble()

  override fun callStart(call: Call) { callStart = now() }
  override fun dnsStart(call: Call, domainName: String) { dnsStart = now() }
  override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) { dnsMs = ms(dnsStart, now()) }
  override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { connectStart = now() }
  override fun secureConnectStart(call: Call) {
    secureStart = now()
    connectMs = ms(connectStart, secureStart) // TCP only
  }
  override fun secureConnectEnd(call: Call, handshake: okhttp3.Handshake?) { tlsMs = ms(secureStart, now()) }
  override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
    if (connectMs == null) connectMs = ms(connectStart, now())
  }
  override fun requestHeadersEnd(call: Call, request: Request) { if (requestSent == 0L) requestSent = now() }
  override fun requestBodyEnd(call: Call, byteCount: Long) {
    bytesSent += byteCount
    requestSent = now()
  }
  override fun responseHeadersStart(call: Call) { if (requestSent != 0L) ttfbMs = ms(requestSent, now()) }
  override fun callEnd(call: Call) { totalMs = ms(callStart, now()) }
  override fun callFailed(call: Call, ioe: IOException) { totalMs = ms(callStart, now()) }
  override fun requestFailed(call: Call, ioe: IOException) {}

  fun finish() {
    if (totalMs == null && callStart != 0L) totalMs = ms(callStart, now())
  }
}

/**
 * Exactly [size] bytes: a valid JPEG header (SOI, JFIF APP0, a COM segment naming the nonce), high-entropy random
 * bytes that no carrier proxy can compress, and EOI. Generated while streaming, so 1.5 MB never sits in memory.
 */
class SyntheticJpeg(private val size: Int, nonce: String) : RequestBody() {
  private val header: ByteArray = run {
    val comment = "proof-of-signal probe $nonce".toByteArray(Charsets.US_ASCII)
    val app0 = byteArrayOf(
      0xFF.toByte(), 0xD8.toByte(), // SOI
      0xFF.toByte(), 0xE0.toByte(), 0x00, 0x10, // APP0, length 16
      'J'.code.toByte(), 'F'.code.toByte(), 'I'.code.toByte(), 'F'.code.toByte(), 0x00,
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
    )
    val comLen = comment.size + 2
    app0 + byteArrayOf(0xFF.toByte(), 0xFE.toByte(), (comLen shr 8).toByte(), (comLen and 0xFF).toByte()) + comment
  }

  override fun contentType() = "image/jpeg".toMediaType()
  override fun contentLength(): Long = size.toLong()

  override fun writeTo(sink: BufferedSink) {
    require(size >= header.size + 2) { "size too small" }
    val random = SecureRandom()
    sink.write(header)
    var left = size - header.size - 2
    val chunk = ByteArray(16 * 1024)
    while (left > 0) {
      val n = minOf(left, chunk.size)
      random.nextBytes(chunk)
      // No 0xFF in the filler, so no stray JPEG markers appear before EOI.
      for (j in 0 until n) if (chunk[j] == 0xFF.toByte()) chunk[j] = 0xFE.toByte()
      sink.write(chunk, 0, n)
      left -= n
    }
    sink.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte())) // EOI
  }
}
