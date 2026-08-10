package work.suryansh.signalboy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.ranging.RangingCapabilities
import android.ranging.RangingData
import android.ranging.RangingDevice
import android.ranging.RangingManager
import android.ranging.RangingPreference
import android.ranging.RangingSession
import android.ranging.SessionConfig
import android.ranging.ble.cs.BleCsRangingParams
import android.ranging.ble.rssi.BleRssiRangingParams
import android.ranging.raw.RawInitiatorRangingConfig
import android.ranging.raw.RawRangingDevice
import android.webkit.JavascriptInterface
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * RangingManager, exposed to JavaScript as raw values and nothing more.
 *
 * Same discipline as WifiBridge/BleBridge/TelephonyBridge: platform constants
 * cross the bridge as the integers the platform defines them as, and every
 * judgment -- which technology is precise enough to trust, whether an azimuth
 * counts as a bearing, how many decimals a reading has earned -- lives in
 * public/js/sources/range-map.js under `node --test`. Mapping technology ints
 * to names here would be the same mistake as converting frequency to channel
 * here; android-map.js owns that class of work.
 *
 * WHY THIS IS NOT A "DISTANCE FOR EVERY DEVICE IN HUNT" BRIDGE
 *
 * Ranging is a two-way protocol: the peer's controller has to answer. The raw
 * configuration used below needs nothing but the peer's MAC address -- which
 * HUNT already reads off every advertisement -- so there is no pairing UI and
 * no out-of-band channel to build. But a peer whose radio does not implement
 * Channel Sounding simply never produces a fix, and that silence is reported as
 * silence. An RSSI-only tracker stays exactly as undistanced as it is today.
 *
 * UWB is deliberately absent. UwbRangingParams requires both devices' UWB
 * addresses and a shared session key, which means an out-of-band negotiation
 * channel (see android.ranging.oob.TransportHandle, an interface the app would
 * have to implement over GATT). That is a subsystem, not a parameter, and it is
 * left for its own change rather than half-built here.
 *
 * Every android.ranging reference sits behind an API 36 check. minSdk is 26, so
 * the session and capability handles are held as Any? -- a field's type is
 * resolved when the class loads, and these types do not exist on an Android 8
 * device that is otherwise running this app perfectly well.
 */
