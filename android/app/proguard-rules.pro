# The bridge is reached by name from JavaScript, so its methods must survive
# shrinking even though nothing in Kotlin calls them.
-keepclassmembers class work.suryansh.signalboy.WifiBridge {
    public *;
}
