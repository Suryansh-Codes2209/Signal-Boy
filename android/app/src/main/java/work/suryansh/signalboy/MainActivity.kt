package work.suryansh.signalboy

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
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

    companion object {
        /**
         * How long the splash screen is held, absent a tap. The one place this
         * duration lives -- change this constant, nothing else, to change how
         * long the DMG-green splash shows.
         */
        private const val SPLASH_MIN_DURATION_MS = 5000L
    }

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var bridge: WifiBridge
    private var pushing = false

    /** Matches SIGNALBOY_WIFI_INTERVAL's default in the daemon. */
    private val intervalMs = 1000

    private val splashStartMs = SystemClock.uptimeMillis()

    // Flipped by dispatchTouchEvent() below. Five seconds is a long time to
    // wait for a tool you open to glance at a signal reading, so a tap skips
    // the rest of the hold instead of trapping the user on the splash panel.
    private var splashDismissed = false

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            // The JS side re-reads the grants rather than trusting this payload,
            // so the two can never disagree.
            webView.evaluateJavascript("window.__signalboyPermissions?.()", null)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must run before super.onCreate() -- the library reads the activity's
        // theme (Theme.App.Starting) at that point to draw the splash, then
        // swaps in postSplashScreenTheme once keepOnScreenCondition below
        // returns false.
        val splashScreen = installSplashScreen()
        super.onCreate(savedInstanceState)

        // Time- or tap-gated only. Neither branch reads WebView/page-load
        // state, so a WebView error (or anything else going wrong below)
        // cannot leave the splash stuck on screen forever, and this in no way
        // delays the WebView construction/loadUrl() later in this method --
        // that runs regardless of whether the splash is still showing.
        splashScreen.setKeepOnScreenCondition {
            !splashDismissed && SystemClock.uptimeMillis() - splashStartMs < SPLASH_MIN_DURATION_MS
        }

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
     * Requested on demand, not at launch.
     *
     * dBm needs no permission, so the meter works the instant the app opens. Only
     * network identity and the nearby list need a grant, and asking for Location
     * before showing anything reads as a WiFi app demanding your position.
     */
    private fun requestWifiPermissions() {
        // @JavascriptInterface methods (this is reached from WifiBridge's
        // onRequestPermissions callback) run on the WebView's JavaBridge thread,
        // not the main thread. ActivityResultLauncher.launch() must run on the
        // main thread or it crashes (or, worse, silently no-ops) -- post it.
        handler.post {
            val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                wanted.add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
            permissionLauncher.launch(wanted.toTypedArray())
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Any touch down while the splash is showing skips the rest of the hold.
     * dispatchTouchEvent() sees every touch delivered to the window before
     * child views do, which is what lets this work whether the splash is
     * still the compat overlay view or (API 31+) the platform's own -- the
     * event still passes through to super() unmodified either way, so normal
     * WebView touch handling after dismissal is unaffected.
     */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) splashDismissed = true
        return super.dispatchTouchEvent(ev)
    }
}
