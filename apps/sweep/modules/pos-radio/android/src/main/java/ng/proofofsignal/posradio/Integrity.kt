package ng.proofofsignal.posradio

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Play Integrity standard requests. The token provider is prepared once (warm-up), then each request binds a
 * request hash. Dev builds without a Google Cloud project number get a marker string instead of a token; the API
 * accepts those only when PLAY_INTEGRITY_MODE=off and ALLOW_UNVERIFIED_DEVICES=true.
 */
class Integrity(private val context: Context) {
  companion object {
    const val DEV_MARKER = "dev-build:no-play-integrity"
  }

  private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
  private var providerProject: Long = 0

  suspend fun token(cloudProjectNumber: String, requestHash: String): String {
    val project = cloudProjectNumber.trim().toLongOrNull() ?: 0L
    if (project <= 0L) return DEV_MARKER
    return try {
      request(project, requestHash)
    } catch (e: StandardIntegrityException) {
      if (e.errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) {
        provider = null
        try {
          request(project, requestHash)
        } catch (e2: Exception) {
          errorMarker(e2)
        }
      } else {
        errorMarker(e)
      }
    } catch (e: Exception) {
      errorMarker(e)
    }
  }

  /** A failed request is reported in-band: the API fails the token and quarantines the test, which is honest. */
  private fun errorMarker(e: Exception): String = when (e) {
    is StandardIntegrityException -> "error:integrity:${e.errorCode}"
    else -> "error:integrity:${e.javaClass.simpleName}"
  }

  private suspend fun request(project: Long, requestHash: String): String {
    val p = provider?.takeIf { providerProject == project } ?: prepare(project)
    val req = StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()
    return p.request(req).await().token()
  }

  private suspend fun prepare(project: Long): StandardIntegrityManager.StandardIntegrityTokenProvider {
    val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
    val p = manager.prepareIntegrityToken(
      StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(project).build()
    ).await()
    provider = p
    providerProject = project
    return p
  }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
  addOnSuccessListener { if (cont.isActive) cont.resume(it) }
  addOnFailureListener { if (cont.isActive) cont.resumeWithException(it) }
  addOnCanceledListener { if (cont.isActive) cont.cancel() }
}
