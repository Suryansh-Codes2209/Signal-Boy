package work.suryansh.signalboy

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

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
            }
        }

        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
