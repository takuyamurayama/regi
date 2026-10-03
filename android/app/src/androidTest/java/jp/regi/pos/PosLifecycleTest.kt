package jp.regi.pos

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PosLifecycleTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun field(label: String) = compose.onNode(hasText(label) and hasSetTextAction())

    private fun waitText(text: String) =
        compose.waitUntil(20000) {
            compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }

    private fun hideKeyboard(activity: ActivityScenario<PosTestActivity>) {
        activity.onActivity {
            (it.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
                    as android.view.inputmethod.InputMethodManager)
                .hideSoftInputFromWindow(it.window.decorView.windowToken, 0)
        }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    private fun systemSetting(command: String): String =
        android.os.ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation()
                    .uiAutomation
                    .executeShellCommand("settings $command")
            )
            .bufferedReader()
            .use { it.readText().trim() }

    private fun withStore(test: (Repository, ActivityScenario<PosTestActivity>, Product) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "pos-ui-${UUID.randomUUID()}.db"
        val database = Room.databaseBuilder(context, PosDatabase::class.java, name).build()
        val repository = Repository(context, database)
        runBlocking {
            repository.network.configure(
                fixtureApiBaseUrl(),
                "",
                true,
                fixture().getString("cashierSubject"),
                fixture().getString("tenant"),
            )
            repository.bootstrap(fixtureDevice("hold"))
            repository.authenticate(fixtureStaff("cashier"), "1234")
            if (repository.dao.metadata("shiftId").isNullOrBlank()) {
                repository.openShift("1000", "1234")
                repository.sync()
            }
            repository.network.configure(
                "http://127.0.0.1:9",
                "",
                true,
                fixture().getString("cashierSubject"),
                fixture().getString("tenant"),
            )
        }
        val product = runBlocking { repository.dao.search("COFFEE-001").single() }
        ActivityScenario.launch<PosTestActivity>(
                Intent(context, PosTestActivity::class.java).putExtra("regiTestDatabase", name)
            )
            .use { activity ->
                try {
                    test(repository, activity, product)
                } finally {
                    screenshot("pos-lifecycle-final.png")
                }
            }
        database.close()
    }

    @Test
    fun unsavedCartAndEveryToolbarActionRemainReachableWithKeyboardAndActivityRecreation() =
        withStore { repository, activity, product ->
            waitText("${product.name}　${product.price}円")
            compose.onNodeWithText("${product.name}　${product.price}円").performClick()
            field("販売数量 1").performScrollTo().performTextReplacement("2")
            field("会計値引き（円）").performScrollTo().performTextReplacement("3")
            field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput("回転の合成宛名")
            compose.onNodeWithText("未送信 0 件 / 要確認 0 件 / オフライン上限72時間").assertIsDisplayed()
            screenshot("pos-keyboard-navigation.png")
            for (label in listOf("販売", "履歴", "同期", "開局・締め", "店舗業務", "設定")) {
                compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
            }
            hideKeyboard(activity)
            compose.onNodeWithText("持ち帰り").performScrollTo().performClick()
            compose.onNodeWithText("カード").performScrollTo().performClick()
            waitText("合計 212 円")
            activity.recreate()
            waitText("合計 212 円")
            field("販売数量 1").performScrollTo().assertTextContains("2")
            field("帳票宛名（設定で必須の場合あり）").performScrollTo().assertTextContains("回転の合成宛名")
            compose.onNodeWithText("● カード").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("● 持ち帰り").performScrollTo().assertIsDisplayed()
            runBlocking {
                assertTrue(repository.dao.history().isEmpty())
                assertEquals(0, repository.dao.pendingCount())
            }
        }

    @Test
    fun externalUnknownRetainsItsSavedIdAndReferenceAcrossRecreationThenConfirmsOnlyOnce() =
        withStore { repository, activity, product ->
            waitText("${product.name}　${product.price}円")
            compose.onNodeWithText("${product.name}　${product.price}円").performClick()
            field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput("外部結果の合成宛名")
            hideKeyboard(activity)
            compose.onNodeWithText("カード").performScrollTo().performClick()
            compose.onNodeWithText("保存して支払い開始").performScrollTo().performClick()
            waitText("外部端末の成功確認番号")
            val savedId = runBlocking { repository.dao.history().single().id }
            compose.onNodeWithText("現金会計を中止").assertDoesNotExist()
            compose.waitUntil(10000) {
                compose
                    .onAllNodes(hasText("結果不明 / 確認待ち") and isEnabled())
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            compose.onNodeWithText("結果不明 / 確認待ち").performScrollTo().performClick()
            compose.waitUntil(10000) {
                runBlocking { repository.dao.checkoutById(savedId)!!.status == "unknown" }
            }
            field("外部端末の成功確認番号").performScrollTo().performTextInput("UI-REFERENCE-EXTERNAL")
            hideKeyboard(activity)
            activity.recreate()
            waitText("外部端末の成功確認番号")
            field("外部端末の成功確認番号").performScrollTo().assertTextContains("UI-REFERENCE-EXTERNAL")
            compose.onNodeWithText("現金会計を中止").assertDoesNotExist()
            compose.onNodeWithText("支払成功確認・売上確定").performScrollTo().performClick()
            compose.waitUntil(10000) {
                runBlocking { repository.dao.checkoutById(savedId)!!.status == "confirmed" }
            }
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("売上確定 / 108円").fetchSemanticsNodes().isNotEmpty()
            }
            runBlocking {
                repository.confirm(savedId, "", "UI-REFERENCE-EXTERNAL")
                assertEquals(1, repository.dao.history().size)
                assertEquals(1, repository.dao.pendingCount())
                assertEquals(savedId, repository.dao.pending().single().id)
                assertEquals(
                    "UI-REFERENCE-EXTERNAL",
                    JSONObject(repository.dao.checkoutById(savedId)!!.body).getString("reference"),
                )
            }
            screenshot("pos-external-confirmed.png")
        }

    @Test
    fun landscapePaymentSurvivesSystemRotationRequestsAndFontScaleChange() =
        withStore { repository, activity, product ->
            val saved = runBlocking {
                repository.begin(
                    listOf(
                        SaleLine(
                            product.id,
                            product.name,
                            1,
                            product.price,
                            "0",
                            product.rateBps,
                            product.cost,
                            product.stockManaged,
                        )
                    ),
                    "0",
                    "cash",
                    buyerName = "回転の合成宛名",
                )
            }
            activity.recreate()
            waitText("支払い確認中 / 108円")
            val originalRotation = systemSetting("get system user_rotation")
            val originalAutomatic = systemSetting("get system accelerometer_rotation")
            val originalFontScale = systemSetting("get system font_scale")
            try {
                systemSetting("put system accelerometer_rotation 0")
                for (rotation in listOf(1, 3, 0)) {
                    systemSetting("put system user_rotation $rotation")
                    waitText("支払い確認中 / 108円")
                    activity.onActivity {
                        assertEquals(
                            android.content.res.Configuration.ORIENTATION_LANDSCAPE,
                            it.resources.configuration.orientation,
                        )
                        println(
                            "REGI rotation request=$rotation display=${it.windowManager.defaultDisplay.rotation} orientation=${it.resources.configuration.orientation} pid=${android.os.Process.myPid()}"
                        )
                    }
                    runBlocking {
                        assertEquals(listOf(saved.id), repository.dao.history().map { it.id })
                        assertEquals("checking", repository.dao.checkoutById(saved.id)!!.status)
                        assertEquals(0, repository.dao.pendingCount())
                    }
                    screenshot("pos-landscape-rotation-request-$rotation.png")
                }
                systemSetting("put system font_scale 1.3")
                compose.waitUntil(20000) {
                    var scale = 0f
                    activity.onActivity { scale = it.resources.configuration.fontScale }
                    kotlin.math.abs(scale - 1.3f) < 0.01f
                }
                waitText("支払い確認中 / 108円")
                activity.onActivity {
                    assertEquals(1.3f, it.resources.configuration.fontScale, 0.01f)
                }
                compose.onNodeWithText("支払成功確認・売上確定").performScrollTo().assertIsDisplayed()
                screenshot("pos-font-scale-130.png")
                runBlocking {
                    assertEquals(listOf(saved.id), repository.dao.history().map { it.id })
                    assertEquals(saved.body, repository.dao.checkoutById(saved.id)!!.body)
                    assertEquals(0, repository.dao.pendingCount())
                }
            } finally {
                for ((key, value) in
                    listOf(
                        "font_scale" to originalFontScale,
                        "user_rotation" to originalRotation,
                        "accelerometer_rotation" to originalAutomatic,
                    )) {
                    systemSetting(
                        if (value == "null" || value.isBlank()) "delete system $key"
                        else "put system $key $value"
                    )
                }
            }
        }
}
