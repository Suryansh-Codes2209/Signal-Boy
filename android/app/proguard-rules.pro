# Bridge methods are reached by name from JavaScript, so they must survive
# shrinking and obfuscation even though nothing in Kotlin ever calls them.
#
# Keyed on the annotation rather than on class names deliberately. A per-class
# rule only covered WifiBridge, so when BleBridge was added it was silently
# unprotected -- and that failure is invisible in development, because the debug
# build does not run R8 at all. The app works on your desk and the HUNT view is
# dead in the release APK. Annotating covers every bridge added from now on.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
