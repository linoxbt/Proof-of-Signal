package ng.proofofsignal.posradio

import android.content.pm.PackageManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The device's ES256 identity: an EC P-256 key in Android Keystore that never leaves the secure hardware.
 * Public key out as base64 SPKI DER; signatures out as base64 DER, exactly as Signature.sign() returns them.
 */
class DeviceKey(private val context: Context) {
  companion object {
    const val ALIAS = "proof-of-signal-device-v1"
    private const val PROVIDER = "AndroidKeyStore"
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  fun exists(): Boolean = keyStore().containsAlias(ALIAS)

  /** Generate if absent. Tries StrongBox + attestation, then TEE + attestation, then TEE alone. */
  fun ensure(challenge: ByteArray?): Map<String, Any?> {
    if (exists()) return mapOf("created" to false, "strongBox" to false, "attested" to ((keyStore().getCertificateChain(ALIAS)?.size ?: 0) > 1))
    val hasStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    val attempts = buildList {
      if (hasStrongBox) add(true to challenge)
      add(false to challenge)
      if (challenge != null) add(false to null)
    }
    var last: Exception? = null
    for ((strongBox, ch) in attempts) {
      try {
        generate(strongBox, ch)
        return mapOf("created" to true, "strongBox" to strongBox, "attested" to (ch != null))
      } catch (e: Exception) {
        // StrongBoxUnavailableException (API 28) is a ProviderException; not named here so API 26 never loads it.
        if (e !is ProviderException && e !is java.security.GeneralSecurityException) throw e
        last = e
        runCatching { keyStore().deleteEntry(ALIAS) }
      }
    }
    throw last ?: IllegalStateException("key generation failed")
  }

  private fun generate(strongBox: Boolean, challenge: ByteArray?) {
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
      .apply {
        if (challenge != null) setAttestationChallenge(challenge)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true)
      }
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply {
      initialize(spec)
      generateKeyPair()
    }
  }

  fun publicKeyB64(): String {
    val cert = keyStore().getCertificate(ALIAS) ?: throw IllegalStateException("no device key")
    return Base64.encodeToString(cert.publicKey.encoded, Base64.NO_WRAP)
  }

  fun signB64(dataB64: String): String {
    val data = Base64.decode(dataB64, Base64.DEFAULT)
    val key = keyStore().getKey(ALIAS, null) as? PrivateKey ?: throw IllegalStateException("no device key")
    val sig = Signature.getInstance("SHA256withECDSA").apply {
      initSign(key)
      update(data)
    }.sign()
    return Base64.encodeToString(sig, Base64.NO_WRAP)
  }

  fun attestationChain(): List<String> =
    keyStore().getCertificateChain(ALIAS)?.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) } ?: emptyList()
}
