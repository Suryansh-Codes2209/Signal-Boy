package work.suryansh.signalboy

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.sqrt

/**
 * The one place this app sends network traffic, and it does so only on demand.
 *
 * Everything else in Signal Boy is receive-only. This bridge measures latency,
 * jitter and download throughput against a URL the user types, for the LINK
 * tab's active test -- which is why it lives behind a consent gate on the JS
 * side and why the INTERNET permission it needs is declared with a comment
 * saying exactly that. Nothing here runs until start() is called.
 *
 * The sockets run on a worker thread; @JavascriptInterface methods only start
 * it, read a volatile status snapshot, or cancel it. JS polls status() the same
 * way it polls BLE results, so the WebView thread never blocks on a socket.
 * Interpretation/formatting lives in public/js/sources/link-test-map.js.
 */
class NetTestBridge {

    private val lock = Any()
    private var state = "idle" // idle | running | done | error
    private var phase = ""
    private var pingMs: Double? = null
    private var jitterMs: Double? = null
    private var downMbps: Double? = null
    private var progress = 0.0
    private var error: String? = null

    /** Bumped on every start()/stop(); the worker exits when its id goes stale. */
    private var generation = 0
    private var worker: Thread? = null

    companion object {
        private const val PING_SAMPLES = 5
        private const val CONNECT_TIMEOUT_MS = 5000
        private const val DOWNLOAD_BUDGET_MS = 5000L
        private const val DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
    }

    @JavascriptInterface
    fun start(url: String): String {
        val target = url.trim()
        if (!(target.startsWith("http://") || target.startsWith("https://"))) {
            synchronized(lock) {
                state = "error"; error = "BAD_URL"; progress = 0.0
            }
            return status()
        }

        val myGen: Int
        synchronized(lock) {
            generation += 1
            myGen = generation
            state = "running"; phase = "ping"; progress = 0.0
            pingMs = null; jitterMs = null; downMbps = null; error = null
        }

        worker = Thread { run(target, myGen) }.apply { isDaemon = true; start() }
        return status()
    }

    private fun isCurrent(myGen: Int): Boolean = synchronized(lock) { generation == myGen && state == "running" }

    private fun run(target: String, myGen: Int) {
        try {
            val url = URL(target)

            // Latency: time to open a connection, sampled a few times. Jitter is
            // the standard deviation of those samples -- the same stability idea
            // the passive tab applies to RSSI, here applied to round-trip setup.
            val samples = mutableListOf<Double>()
            for (i in 0 until PING_SAMPLES) {
                if (!isCurrent(myGen)) return
                samples.add(connectMillis(url))
                synchronized(lock) { progress = (i + 1).toDouble() / PING_SAMPLES * 0.4 }
            }
            val avg = samples.average()
            val variance = samples.sumOf { (it - avg) * (it - avg) } / samples.size
            synchronized(lock) {
                pingMs = avg
                jitterMs = sqrt(variance)
                phase = "download"
            }

            // Throughput: pull the URL for a fixed budget and divide bytes by
            // time. Capped by both a byte ceiling and a time budget so it never
            // runs away on a fast link or a huge file.
            val bytes = downloadBytes(url, myGen)
            if (!isCurrent(myGen)) return
            synchronized(lock) {
                downMbps = bytes.first * 8.0 / (bytes.second / 1000.0) / 1_000_000.0
                progress = 1.0
                state = "done"
            }
        } catch (e: Exception) {
            synchronized(lock) {
                if (generation == myGen) {
                    state = "error"
                    error = if (e is java.net.SocketTimeoutException) "TIMEOUT" else "UNREACHABLE"
                }
            }
        }
    }

    private fun connectMillis(url: URL): Double {
        val conn = url.openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "HEAD"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = CONNECT_TIMEOUT_MS
            val start = System.nanoTime()
            conn.connect()
            conn.responseCode
            (System.nanoTime() - start) / 1_000_000.0
        } finally {
            conn.disconnect()
        }
    }

    /** Returns (bytesRead, elapsedMillis). */
    private fun downloadBytes(url: URL, myGen: Int): Pair<Long, Long> {
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = CONNECT_TIMEOUT_MS
        return try {
            conn.inputStream.use { input ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                val start = System.nanoTime()
                while (total < DOWNLOAD_MAX_BYTES && isCurrent(myGen)) {
                    val elapsed = (System.nanoTime() - start) / 1_000_000L
                    if (elapsed >= DOWNLOAD_BUDGET_MS) break
                    val n = input.read(buffer)
                    if (n < 0) break
                    total += n
                    synchronized(lock) { progress = 0.4 + (elapsed.toDouble() / DOWNLOAD_BUDGET_MS) * 0.6 }
                }
                val elapsed = ((System.nanoTime() - start) / 1_000_000L).coerceAtLeast(1)
                Pair(total, elapsed)
            }
        } finally {
            conn.disconnect()
        }
    }

    @JavascriptInterface
    fun stop() {
        synchronized(lock) {
            generation += 1 // strands any running worker
            state = "idle"; phase = ""; progress = 0.0
        }
    }

    @JavascriptInterface
    fun status(): String = synchronized(lock) {
        JSONObject().apply {
            put("state", state)
            put("phase", phase)
            put("pingMs", pingMs ?: JSONObject.NULL)
            put("jitterMs", jitterMs ?: JSONObject.NULL)
            put("downMbps", downMbps ?: JSONObject.NULL)
            put("progress", progress)
            put("error", error ?: JSONObject.NULL)
        }.toString()
    }
}
