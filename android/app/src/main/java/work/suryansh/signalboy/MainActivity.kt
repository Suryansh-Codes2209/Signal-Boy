package work.suryansh.signalboy

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Hosts the Signal Boy UI in a WebView.
 *
 * The assets are served through WebViewAssetLoader rather than loaded from
 * file://, and that is load-bearing rather than tidy. The whole public/js tree
 * is ES modules, and module loading over file:// fails CORS -- the app would not
 * start. The loader's origin is also a secure context, so the Wake Lock API and
 * the sensor APIs the UI feature-detects are available, which over plain HTTP on
 * a LAN they are not. On Android the --https flag's problem simply does not
 * exist.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var bridge: WifiBridge
    private var pushing = false

    /** Matches SIGNALBOY_WIFI_INTERVAL's default in the daemon. */
    private val intervalMs = 1000

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Supersedes the three-mechanism degradation in public/js/wakelock.js:
        // the native flag always works, so walk mode never has to fall back.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // public/index.html references its CSS and entry module by root-absolute
        // path ("/css/pixel.css", "/js/app.js") because that is how the Express
        // server in public/ serves them from the domain root. Here the synced
        // copy lives under assets/www/, so the document request itself already
        // carries that prefix (the WebView navigates to .../www/index.html) but
        // requests for its root-absolute resources do not -- AssetsPathHandler
        // alone would 404 them against assets/css/... instead of assets/www/css/....
        // Re-add the prefix for any path that doesn't already have it.
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/") { path ->
                assetsHandler.handle(if (path.startsWith("www/")) path else "www/$path")
            }
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The UI draws its own pixel grid and must not be re-laid-out.
            settings.useWideViewPort = false
            settings.loadWithOverviewMode = false

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    // onPageFinished fires for Chromium's own error page too (a failed
                    // load keeps its navigation entry, so the url argument there is not
                    // a reliable signal). Reset here so a retried/reloaded navigation
                    // is free to call startPushing() again once a real page commits.
                    pushing = false
                }

                override fun onPageFinished(view: WebView, url: String) {
                    startPushing()
                }
            }
        }

        bridge = WifiBridge(this, intervalMs) { requestWifiPermissions() }
        webView.addJavascriptInterface(bridge, "SignalBoyNative")

        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    /**
     * Kotlin owns the cadence and pushes, rather than JavaScript polling across
     * the bridge. That mirrors the daemon's server-push SSE shape, so the JS
     * side sees the same event flow either way.
     */
    private fun startPushing() {
        if (pushing) return
        pushing = true

        val tick = object : Runnable {
            override fun run() {
                val json = bridge.readConnected()
                // JSONObject.quote is required, not decorative: bare interpolation hands
                // JavaScript an object *literal* ({"rssi":-58,...} evaluates as an
                // expression), not the JSON string native.js expects to JSON.parse.
                // parse() on an object coerces to the string "[object Object]", throws,
                // and every reading is silently dropped -- the meter never leaves
                // CONNECTING. Quoting makes the argument a JS string literal so
                // JSON.parse gets the text it actually needs.
                //
                // The typeof guard covers onPageFinished firing on a load that never
                // actually installed the hook (Chromium's own error page): without it
                // this tick would throw a TypeError once a second, forever, on top of
                // pushing() already being reset for a future real load.
                webView.evaluateJavascript(
                    "if (typeof window.__signalboyPush === 'function') { " +
                        "window.__signalboyPush(${JSONObject.quote(json)}); }",
                    null,
                )
                handler.postDelayed(this, intervalMs.toLong())
            }
        }
        handler.post(tick)
    }

    /**
     * Stub until Task 9 wires up the real ACCESS_FINE_LOCATION request flow.
     * requestPermissions() on the JS side already calls into this method, so it
     * must exist now even though it does nothing yet -- adding the actual
     * request here would be scope creep for this task, whose only job is
     * getting a raw RSSI value across the bridge.
     */
    private fun requestWifiPermissions() {
        // Intentionally no-op: see Task 9.
        //
        // Note for whoever wires this up: @JavascriptInterface methods (this is
        // called from WifiBridge's onRequestPermissions callback) run on the
        // WebView's JavaBridge thread, not the main thread. requestPermissions()
        // and any Activity UI work it triggers must be posted to `handler`
        // (main-thread Looper) before touching the Activity, or it will crash.
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }
}
