package work.suryansh.signalboy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.CellSignalStrengthNr
import android.telephony.TelephonyManager
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * TelephonyManager cell info, exposed to JavaScript as raw values and nothing
 * more -- the same discipline as WifiBridge and BleBridge.
 *
 * This is READ-ONLY telephony state: which cells the modem sees and how strong
 * they are. There is deliberately no transmit path of any kind. The cellular
 * baseband is locked, signed firmware with no app-accessible way to emit RF, so
 * "leveraging the modem" to send anything is not something this bridge (or any
 * app) can do -- it only reads what the radio already reports.
 *
 * Kept a third, separate JavaScript interface (SignalBoyCell) for the same
 * reason BLE is separate from WiFi: its own permission model (READ_PHONE_STATE
 * plus location for cell identity), its own failure modes (no modem, airplane
 * mode), all legible on their own and unable to block the WiFi meter.
 *
 * All interpretation -- which cell serves, what band an EARFCN is, how to word a
 * permission error -- lives in public/js/sources/cell-map.js under node --test.
 */
class TelephonyBridge(
    private val context: Context,
    private val onRequestPermissions: () -> Unit,
) {
    private val telephony: TelephonyManager? =
        context.applicationContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager

    @JavascriptInterface
    fun read(): String {
        val tm = telephony
        if (tm == null || tm.phoneType == TelephonyManager.PHONE_TYPE_NONE) {
            return err("NO_TELEPHONY")
        }
        // getAllCellInfo needs location; identity fields additionally need
        // phone-state. Without both the read is a permission problem, not "no
        // service" -- report it as one so the view offers the prompt.
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) || !granted(Manifest.permission.READ_PHONE_STATE)) {
            return err("PERMISSION_DENIED")
        }

        val infos = try {
            tm.allCellInfo
        } catch (e: SecurityException) {
            return err("PERMISSION_DENIED")
        }
        if (infos.isNullOrEmpty()) return err("AIRPLANE")

        val cells = JSONArray()
        for (info in infos) {
            cellToJson(info)?.let { cells.put(it) }
        }
        return JSONObject().put("supported", true).put("cells", cells).toString()
    }

    private fun cellToJson(info: CellInfo): JSONObject? = try {
        when (info) {
            is CellInfoLte -> {
                val id = info.cellIdentity
                val ss = info.cellSignalStrength
                base("LTE", info)
                    .put("rsrp", ji(ss.rsrp))
                    .put("rsrq", ji(ss.rsrq))
                    .put("level", ss.level)
                    .put("cid", ji(id.ci))
                    .put("pci", ji(id.pci))
                    .put("tac", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ji(id.tac) else JSONObject.NULL)
                    .put("earfcn", ji(id.earfcn))
                    .put("mcc", id.mccStringOrNull() ?: JSONObject.NULL)
                    .put("mnc", id.mncStringOrNull() ?: JSONObject.NULL)
            }

            is CellInfoGsm -> {
                val id = info.cellIdentity
                val ss = info.cellSignalStrength
                base("GSM", info)
                    .put("rssi", ji(ss.dbm))
                    .put("level", ss.level)
                    .put("cid", ji(id.cid))
                    .put("lac", ji(id.lac))
                    .put("arfcn", ji(id.arfcn))
                    .put("mcc", id.mccStringOrNull() ?: JSONObject.NULL)
                    .put("mnc", id.mncStringOrNull() ?: JSONObject.NULL)
            }

            is CellInfoWcdma -> {
                val id = info.cellIdentity
                val ss = info.cellSignalStrength
                base("WCDMA", info)
                    .put("rscp", ji(ss.dbm))
                    .put("level", ss.level)
                    .put("cid", ji(id.cid))
                    .put("lac", ji(id.lac))
                    .put("pci", ji(id.psc))
                    .put("arfcn", ji(id.uarfcn))
                    .put("mcc", id.mccStringOrNull() ?: JSONObject.NULL)
                    .put("mnc", id.mncStringOrNull() ?: JSONObject.NULL)
            }

            else -> nrToJson(info)
        }
    } catch (e: Exception) {
        // A single malformed CellInfo must never take down the whole read.
        null
    }

    /**
     * NR (5G). The signal-strength getters are API 29, but the identity getters
     * (getNci/getTac/getNrarfcn/mccString) are API 30 -- so this is gated at R
     * to keep every call inside a valid version check. On API 29 a 5G cell
     * simply isn't reported here; the LTE/GSM/WCDMA cells still are.
     */
    private fun nrToJson(info: CellInfo): JSONObject? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || info !is CellInfoNr) return null
        val id = info.cellIdentity as? CellIdentityNr ?: return null
        val ss = info.cellSignalStrength as? CellSignalStrengthNr ?: return null
        return base("NR", info)
            .put("ssRsrp", ji(ss.ssRsrp))
            .put("ssRsrq", ji(ss.ssRsrq))
            .put("level", ss.level)
            .put("nci", jl(id.nci))
            .put("pci", ji(id.pci))
            .put("tac", ji(id.tac))
            .put("nrarfcn", ji(id.nrarfcn))
            .put("mcc", id.mccString ?: JSONObject.NULL)
            .put("mnc", id.mncString ?: JSONObject.NULL)
    }

    private fun base(type: String, info: CellInfo): JSONObject =
        JSONObject().put("type", type).put("registered", info.isRegistered)

    @JavascriptInterface
    fun permissions(): String = JSONObject().apply {
        put("phoneState", granted(Manifest.permission.READ_PHONE_STATE))
        put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION))
    }.toString()

    @JavascriptInterface
    fun requestPermissions() {
        onRequestPermissions()
    }

    private fun err(code: String): String =
        JSONObject().put("supported", false).put("error", code).toString()

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Integer.MAX_VALUE is CellInfo.UNAVAILABLE -- send null, not a bogus value. */
    private fun ji(v: Int): Any = if (v == Int.MAX_VALUE) JSONObject.NULL else v

    private fun jl(v: Long): Any = if (v == Long.MAX_VALUE) JSONObject.NULL else v
}

/**
 * mccString/mncString are API 28+. Below that the platform only exposes the
 * deprecated int getMcc()/getMnc(), whose UNAVAILABLE sentinel is
 * Integer.MAX_VALUE. These extensions hide that split so the call sites above
 * read the same on every supported SDK.
 */
private fun android.telephony.CellIdentityLte.mccStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString
    else @Suppress("DEPRECATION") mcc.takeIf { it != Int.MAX_VALUE }?.toString()

private fun android.telephony.CellIdentityLte.mncStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString
    else @Suppress("DEPRECATION") mnc.takeIf { it != Int.MAX_VALUE }?.toString()

private fun android.telephony.CellIdentityGsm.mccStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString
    else @Suppress("DEPRECATION") mcc.takeIf { it != Int.MAX_VALUE }?.toString()

private fun android.telephony.CellIdentityGsm.mncStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString
    else @Suppress("DEPRECATION") mnc.takeIf { it != Int.MAX_VALUE }?.toString()

private fun android.telephony.CellIdentityWcdma.mccStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString
    else @Suppress("DEPRECATION") mcc.takeIf { it != Int.MAX_VALUE }?.toString()

private fun android.telephony.CellIdentityWcdma.mncStringOrNull(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString
    else @Suppress("DEPRECATION") mnc.takeIf { it != Int.MAX_VALUE }?.toString()
