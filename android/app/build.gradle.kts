import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/** Version comes from the root package.json so npm and the APK never disagree. */
val packageVersion: String = File(rootDir.parentFile, "package.json")
    .readText()
    .let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)!!.groupValues[1] }

android {
    namespace = "work.suryansh.signalboy"
    compileSdk = 36

    defaultConfig {
        applicationId = "work.suryansh.signalboy"
        minSdk = 26
        targetSdk = 36
        versionName = packageVersion
        versionCode = packageVersion.split(".").let {
            it[0].toInt() * 10000 + it[1].toInt() * 100 + it[2].toInt()
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

/**
 * The UI is not vendored into the Android project -- it is copied from public/
 * at build time, so the APK can never drift from what `npx signalboy` serves.
 */
val syncWebAssets by tasks.registering(Copy::class) {
    from(File(rootDir.parentFile, "public"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
