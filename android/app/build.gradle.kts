import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/** Version comes from the root package.json so npm and the APK never disagree. */
val packageVersion: String = File(rootDir.parentFile, "package.json")
    .readText()
    .let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)!!.groupValues[1] }

/**
 * versionCode must be a single monotonically increasing integer, but
 * package.json carries a semver string. Requiring exactly three numeric
 * segments and failing loudly on anything else (a `-beta` suffix, a
 * two-segment version) beats letting NumberFormatException surface from deep
 * inside `.toInt()` with no indication of which file or value caused it.
 */
fun versionCodeFrom(version: String): Int {
    val segments = version.split(".")
    require(segments.size == 3 && segments.all { it.toIntOrNull() != null }) {
        "versionCode requires a three-part numeric version (major.minor.patch); " +
            "package.json has \"$version\", which does not fit that shape."
    }
    val (major, minor, patch) = segments.map { it.toInt() }
    return major * 10000 + minor * 100 + patch
}

android {
    namespace = "work.suryansh.signalboy"
    compileSdk = 36

    defaultConfig {
        applicationId = "work.suryansh.signalboy"
        minSdk = 26
        targetSdk = 36
        versionName = packageVersion
        versionCode = versionCodeFrom(packageVersion)
    }

    // Declared BEFORE buildTypes, and that order is load-bearing: this script is
    // evaluated top-down, so a `signingConfigs.findByName("release")` above this
    // block resolves to null and silently produces an unsigned APK. That failure
    // is invisible locally -- it only surfaces in CI as a missing
    // app-release.apk, because an unsigned build is named app-release-unsigned.apk.
    signingConfigs {
        // Populated only in CI, where the keystore is restored from a secret.
        // A local `./gradlew assembleRelease` produces an unsigned APK.
        if (System.getenv("SIGNALBOY_KEYSTORE") != null) {
            create("release") {
                storeFile = File(System.getenv("SIGNALBOY_KEYSTORE"))
                storePassword = System.getenv("SIGNALBOY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SIGNALBOY_KEY_ALIAS")
                keyPassword = System.getenv("SIGNALBOY_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

/**
 * The UI is not vendored into the Android project -- it is copied from public/
 * at build time, so the APK can never drift from what `npx signalboy` serves.
 *
 * Sync, not Copy: Copy only deletes stale outputs it remembers creating in
 * Gradle's own task history. If that history goes missing independently of
 * the destination -- a wiped .gradle/, or a CI cache that restores
 * assets/www/ from a cache entry without restoring the history alongside it
 * -- a file removed from public/ lingers in assets/www/ and still ships in
 * the APK. Sync mirrors the destination to the source unconditionally on
 * every run, so a deleted source file cannot survive a build.
 */
val syncWebAssets by tasks.registering(Sync::class) {
    from(File(rootDir.parentFile, "public"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // Extends the platform SplashScreen API (API 31+ auto-dismisses almost
    // immediately) so the 5s hold works identically back to minSdk 26.
    implementation("androidx.core:core-splashscreen:1.0.1")
}
