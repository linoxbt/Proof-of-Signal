package ng.proofofsignal.posradio

import android.content.Context
import android.util.Base64
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PosRadioModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val networks by lazy { CellularNetworks(context) }
  private val probe by lazy { Probe() }
  private val keys by lazy { DeviceKey(context) }
  private val integrity by lazy { Integrity(context) }

  override fun definition() = ModuleDefinition {
    Name("PosRadio")

    OnDestroy {
      runCatching { networks.releaseAll() }
    }

    // Radio
    AsyncFunction("subscriptions") {
      Radio(context).subscriptions()
    }

    AsyncFunction("snapshot") Coroutine { ->
      Radio(context).snapshot()
    }

    // Networks and probe
    AsyncFunction("bindCellular") Coroutine { subId: Int, timeoutMs: Int ->
      networks.bind(subId, timeoutMs)
    }

    AsyncFunction("releaseCellular") { handle: Double ->
      probe.forget(handle.toLong())
      networks.release(handle.toLong())
    }

    AsyncFunction("headProbe") Coroutine { handle: Double, url: String, timeoutMs: Int ->
      val network = networks.get(handle.toLong())
        ?: return@Coroutine mapOf("ms" to null, "status" to null, "err" to "no_network")
      probe.head(handle.toLong(), network, url, timeoutMs)
    }

    AsyncFunction("uploadProbe") Coroutine { handle: Double, url: String, size: Int, nonce: String, timeoutMs: Int ->
      val network = networks.get(handle.toLong())
        ?: return@Coroutine mapOf(
          "ok" to false, "bytes" to 0, "dns_ms" to null, "connect_ms" to null, "tls_ms" to null,
          "ttfb_ms" to null, "total_ms" to null, "http_status" to null, "err" to "no_network"
        )
      probe.upload(network, url, size, nonce, timeoutMs)
    }

    // Location
    AsyncFunction("isMockLocation") {
      MockLocation.newestIsMock(context)
    }

    // Keystore
    AsyncFunction("ensureKey") { challengeB64: String? ->
      keys.ensure(challengeB64?.let { Base64.decode(it, Base64.DEFAULT) })
    }

    AsyncFunction("getPublicKey") {
      keys.publicKeyB64()
    }

    AsyncFunction("sign") { dataB64: String ->
      keys.signB64(dataB64)
    }

    AsyncFunction("attestationChain") {
      keys.attestationChain()
    }

    // Play Integrity
    AsyncFunction("integrityToken") Coroutine { cloudProjectNumber: String, requestHash: String ->
      integrity.token(cloudProjectNumber, requestHash)
    }
  }
}
