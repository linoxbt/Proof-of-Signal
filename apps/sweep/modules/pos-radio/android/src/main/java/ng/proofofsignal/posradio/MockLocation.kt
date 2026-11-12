package ng.proofofsignal.posradio

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build

/**
 * Whether the newest location the platform holds came from a mock provider: Location.isMock on API 31+,
 * isFromMockProvider before. The JS side also checks expo-location's own `mocked` flag on the fix it used.
 */
object MockLocation {
  @SuppressLint("MissingPermission")
  fun newestIsMock(context: Context): Boolean? {
    val lm = context.getSystemService(LocationManager::class.java) ?: return null
    val newest: Location = try {
      lm.getProviders(true).mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        .maxByOrNull { it.elapsedRealtimeNanos }
    } catch (_: SecurityException) {
      null
    } ?: return null
    return isMock(newest)
  }

  fun isMock(location: Location): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) location.isMock
    else @Suppress("DEPRECATION") location.isFromMockProvider
}
