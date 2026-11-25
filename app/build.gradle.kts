plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.mhamzam.masjidtimes"
    compileSdk = 36

    defaultConfig {
        // Permanent once published on Google Play.
        applicationId = "io.github.mhamzam.masjidtimes"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// No dependencies: the screens are plain HTML/JS in the system WebView; Supabase is reached over plain HTTPS.
