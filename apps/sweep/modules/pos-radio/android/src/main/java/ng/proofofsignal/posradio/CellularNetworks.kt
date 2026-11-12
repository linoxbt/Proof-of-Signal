package ng.proofofsignal.posradio

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.TelephonyNetworkSpecifier
import android.os.Build
import android.telephony.SubscriptionManager
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/**
 * Brings up a cellular network for one subscription with ConnectivityManager.requestNetwork, so the probe
 * traffic goes over that SIM's mobile data even when the phone is on Wi-Fi. Handles stay valid until release().
 */
class CellularNetworks(private val context: Context) {
  private class Held(val network: Network, val callback: ConnectivityManager.NetworkCallback)

  private val held = ConcurrentHashMap<Long, Held>()
  private val cm: ConnectivityManager? get() = context.getSystemService(ConnectivityManager::class.java)

  fun get(handle: Long): Network? = held[handle]?.network

  suspend fun bind(subId: Int, timeoutMs: Int): Map<String, Any?> {
    val cm = cm ?: return result(null, "no_connectivity_service")
    val builder = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    if (subId >= 0 && subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setNetworkSpecifier(TelephonyNetworkSpecifier.Builder().setSubscriptionId(subId).build())
      } else {
        // API 26-29: the telephony factory matches a string specifier holding the subscription id.
        @Suppress("DEPRECATION")
        builder.setNetworkSpecifier(subId.toString())
      }
    }
    val request = builder.build()

    var callback: ConnectivityManager.NetworkCallback? = null
    val network: Network? = try {
      suspendCancellableCoroutine { cont ->
        val cb = object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) {
            if (cont.isActive) cont.resume(network)
          }

          override fun onUnavailable() {
            if (cont.isActive) cont.resume(null)
          }
        }
        callback = cb
        cm.requestNetwork(request, cb, timeoutMs.coerceAtLeast(1))
        cont.invokeOnCancellation { runCatching { cm.unregisterNetworkCallback(cb) } }
      }
    } catch (_: SecurityException) {
      callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      return result(null, "permission")
    } catch (e: RuntimeException) {
      // TooManyRequestsException and friends.
      callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      return result(null, "bind_error")
    }
    if (network == null) {
      callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      return result(null, "sim_unbindable")
    }
    val handle = network.networkHandle
    held[handle] = Held(network, callback!!)
    return result(handle.toDouble(), null)
  }

  fun release(handle: Long) {
    val h = held.remove(handle) ?: return
    runCatching { cm?.unregisterNetworkCallback(h.callback) }
  }

  fun releaseAll() {
    for (k in held.keys.toList()) release(k)
  }

  private fun result(handle: Double?, err: String?): Map<String, Any?> = mapOf("handle" to handle, "err" to err)
}
