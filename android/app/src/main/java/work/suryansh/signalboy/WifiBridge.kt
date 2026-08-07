package work.suryansh.signalboy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * WifiManager, exposed to JavaScript as raw values and nothing more.
 *
 * There is deliberately no interpretation here: no frequency-to-channel
 * arithmetic, no band inference, no unit conversion, no grading. All of that
 * lives in public/js/sources/android-map.js, where `node --test` covers it
 * against captured payloads. Testing the same logic here would require
 * Robolectric or a device, and this project's test suite has neither.
 *
 * Everything crosses the boundary as a JSON string, because that is all
 * @JavascriptInterface can carry reliably.
 */
class WifiBridge(
    private val context: Context,
    private val intervalMs: Int,
    private val onRequestPermissions: () -> Unit,
) {

    private val wifi: WifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private val connectivity: ConnectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    /** Android allows 4 foreground scans per 2 minutes. Tracked so we can say how long is left. */
    private val scanTimestamps = ArrayDeque<Long>()

    @JavascriptInterface
    fun intervalMs(): Int = intervalMs

    /**
     * getConnectionInfo() is deprecated since API 31 in favour of reading
     * WifiInfo off a NetworkCallback's NetworkCapabilities. It still returns
     * correct values through API 36, and the callback route would put state
     * management in Kotlin -- exactly what this class exists to avoid.
     *
     * WifiInfo.getNetworkId() is deliberately not read here at all: for any
     * app targeting API 33+ (this one targets 36), the platform hands back
     * INVALID_NETWORK_ID unconditionally, regardless of permissions or actual
     * association. Sending that field would just ship a permanent sentinel
     * across the bridge. Association is instead read off ConnectivityManager,
     * which still reports it honestly.
     */
    @Suppress("DEPRECATION")
    @JavascriptInterface
    fun readConnected(): String {
        val connected = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true

        val info = wifi.connectionInfo
            ?: return JSONObject().put("connected", connected).toString()

        return JSONObject().apply {
            put("connected", connected)
            put("rssi", info.rssi)
            put("frequency", info.frequency)
            put("linkSpeed", info.linkSpeed)
            put("ssid", info.ssid)
            put("bssid", info.bssid)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                put("wifiStandard", info.wifiStandard)
            } else {
                put("wifiStandard", JSONObject.NULL)
            }
        }.toString()
    }

    @JavascriptInterface
    fun permissions(): String = JSONObject().apply {
        put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION))
        put(
            "nearbyDevices",
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                granted(Manifest.permission.NEARBY_WIFI_DEVICES)
            } else {
                granted(Manifest.permission.ACCESS_FINE_LOCATION)
            },
        )
    }.toString()

    @JavascriptInterface
    fun requestPermissions() {
        onRequestPermissions()
    }

    @Suppress("DEPRECATION")
    @JavascriptInterface
    fun scan(): String {
        if (!canScan()) {
            return JSONObject().put("ok", false).put("permissionDenied", true).toString()
        }

        val remaining = throttleRemainingMs()
        if (remaining > 0) {
            return JSONObject().put("ok", false).put("throttled", true).put("retryInMs", remaining).toString()
        }

        scanTimestamps.addLast(System.currentTimeMillis())
        wifi.startScan()

        // getScanResults() returns the most recent completed scan immediately.
        // startScan() above refreshes it for the next call rather than blocking
        // this one, which keeps the bridge synchronous.
        val results = JSONArray()
        for (r in wifi.scanResults) {
            results.put(
                JSONObject().apply {
                    put("ssid", r.SSID)
                    put("bssid", r.BSSID)
                    put("level", r.level)
                    put("frequency", r.frequency)
                    put("capabilities", r.capabilities)
                },
            )
        }

        return JSONObject().put("ok", true).put("results", results).toString()
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun canScan(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** Milliseconds until a 5th scan would be allowed, or 0 if one is allowed now. */
    private fun throttleRemainingMs(): Long {
        val now = System.currentTimeMillis()
        val windowStart = now - SCAN_WINDOW_MS
        while (scanTimestamps.isNotEmpty() && scanTimestamps.first() < windowStart) {
            scanTimestamps.removeFirst()
        }
        if (scanTimestamps.size < SCANS_PER_WINDOW) return 0
        return scanTimestamps.first() + SCAN_WINDOW_MS - now
    }

    companion object {
        private const val SCAN_WINDOW_MS = 120_000L
        private const val SCANS_PER_WINDOW = 4
    }
}
