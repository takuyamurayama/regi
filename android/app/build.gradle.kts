plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "jp.regi.pos"
    compileSdk = 35
    defaultConfig {
        applicationId = "jp.regi.pos"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner =
            if (providers.gradleProperty("regiRestartRunner").orNull == "true")
                "jp.regi.pos.RestartRunner"
            else "androidx.test.runner.AndroidJUnitRunner"
    }
    defaultConfig {
        providers.gradleProperty("regiTestFixture").orNull?.let {
            testInstrumentationRunnerArguments["regiTestFixture"] = it
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes.add("META-INF/versions/9/OSGI-INF/MANIFEST.MF") }
    signingConfigs {
        if (System.getenv("REGI_KEYSTORE_PATH") != null)
            create("distribution") {
                storeFile = file(System.getenv("REGI_KEYSTORE_PATH"))
                storePassword = System.getenv("REGI_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("REGI_KEY_ALIAS")
                keyPassword = System.getenv("REGI_KEY_PASSWORD")
            }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (System.getenv("REGI_KEYSTORE_PATH") != null)
                signingConfig = signingConfigs.getByName("distribution")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets.getByName("test").assets.srcDir("../../tests/fixtures")
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.08.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.0")
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.08.01"))
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
