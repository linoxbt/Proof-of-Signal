package ng.proofofsignal.posradio

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telephony.CellIdentityNr
import android.telephony.CellInfo
import android.telephony.CellInfoCdma
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellSignalStrengthNr
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * Cell measurements per active subscription. Every value Android reports as unavailable
 * (CellInfo.UNAVAILABLE / UNAVAILABLE_LONG) becomes null.
 */
@SuppressLint("MissingPermission")
class Radio(private val context: Context) {
  private val telephony: TelephonyManager? = context.getSystemService(TelephonyManager::class.java)
  private val subscriptionManager: SubscriptionManager? = context.getSystemService(SubscriptionManager::class.java)

  private data class Sub(val slot: Int, val subId: Int, val mcc: String?, val mnc: String?, val carrier: String?)

  private fun activeSubs(): List<Sub> {
    val list: List<SubscriptionInfo> = try {
      subscriptionManager?.activeSubscriptionInfoList ?: emptyList()
    } catch (_: SecurityException) {
      emptyList()
    }
    if (list.isNotEmpty()) {
      return list.map { info ->
        val (mcc, mnc) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          info.mccString to info.mncString
        } else {
          @Suppress("DEPRECATION")
          (if (info.mcc > 0) "%03d".format(info.mcc) else null) to (if (info.mnc >= 0 && info.mcc > 0) "%02d".format(info.mnc) else null)
        }
        Sub(info.simSlotIndex, info.subscriptionId, mcc, mnc, info.carrierName?.toString())
      }
    }
    // No READ_PHONE_STATE or an old single-SIM build: fall back to the default subscription.
    val tm = telephony ?: return emptyList()
    if (tm.simState != TelephonyManager.SIM_STATE_READY) return emptyList()
    val op = tm.simOperator ?: ""
    return listOf(
      Sub(
        0,
        SubscriptionManager.getDefaultSubscriptionId(),
        op.takeIf { it.length >= 5 }?.substring(0, 3),
        op.takeIf { it.length >= 5 }?.substring(3),
        tm.simOperatorName
      )
    )
  }

  fun subscriptions(): List<Map<String, Any?>> = activeSubs().map {
    mapOf("slot" to it.slot, "subId" to it.subId, "mcc" to it.mcc, "mnc" to it.mnc, "carrier" to it.carrier)
  }

  suspend fun snapshot(): List<Map<String, Any?>> {
    val base = telephony ?: return emptyList()
    return activeSubs().map { sub ->
      val tm = if (sub.subId >= 0 && sub.subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
        base.createForSubscriptionId(sub.subId)
      } else {
        base
      }
      val cells = readCells(tm).mapNotNull(::cellToMap)
      val netType = try {
        networkTypeName(tm.dataNetworkType)
      } catch (_: SecurityException) {
        null
      }
      mapOf("slot" to sub.slot, "subId" to sub.subId, "netType" to netType, "cells" to cells)
    }
  }

  /** Fresh measurements on API 29+ (requestCellInfoUpdate), else the modem's cached list. */
  private suspend fun readCells(tm: TelephonyManager): List<CellInfo> {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val fresh = withTimeoutOrNull(5_000L) {
          suspendCancellableCoroutine<List<CellInfo>?> { cont ->
            tm.requestCellInfoUpdate(executor, object : TelephonyManager.CellInfoCallback() {
              override fun onCellInfo(cellInfo: MutableList<CellInfo>) {
                if (cont.isActive) cont.resume(cellInfo)
              }

              override fun onError(errorCode: Int, detail: Throwable?) {
                if (cont.isActive) cont.resume(null)
              }
            })
          }
        }
        if (fresh != null) return fresh
      }
      return tm.allCellInfo ?: emptyList()
    } catch (_: SecurityException) {
      return emptyList()
    }
  }

  companion object {
    private val executor = Executors.newSingleThreadExecutor()
    private const val UNAVAILABLE = Int.MAX_VALUE // CellInfo.UNAVAILABLE (public constant from API 29)
    private const val UNAVAILABLE_LONG = Long.MAX_VALUE // CellInfo.UNAVAILABLE_LONG

    private fun i(v: Int): Int? = if (v == UNAVAILABLE || v == Int.MIN_VALUE) null else v
    private fun l(v: Long): Long? = if (v == UNAVAILABLE_LONG || v == Long.MIN_VALUE) null else v
    private fun s(v: String?): Int? = v?.toIntOrNull()

    fun cellToMap(ci: CellInfo): Map<String, Any?>? {
      val m = HashMap<String, Any?>()
      m["reg"] = ci.isRegistered
      when (ci) {
        is CellInfoLte -> {
          val id = ci.cellIdentity
          val sig = ci.cellSignalStrength
          m["radio"] = "LTE"
          putMccMnc(m, if (Build.VERSION.SDK_INT >= 28) s(id.mccString) else i(id.mcc),
            if (Build.VERSION.SDK_INT >= 28) s(id.mncString) else i(id.mnc))
          m["area"] = i(id.tac)
          m["cid"] = i(id.ci)
          m["pci"] = i(id.pci)
          m["earfcn"] = if (Build.VERSION.SDK_INT >= 24) i(id.earfcn) else null
          m["rsrp"] = i(sig.rsrp)
          m["rsrq"] = i(sig.rsrq)
          m["rssnr"] = i(sig.rssnr)
          m["rssi"] = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) i(sig.rssi) else null
          m["ta"] = i(sig.timingAdvance)
          m["level"] = sig.level
        }
        is CellInfoGsm -> {
          val id = ci.cellIdentity
          val sig = ci.cellSignalStrength
          m["radio"] = "GSM"
          putMccMnc(m, if (Build.VERSION.SDK_INT >= 28) s(id.mccString) else i(id.mcc),
            if (Build.VERSION.SDK_INT >= 28) s(id.mncString) else i(id.mnc))
          m["area"] = i(id.lac)
          m["cid"] = i(id.cid)
          m["pci"] = null
          m["earfcn"] = if (Build.VERSION.SDK_INT >= 24) i(id.arfcn) else null // ARFCN
          m["rssi"] = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) i(sig.rssi) else i(sig.dbm)
          m["ta"] = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) i(sig.timingAdvance) else null
          m["level"] = sig.level
        }
        is CellInfoWcdma -> {
          // Android's name is kept ("WCDMA"); the API stores it as UMTS. RSCP goes in rsrp and Ec/No in rsrq
          // (the closest schema fields), PSC in pci, UARFCN in earfcn.
          val id = ci.cellIdentity
          val sig = ci.cellSignalStrength
          m["radio"] = "WCDMA"
          putMccMnc(m, if (Build.VERSION.SDK_INT >= 28) s(id.mccString) else i(id.mcc),
            if (Build.VERSION.SDK_INT >= 28) s(id.mncString) else i(id.mnc))
          m["area"] = i(id.lac)
          m["cid"] = i(id.cid)
          m["pci"] = i(id.psc)
          m["earfcn"] = if (Build.VERSION.SDK_INT >= 24) i(id.uarfcn) else null
          m["rsrp"] = i(sig.dbm)
          m["rsrq"] = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) i(sig.ecNo) else null
          m["level"] = sig.level
        }
        is CellInfoCdma -> {
          val id = ci.cellIdentity
          val sig = ci.cellSignalStrength
          m["radio"] = "CDMA"
          m["area"] = i(id.networkId)
          m["cid"] = i(id.basestationId)
          m["rssi"] = i(sig.dbm)
          m["level"] = sig.level
        }
        else -> {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && ci is CellInfoNr) {
            val id = ci.cellIdentity as CellIdentityNr
            val sig = ci.cellSignalStrength as CellSignalStrengthNr
            m["radio"] = "NR"
            putMccMnc(m, s(id.mccString), s(id.mncString))
            m["area"] = i(id.tac)
            m["cid"] = l(id.nci)
            m["pci"] = i(id.pci)
            m["earfcn"] = i(id.nrarfcn) // NR-ARFCN
            m["rsrp"] = i(sig.ssRsrp)
            m["rsrq"] = i(sig.ssRsrq)
            m["rssnr"] = i(sig.ssSinr)
            m["level"] = sig.level
          } else {
            return null // TD-SCDMA and unknown radios are not in the payload schema
          }
        }
      }
      for (k in listOf("mcc", "mnc", "area", "cid", "pci", "earfcn", "rsrp", "rsrq", "rssnr", "rssi", "ta", "level")) {
        if (!m.containsKey(k)) m[k] = null
      }
      return m
    }

    private fun putMccMnc(m: HashMap<String, Any?>, mcc: Int?, mnc: Int?) {
      m["mcc"] = mcc
      m["mnc"] = mnc
    }

    fun networkTypeName(t: Int): String? = when (t) {
      TelephonyManager.NETWORK_TYPE_GPRS -> "GPRS"
      TelephonyManager.NETWORK_TYPE_EDGE -> "EDGE"
      TelephonyManager.NETWORK_TYPE_UMTS -> "UMTS"
      TelephonyManager.NETWORK_TYPE_CDMA -> "CDMA"
      TelephonyManager.NETWORK_TYPE_EVDO_0 -> "EVDO_0"
      TelephonyManager.NETWORK_TYPE_EVDO_A -> "EVDO_A"
      TelephonyManager.NETWORK_TYPE_1xRTT -> "1xRTT"
      TelephonyManager.NETWORK_TYPE_HSDPA -> "HSDPA"
      TelephonyManager.NETWORK_TYPE_HSUPA -> "HSUPA"
      TelephonyManager.NETWORK_TYPE_HSPA -> "HSPA"
      TelephonyManager.NETWORK_TYPE_EVDO_B -> "EVDO_B"
      TelephonyManager.NETWORK_TYPE_EHRPD -> "EHRPD"
      TelephonyManager.NETWORK_TYPE_HSPAP -> "HSPAP"
      TelephonyManager.NETWORK_TYPE_GSM -> "GSM"
      TelephonyManager.NETWORK_TYPE_TD_SCDMA -> "TD_SCDMA"
      TelephonyManager.NETWORK_TYPE_IWLAN -> "IWLAN"
      TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
      20 -> "NR" // TelephonyManager.NETWORK_TYPE_NR, API 29
      else -> null
    }
  }
}
