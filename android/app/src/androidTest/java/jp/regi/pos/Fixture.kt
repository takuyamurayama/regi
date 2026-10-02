package jp.regi.pos

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject

fun fixture(): JSONObject = JSONObject(InstrumentationRegistry.getArguments().getString("regiTestFixture") ?: error("scripts/android-test.sh で独立DB fixtureを作成してください"))
fun fixtureDevice(key: String): String = fixture().getJSONObject("devices").getString(key)
fun fixtureStore(key: String): String = fixture().getJSONObject("stores").getString(key)
fun fixtureStaff(role: String): String = fixture().getString(role)
