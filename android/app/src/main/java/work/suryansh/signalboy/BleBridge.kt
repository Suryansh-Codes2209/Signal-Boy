package work.suryansh.signalboy

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * BluetoothLeScanner, exposed to JavaScript as raw values and nothing more.
 *
 * Same discipline as WifiBridge: no distance, no "this looks like a tracker"
 * guess, no grading. All of that lives in public/js/sources/ble-map.js, where
 * node --test covers it against captured payloads with no device involved.
 *
 * BLE is deliberately a second JavaScript interface (SignalBoyBle) rather than
 * folded into WifiBridge/SignalBoyNative. It has its own permission model
 * (BLUETOOTH_SCAN/CONNECT on API 31+, location below it), its own start/stop
 * lifecycle that JS drives directly rather than Kotlin pushing on a timer, and
 * its own failure modes (radio off vs. permission denied). Keeping it a
 * separate object means a Bluetooth problem is legible on its own and can
 * never be confused for -- or block -- the WiFi meter.
 */
class BleBridge(
    private val context: Context,
    private val onRequestPermissions: () -> Unit,
) {
    private val adapter: BluetoothAdapter? =
        (context.applicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    /** Latest advertisement per address. A rotated MAC just becomes a new key. */
    private val devices = LinkedHashMap<String, JSONObject>()
    private val lock = Any()

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val record = result.scanRecord
            val txPower = record?.txPowerLevel
            val entry = JSONObject().apply {
                put("address", result.device.address)
                put("rssi", result.rssi)
                put("name", record?.deviceName ?: connectedNameOrNull(result))
                put(
                    // ScanRecord.getTxPowerLevel()'s "not present" sentinel is
                    // Int.MIN_VALUE, NOT ScanResult.TX_POWER_NOT_PRESENT (127) --
                    // that constant belongs to the unrelated ScanResult.getTxPower(),
                    // an extended-advertising field this app never reads. Guarding
                    // against the wrong sentinel let Int.MIN_VALUE through as if it
                    // were a real reading (confirmed on-device: rows showed
                    // "TX -2147483648 DBM").
                    "txPower",
                    if (txPower != null && txPower != Int.MIN_VALUE) txPower else JSONObject.NULL,
                )
                put("connectable", result.isConnectable)
                // Wall-clock time of receipt, not ScanResult.getTimestampNanos() --
                // that value is nanoseconds since boot (elapsedRealtimeNanos) and
                // means nothing on the JS side without a second reference point
                // crossing the same bridge. This is still a raw fact (when the
                // bridge itself saw the advertisement), not an interpretation.
                put("timestamp", System.currentTimeMillis())
            }
            synchronized(lock) { devices[result.device.address] = entry }
        }

        override fun onScanFailed(errorCode: Int) {
            synchronized(lock) { scanning = false }
        }
    }

    /**
     * ScanRecord.getDeviceName() is the advertised local name and needs no
     * extra grant beyond BLUETOOTH_SCAN. BluetoothDevice.getName() can supply a
     * name the OS cached from a past pairing when the advertisement omits one,
     * but reading it is gated behind BLUETOOTH_CONNECT on API 31+ -- this skips
     * it rather than let a SecurityException take down the whole scan callback.
     */
    private fun connectedNameOrNull(result: ScanResult): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
            return null
        }
        return try {
            result.device.name
        } catch (e: SecurityException) {
            null
        }
    }

    @JavascriptInterface
    fun startScan(): String {
        val bt = adapter ?: return JSONObject().put("ok", false).put("error", "UNSUPPORTED").toString()

        // Bluetooth being off and the permission being denied are different
        // problems with different fixes (Settings toggle vs. a permission
        // prompt), so they are reported as distinct error codes rather than one
        // generic failure -- ble-map.js turns each into its own copy.
        if (!bt.isEnabled) {
            return JSONObject().put("ok", false).put("error", "BLUETOOTH_DISABLED").toString()
        }
        if (!canScan()) {
            return JSONObject().put("ok", false).put("error", "PERMISSION_DENIED").toString()
        }
        if (scanning) return JSONObject().put("ok", true).toString()

        val bleScanner = bt.bluetoothLeScanner
            ?: return JSONObject().put("ok", false).put("error", "SCANNER_UNAVAILABLE").toString()

        // Low latency, deliberately: this is the one capability BLE has that
        // WiFi scanning does not (see WifiBridge's 4-per-2-minutes throttle),
        // and it is what makes walking a device down in real time possible.
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        synchronized(lock) { devices.clear() }
        return try {
            bleScanner.startScan(null, settings, callback)
            scanner = bleScanner
            scanning = true
            JSONObject().put("ok", true).toString()
        } catch (e: SecurityException) {
            JSONObject().put("ok", false).put("error", "PERMISSION_DENIED").toString()
        }
    }

    @JavascriptInterface
    fun stopScan() {
        if (!scanning) return
        try {
            scanner?.stopScan(callback)
        } catch (e: SecurityException) {
            // A grant revoked mid-scan (via Settings) makes stopScan() throw too;
            // there is nothing left to clean up on the platform side either way.
        }
        scanning = false
    }

    @JavascriptInterface
    fun results(): String {
        val arr = JSONArray()
        synchronized(lock) { for (d in devices.values) arr.put(d) }
        return JSONObject().put("scanning", scanning).put("devices", arr).toString()
    }

    @JavascriptInterface
    fun permissions(): String = JSONObject().apply {
        put("bluetoothEnabled", adapter?.isEnabled == true)
        put("scanGranted", canScan())
        put(
            "connectGranted",
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) granted(Manifest.permission.BLUETOOTH_CONNECT) else true,
        )
    }.toString()

    @JavascriptInterface
    fun requestPermissions() {
        onRequestPermissions()
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** API 31+ scans under BLUETOOTH_SCAN; API <=30 needs location instead. */
    private fun canScan(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }
}
