package jp.regi.pos

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class OperationsUiTest {
    @get:Rule val compose = createAndroidComposeRule<OperationsTestActivity>()

    private fun selected(name: String) {
        try {
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("● $name").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (failure: Throwable) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap
                ->
                java.io
                    .File(context.getExternalFilesDir(null), "ui-failure.png")
                    .outputStream()
                    .use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            }
            compose.onRoot().printToLog("REGI_UI")
            throw failure
        }
    }

    private fun hideKeyboard() {
        compose.runOnUiThread {
            val activity = compose.activity
            (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
                    as android.view.inputmethod.InputMethodManager)
                .hideSoftInputFromWindow(activity.window.decorView.windowToken, 0)
        }
        compose.waitForIdle()
    }

    @Test
    fun twoLineOrderCanSelectSecondLineAndReceivePartially() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteDatabase("operations-ui.db")
        compose.waitForIdle()
        val database =
            Room.databaseBuilder(context, PosDatabase::class.java, "operations-ui.db").build()
        val repository = Repository(context, database)
        val suffix = System.currentTimeMillis().toString()
        val names = listOf("画面商品A$suffix", "画面商品B$suffix")
        runBlocking {
            repository.network.configure(
                fixtureApiBaseUrl(),
                "",
                true,
                fixture().getString("adminSubject"),
                fixture().getString("tenant"),
            )
            repository.network.selectStaff(null)
            names.forEachIndexed { index, name ->
                repository.command(
                    "/v1/products",
                    JSONObject()
                        .put("sku", "UI-$suffix-$index")
                        .put("name", name)
                        .put("price", "110")
                        .put("cost", "50")
                        .put("taxCode", "standard")
                        .put("stockManaged", true)
                        .put("effectiveAt", java.time.Instant.now().toString()),
                )
            }
            repository.bootstrap(fixtureDevice("recovery"))
            repository.authenticate(fixtureStaff("admin"), "1234")
        }
        compose.setContent { MaterialTheme { Operations(repository) } }
        compose.onNodeWithText("発注").performClick()
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("業務商品検索 / SKU / JAN").fetchSemanticsNodes().isNotEmpty()
        }
        compose
            .onNode(hasText("業務商品検索 / SKU / JAN") and hasSetTextAction())
            .performTextInput(names[0])
        hideKeyboard()
        compose.waitUntil(10000) {
            compose
                .onAllNodes(hasText(names[0]) and hasClickAction() and !hasSetTextAction())
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose
            .onNode(hasText(names[0]) and hasClickAction() and !hasSetTextAction())
            .performScrollTo()
            .performClick()
        selected(names[0])
        compose.onNodeWithText("発注明細を追加").performScrollTo().performClick()
        compose
            .onNode(hasText("業務商品検索 / SKU / JAN") and hasSetTextAction())
            .performScrollTo()
            .performTextReplacement(names[1])
        hideKeyboard()
        compose.waitUntil(10000) {
            compose
                .onAllNodes(hasText(names[1]) and hasClickAction() and !hasSetTextAction())
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose
            .onNode(hasText(names[1]) and hasClickAction() and !hasSetTextAction())
            .performScrollTo()
            .performClick()
        selected(names[1])
        compose.onNodeWithText("発注明細を追加").performScrollTo().performClick()
        compose
            .onNode(hasText("仕入先") and hasSetTextAction())
            .performScrollTo()
            .performTextInput("画面仕入先$suffix")
        hideKeyboard()
        compose.onNodeWithText("複数明細で下書き作成").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("発注承認").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("発注承認").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("発注発行").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("発注発行").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("選択明細を分納入荷").fetchSemanticsNodes().isNotEmpty()
        }
        compose
            .onNode(hasText("入荷数量 2") and hasSetTextAction())
            .performScrollTo()
            .performTextReplacement("1")
        hideKeyboard()
        compose.onNodeWithText("選択明細を分納入荷").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("${names[1]} 入荷済1 / 発注1").fetchSemanticsNodes().isNotEmpty()
        }
        runBlocking {
            val orders =
                repository.network
                    .request(
                        "/v1/documents/purchase-order?storeId=${fixtureStore("recovery")}&q=$suffix"
                    )
                    .getJSONArray("items")
            val lines = orders.getJSONObject(0).getJSONObject("body").getJSONArray("lines")
            assertEquals(2, lines.length())
            assertEquals(0, lines.getJSONObject(0).getInt("received"))
            assertEquals(1, lines.getJSONObject(1).getInt("received"))
        }
        val saleId = runBlocking {
            repository.openShift("1000", "1234")
            repository.sync()
            val saleProducts = names.map { repository.dao.search(it).single() }
            val checkout =
                repository.begin(
                    saleProducts.mapIndexed { index, entry ->
                        SaleLine(
                            entry.id,
                            entry.name,
                            index + 1,
                            entry.price,
                            "0",
                            entry.rateBps,
                            entry.cost,
                            entry.stockManaged,
                        )
                    },
                    "0",
                    "card",
                )
            repository.confirm(checkout.id, "0", "UI-SALE-$suffix")
            repository.sync()
            checkout.id
        }
        compose.onNodeWithText("返品").performScrollTo().performClick()
        compose
            .onNode(hasText("返品・調整・取消理由") and hasSetTextAction())
            .performScrollTo()
            .performTextInput("第二明細のみ返品")
        hideKeyboard()
        compose
            .onNode(hasText("取引番号・仕入先・商品名で検索") and hasSetTextAction())
            .performScrollTo()
            .performTextInput(suffix)
        hideKeyboard()
        compose.onNodeWithText("記録を検索").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose
                .onAllNodes(hasText(saleId.take(8), substring = true) and hasClickAction())
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose
            .onNode(hasText(saleId.take(8), substring = true) and hasClickAction())
            .performScrollTo()
            .performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("返品数量 2").fetchSemanticsNodes().isNotEmpty()
        }
        compose
            .onNode(hasText("返品数量 2") and hasSetTextAction())
            .performScrollTo()
            .performTextReplacement("1")
        hideKeyboard()
        compose.onNodeWithText("選択明細を返品予約").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("返金成功を確定").fetchSemanticsNodes().isNotEmpty()
        }
        compose
            .onNode(hasText("外部返金確認番号") and hasSetTextAction())
            .performScrollTo()
            .performTextInput("UI-REFUND-$suffix")
        hideKeyboard()
        compose.onNodeWithText("返金成功を確定").performScrollTo().performClick()
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("返金成功を確定").fetchSemanticsNodes().isEmpty()
        }
        runBlocking {
            val returnable =
                repository.network.request("/v1/sales/$saleId/returnable").getJSONArray("lines")
            assertEquals(1, returnable.getJSONObject(0).getInt("remaining"))
            assertEquals(1, returnable.getJSONObject(1).getInt("remaining"))
            val refunds =
                repository.network
                    .request("/v1/documents/refund?storeId=${fixtureStore("recovery")}")
                    .getJSONArray("items")
            val refund =
                (0 until refunds.length())
                    .map { refunds.getJSONObject(it) }
                    .single { it.getJSONObject("body").getString("saleId") == saleId }
            assertEquals("confirmed", refund.getString("status"))
            assertEquals("110", refund.getJSONObject("body").getString("total"))
            assertEquals(
                1,
                refund.getJSONObject("body").getJSONArray("lines").getJSONObject(0).getInt("index"),
            )
            repository.close("1000")
            repository.sync()
        }
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io
                .File(context.getExternalFilesDir(null), "ui-operations.png")
                .outputStream()
                .use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
        database.close()
    }
}
