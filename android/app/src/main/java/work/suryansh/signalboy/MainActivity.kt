package work.suryansh.signalboy

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
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
         * How long the splash overlay is held, absent a tap. The one place
         * this duration lives -- change this constant, nothing else, to
         * change how long the DMG-green splash shows.
         */
        private const val SPLASH_MIN_DURATION_MS = 5000L
    }

    private lateinit var webView: WebView
    private lateinit var splashOverlay: View
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var bridge: WifiBridge
    private lateinit var bleBridge: BleBridge
    private var pushing = false

    /** Matches SIGNALBOY_WIFI_INTERVAL's default in the daemon. */
    private val intervalMs = 1000

    private val dismissSplashRunnable = Runnable { dismissSplash() }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            // The JS side re-reads the grants rather than trusting this payload,
            // so the two can never disagree. Both hooks are called unconditionally
            // -- whichever one the page hasn't defined is just a no-op via `?.`.
            webView.evaluateJavascript("window.__signalboyPermissions?.()", null)
            webView.evaluateJavascript("window.__signalboyBlePermissions?.()", null)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must run before super.onCreate() -- the library reads the activity's
        // theme (Theme.App.Starting) at that point to paint the cold-launch
        // frame (lcd-3 background + bot icon) instead of a blank white one
        // while the process is still spinning up.
        //
        // installSplashScreen() is deliberately NOT given a
        // setKeepOnScreenCondition() hold here. That API works by having the
        // OS delay the window's first real draw -- and a window the OS has
        // not yet finished drawing does not receive touch input at all
        // (confirmed on-device: 0 dispatchTouchEvent calls for the whole
        // held duration, every time). Holding the system splash open for 5s
        // would therefore make tap-to-dismiss impossible by construction: the
        // very tap meant to end the hold could never arrive. The 5s hold and
        // its tap-to-dismiss live instead in splashOverlay below, a normal
        // View in our own already-interactive window, which has no such
        // restriction.
        installSplashScreen()
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

        bleBridge = BleBridge(this) { requestBlePermissions() }
        webView.addJavascriptInterface(bleBridge, "SignalBoyBle")

        // Same lcd-3 + bot-foreground pairing as Theme.App.Starting, so the
        // handoff from the cold-launch system splash to this overlay is
        // visually seamless -- and unlike that splash, this is a plain View
        // in the normal (already touchable) content hierarchy, so the
        // isClickable/setOnClickListener below actually receives taps.
        val splashIcon = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher_foreground)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
        }
        val iconSizePx = (200 * resources.displayMetrics.density).toInt()
        splashOverlay = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.lcd_3))
            addView(
                splashIcon,
                FrameLayout.LayoutParams(iconSizePx, iconSizePx).apply { gravity = Gravity.CENTER },
            )
            isClickable = true
            setOnClickListener { dismissSplash() }
        }

        val root = FrameLayout(this).apply {
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(splashOverlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(root)

        // Posted, not run inline: this only starts the clock on the OVERLAY's
        // hold. It runs unconditionally and does not read WebView/page-load
        // state, so a WebView error below can never leave the overlay stuck,
        // and it in no way delays loadUrl() on the next line.
        handler.postDelayed(dismissSplashRunnable, SPLASH_MIN_DURATION_MS)

        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    /** Idempotent: reachable from both the 5s timeout and an early tap. */
    private fun dismissSplash() {
        if (splashOverlay.visibility == View.GONE) return
        splashOverlay.visibility = View.GONE
        handler.removeCallbacks(dismissSplashRunnable)
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

    /** Same main-thread requirement as requestWifiPermissions(); see its comment. */
    private fun requestBlePermissions() {
        handler.post {
            val wanted = mutableListOf<String>()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                wanted.add(Manifest.permission.BLUETOOTH_SCAN)
                wanted.add(Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                wanted.add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            permissionLauncher.launch(wanted.toTypedArray())
        }
    }

    /**
     * An unthrottled BLE scan left running while the app is backgrounded is a
     * pure battery cost with no one watching the result. The JS side already
     * stops its own poll loop on visibilitychange, but that is a cooperative
     * signal a page could fail to act on; this is the same stop enforced at the
     * platform level regardless of what the page does.
     */
    override fun onPause() {
        super.onPause()
        bleBridge.stopScan()
    }

    override fun onDestroy() {
        bleBridge.stopScan()
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }
}
