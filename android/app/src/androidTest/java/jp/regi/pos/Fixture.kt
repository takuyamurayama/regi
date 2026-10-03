package jp.regi.pos

import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject

fun fixture(): JSONObject =
    JSONObject(
        InstrumentationRegistry.getArguments().getString("regiTestFixture")
            ?: error("scripts/android-test.sh で独立DB fixtureを作成してください")
    )

fun fixtureDevice(key: String): String = fixture().getJSONObject("devices").getString(key)

fun fixtureStore(key: String): String = fixture().getJSONObject("stores").getString(key)

fun fixtureStaff(role: String): String = fixture().getString(role)

/** A separate local API keeps live web development from interrupting device acceptance tests. */
fun fixtureApiBaseUrl(arguments: Bundle = InstrumentationRegistry.getArguments()): String {
    val base = arguments.getString("regiTestApiBaseUrl") ?: "http://10.0.2.2:3000"
    require(base.matches(Regex("http://10\\.0\\.2\\.2:[0-9]{1,5}"))) {
        "Device acceptance requires a local emulator host API"
    }
    require(base.substringAfterLast(':').toInt() in 1..65535)
    return base
}