class RangeBridge(
    private val context: Context,
    private val onRequestPermissions: () -> Unit,
) {

    private val lock = Any()
    private val executor: Executor = Executors.newSingleThreadExecutor()

    /** RangingSession, RangingCapabilities and the capabilities callback. See the class comment. */
    private var sessionRef: Any? = null
    private var capsRef: Any? = null
    private var capsCallbackRef: Any? = null

    private var running = false

    /** Why the last session ended, so a stopped panel can say more than "stopped". */
    private var stopReason: String? = null

    /** Latest fix per peer address. A peer that goes quiet keeps its last entry with a null distance. */
    private val fixes = LinkedHashMap<String, JSONObject>()

    /** RangingDevice UUID -> the MAC the session was started with; onResults reports the former. */
    private val addressByUuid = LinkedHashMap<String, String>()

    // ---------------------------------------------------------------- capabilities

    /**
     * What this handset can range with.
     *
     * getTechnologyAvailability() reports far more than available/unavailable:
     * a technology can be off because the hardware lacks it, because the user
     * disabled the radio, or because of regulatory restrictions in this
     * country. Those are different problems with different fixes, so the raw
     * availability integer is forwarded rather than flattened to a boolean --
     * the same reasoning that keeps BLUETOOTH_DISABLED and PERMISSION_DENIED
     * separate in BleBridge.
     *
     * Delivery is asynchronous, so the first call after boot reports PENDING
     * rather than an empty technology list, which JS would otherwise be right
     * to read as "this phone can do nothing".
     */
    @JavascriptInterface
    fun capabilities(): String {
        if (Build.VERSION.SDK_INT < 36) return err("REQUIRES_ANDROID_16")
        return capabilitiesApi36()
    }

    @RequiresApi(36)
    private fun capabilitiesApi36(): String {
        val manager = manager() ?: return err("NO_RANGING_HARDWARE")
        registerCaps(manager)

        val caps = synchronized(lock) { capsRef } as? RangingCapabilities
            ?: return err("CAPABILITIES_PENDING")

        val technologies = JSONArray()
        for ((technology, availability) in caps.technologyAvailability) {
            technologies.put(
                JSONObject().put("id", technology).put("availability", availability),
            )
        }
        return JSONObject().put("supported", true).put("technologies", technologies).toString()
    }

    @RequiresApi(36)
    private fun registerCaps(manager: RangingManager) {
        synchronized(lock) {
            if (capsCallbackRef != null) return
            val callback = RangingManager.RangingCapabilitiesCallback { capabilities ->
                synchronized(lock) { capsRef = capabilities }
            }
            capsCallbackRef = callback
            manager.registerCapabilitiesCallback(executor, callback)
        }
    }

    // ---------------------------------------------------------------- session

    /**
     * Start ranging a peer by its BLE MAC address.
     *
     * `technology` picks between Channel Sounding (timed, sub-metre) and BLE
     * RSSI (estimated). Both are offered because the platform offers both, and
     * range-map.js is what makes sure an estimate never reaches the screen
     * dressed as a measurement.
     */
    @JavascriptInterface
    fun startSession(address: String?, technology: Int): String {
        if (Build.VERSION.SDK_INT < 36) return err("REQUIRES_ANDROID_16")
        if (address.isNullOrBlank()) return err("NO_PEER")
        if (!canRange()) return err("PERMISSION_DENIED")
        return startSessionApi36(address, technology)
    }

    @RequiresApi(36)
    private fun startSessionApi36(address: String, technology: Int): String {
        val manager = manager() ?: return err("NO_RANGING_HARDWARE")

        synchronized(lock) {
            if (running) return JSONObject().put("ok", true).toString()
            fixes.clear()
            addressByUuid.clear()
            stopReason = null
        }

        val device = RangingDevice.Builder().build()
        val rawDevice = RawRangingDevice.Builder()
            .setRangingDevice(device)
            .apply {
                // UPDATE_RATE_FREQUENT for the same reason BleBridge scans at
                // SCAN_MODE_LOW_LATENCY: this display is walked around a room,
                // and a lazy update rate would make the ruler lag the walker.
                if (technology == RangingManager.BLE_RSSI) {
                    setBleRssiRangingParams(
                        BleRssiRangingParams.Builder(address)
                            .setRangingUpdateRate(RawRangingDevice.UPDATE_RATE_FREQUENT)
                            .build(),
                    )
                } else {
                    setCsRangingParams(
                        BleCsRangingParams.Builder(address)
                            .setRangingUpdateRate(RawRangingDevice.UPDATE_RATE_FREQUENT)
                            .build(),
                    )
                }
            }
            .build()

        val config = RawInitiatorRangingConfig.Builder().addRawRangingDevice(rawDevice).build()

        // Neither BLE technology produces an angle, so asking for one would
        // spend power on a measurement that cannot arrive. When UWB lands this
        // becomes conditional, not unconditionally true.
        val sessionConfig = SessionConfig.Builder().setAngleOfArrivalNeeded(false).build()

        val preference = RangingPreference
            .Builder(RangingPreference.DEVICE_ROLE_INITIATOR, config)
            .setSessionConfig(sessionConfig)
            .build()

        return try {
            // Documented as non-null, but it arrives as a platform type and the
            // service can be absent on a device whose ranging module is stubbed
            // out. Treating that as a session failure beats an NPE inside a
            // @JavascriptInterface method, where the exception would surface to
            // JS as an opaque bridge error with nothing to act on.
            val session = manager.createRangingSession(executor, callback(address))
                ?: return err("SESSION_FAILED")
            session.start(preference)
            synchronized(lock) {
                sessionRef = session
                running = true
                addressByUuid[device.uuid.toString()] = address
            }
            JSONObject().put("ok", true).toString()
        } catch (e: SecurityException) {
            err("PERMISSION_DENIED")
        } catch (e: IllegalStateException) {
            err("SESSION_FAILED")
        }
    }

    @RequiresApi(36)
    private fun callback(address: String) = object : RangingSession.Callback {
        override fun onOpened() = Unit

        override fun onOpenFailed(reason: Int) {
            synchronized(lock) {
                running = false
                stopReason = closeReason(reason)
            }
        }

        override fun onStarted(peer: RangingDevice, technology: Int) {
            synchronized(lock) { addressByUuid[peer.uuid.toString()] = address }
        }

        override fun onResults(peer: RangingDevice, data: RangingData) {
            val key = synchronized(lock) { addressByUuid[peer.uuid.toString()] } ?: address
            val entry = JSONObject().apply {
                put("peerId", key)
                // getDistance() is nullable in practice: a session can report an
                // azimuth-only or RSSI-only sample. JSONObject.NULL rather than a
                // zero, so range-map.js sees a dropped sample and says so instead
                // of drawing the peer at the centre of the board.
                val distance = data.distance
                put("metres", if (distance != null) distance.measurement else JSONObject.NULL)
                put("confidence", if (distance != null) distance.confidence else JSONObject.NULL)
                put("technology", data.rangingTechnology)
                val azimuth = data.azimuth
                put("azimuth", if (azimuth != null) azimuth.measurement else JSONObject.NULL)
                val elevation = data.elevation
                put("elevation", if (elevation != null) elevation.measurement else JSONObject.NULL)
                put("rssi", if (data.hasRssi()) data.rssi else JSONObject.NULL)
                put("timestamp", data.timestampMillis)
            }
            synchronized(lock) { fixes[key] = entry }
        }

        override fun onStopped(peer: RangingDevice, reason: Int) {
            synchronized(lock) { stopReason = closeReason(reason) }
        }

        override fun onClosed(reason: Int) {
            synchronized(lock) {
                running = false
                stopReason = closeReason(reason)
            }
        }
    }

    /**
     * REASON_NO_PEERS_FOUND is the expected outcome for most of HUNT's list,
     * not an error: it is what a device that does not implement Channel
     * Sounding looks like from here. It gets its own code so the view can say
     * "this device cannot be ranged" rather than "something went wrong".
     */
    private fun closeReason(reason: Int): String = when (reason) {
        RangingSession.Callback.REASON_NO_PEERS_FOUND -> "PEER_CANNOT_RANGE"
        RangingSession.Callback.REASON_UNSUPPORTED -> "UNSUPPORTED"
        RangingSession.Callback.REASON_SYSTEM_POLICY -> "SYSTEM_POLICY"
        RangingSession.Callback.REASON_LOCAL_REQUEST -> "STOPPED"
        RangingSession.Callback.REASON_REMOTE_REQUEST -> "PEER_LOST"
        else -> "SESSION_FAILED"
    }

    @JavascriptInterface
    fun stopSession() {
        if (Build.VERSION.SDK_INT < 36) return
        stopSessionApi36()
    }

    @RequiresApi(36)
    private fun stopSessionApi36() {
        val session = synchronized(lock) {
            if (!running) return
            running = false
            sessionRef as? RangingSession
        } ?: return
        try {
            session.stop()
            session.close()
        } catch (e: SecurityException) {
            // A grant revoked mid-session makes stop() throw as well; the
            // session is already unreachable either way, same as BleBridge.
        } finally {
            synchronized(lock) { sessionRef = null }
        }
    }

    @JavascriptInterface
    fun results(): String {
        val peers = JSONArray()
        val (isRunning, reason) = synchronized(lock) {
            for (fix in fixes.values) peers.put(fix)
            running to stopReason
        }
        return JSONObject().apply {
            put("running", isRunning)
            put("peers", peers)
            if (reason != null) put("error", reason)
        }.toString()
    }

    // ---------------------------------------------------------------- permissions

    @JavascriptInterface
    fun permissions(): String = JSONObject().apply {
        put("ranging", if (Build.VERSION.SDK_INT >= 36) granted(Manifest.permission.RANGING) else false)
        // Channel Sounding runs over a Bluetooth connection, so the connect
        // grant is part of the picture even though the scan grant is what HUNT
        // needed to find the peer in the first place.
        put(
            "bluetoothConnect",
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                granted(Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                true
            },
        )
        put("apiSupported", Build.VERSION.SDK_INT >= 36)
    }.toString()

    @JavascriptInterface
    fun requestPermissions() {
        onRequestPermissions()
    }

    // ---------------------------------------------------------------- internals

    @RequiresApi(36)
    private fun manager(): RangingManager? =
        context.applicationContext.getSystemService(RangingManager::class.java)

    private fun canRange(): Boolean =
        Build.VERSION.SDK_INT >= 36 && granted(Manifest.permission.RANGING)

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun err(code: String): String =
        JSONObject().put("supported", false).put("ok", false).put("error", code).toString()
}
