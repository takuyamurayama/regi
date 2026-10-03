package jp.regi.pos

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName

/** Real POS content, real Room and a separate local API fixture; no replacement UI nodes. */
class PosUiTest {
    @get:Rule val compose = createAndroidComposeRule<OperationsTestActivity>()
    @get:Rule val testName = TestName()
    private val queryExecutor = GatedQueries()
    private lateinit var database: PosDatabase
    private lateinit var repository: Repository
    private lateinit var product: Product
    private val buyer = "合成宛名の画面試験"

    @Before
    fun prepareRealStoreAndOpenShift() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database =
            Room.databaseBuilder(context, PosDatabase::class.java, "pos-ui-${UUID.randomUUID()}.db")
                .setQueryExecutor(queryExecutor)
                .build()
        repository = Repository(context, database)
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
        product = repository.dao.search("COFFEE-001").single()
        assertEquals("100", product.price)
        assertEquals(
            "exclusive",
            repository
                .snapshot()
                .getJSONObject("settings")
                .getJSONObject("tenant")
                .getString("price_mode"),
        )
        assertTrue(
            repository
                .snapshot()
                .getJSONObject("settings")
                .getJSONObject("receipt")
                .getBoolean("buyerRequired")
        )
        assertEquals(0, repository.dao.pendingCount())
        // Subsequent payment assertions are local; no API success is invented or intercepted.
        repository.network.configure(
            "http://127.0.0.1:9",
            "",
            true,
            fixture().getString("cashierSubject"),
            fixture().getString("tenant"),
        )
    }

    private fun line(context: String = "master") =
        SaleLine(
            product.id,
            product.name,
            1,
            product.price,
            "0",
            product.rateBps,
            product.cost,
            product.stockManaged,
            context,
        )

    private fun showPos() {
        compose.setContent { MaterialTheme { Pos(repository) } }
        compose.waitUntil(20000) {
            compose
                .onAllNodesWithText("${product.name}　${product.price}円")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.waitForIdle()
    }

    private fun field(label: String) = compose.onNode(hasText(label) and hasSetTextAction())

    private fun hideKeyboard() {
        compose.runOnUiThread {
            (compose.activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
                    as android.view.inputmethod.InputMethodManager)
                .hideSoftInputFromWindow(compose.activity.window.decorView.windowToken, 0)
        }
        compose.waitForIdle()
    }

    private fun addProduct() {
        compose.onNodeWithText("${product.name}　${product.price}円").performClick()
    }

    @After
    fun captureEvidenceAndClose() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(
                    instrumentation.targetContext.getExternalFilesDir(null),
                    "pos-ui-${testName.methodName}.png",
                )
                .outputStream()
                .use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        // Evidence must not replace the original assertion or startup exception on a failed test.
        runCatching { compose.onRoot().printToLog("REGI_POS_UI_${testName.methodName}") }
        queryExecutor.release()
        compose.runOnUiThread { compose.activity.setContent {} }
        // Cleanup diagnostics must not replace a failed startup or financial assertion.
        runCatching { compose.waitForIdle() }
        if (::database.isInitialized) database.close()
        queryExecutor.close()
    }

    @Test
    fun exclusiveDineInPreviewMatchesStoredPaymentAndNewLineContext() {
        showPos()
        addProduct()
        compose.onNodeWithText("店内飲食").performScrollTo().performClick()
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("合計 110 円").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("合計 110 円").performScrollTo().assertIsDisplayed()
        addProduct()
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("合計 220 円").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("合計 220 円").performScrollTo().assertIsDisplayed()
        field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput(buyer)
        hideKeyboard()
        compose.onNodeWithText("保存して支払い開始").performScrollTo().performClick()
        compose.waitUntil(10000) { runBlocking { repository.dao.history().size == 1 } }
        runBlocking {
            val checkout = repository.dao.history().single()
            val body = JSONObject(checkout.body)
            assertEquals("checking", checkout.status)
            assertEquals("220", body.getString("total"))
            assertEquals(2, body.getJSONArray("lines").length())
            for (index in 0..1) {
                assertEquals(
                    1000,
                    body.getJSONArray("lines").getJSONObject(index).getInt("rateBps"),
                )
                assertEquals(
                    "dine-in",
                    body.getJSONArray("lines").getJSONObject(index).getString("taxContext"),
                )
            }
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun invalidDiscountNeverDisplaysFreeSaleOrCreatesCheckout() {
        showPos()
        addProduct()
        field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput(buyer)
        for (value in listOf("101", "", "-1", "0.5", "文字", "9999999999999999999999999999999")) {
            field("会計値引き（円）").performScrollTo().performTextReplacement(value)
            hideKeyboard()
            assertEquals(
                value,
                field("会計値引き（円）")
                    .fetchSemanticsNode()
                    .config[androidx.compose.ui.semantics.SemanticsProperties.EditableText]
                    .text,
            )
            compose.onNodeWithText("合計 0 円").assertDoesNotExist()
            compose.onNodeWithText("保存して支払い開始").assertIsNotEnabled()
            compose.onNodeWithText("保留して保存").assertIsNotEnabled()
        }
        runBlocking {
            assertTrue(repository.dao.history().isEmpty())
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun invalidQuantityRemainsVisibleAndBlocksPaymentInsteadOfSilentlyKeepingOne() {
        showPos()
        addProduct()
        field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput(buyer)
        for (value in listOf("0", "", "10001", "文字", "2147483648")) {
            field("販売数量 1").performScrollTo().performTextReplacement(value)
            hideKeyboard()
            assertEquals(
                value,
                field("販売数量 1")
                    .fetchSemanticsNode()
                    .config[androidx.compose.ui.semantics.SemanticsProperties.EditableText]
                    .text,
            )
            compose.onNodeWithText("保存して支払い開始").assertIsNotEnabled()
        }
        runBlocking {
            assertTrue(repository.dao.history().isEmpty())
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun cancelledHistoryNeverOffersConfirmationOrUnknownPayment() {
        val cancelled = runBlocking {
            repository.begin(listOf(line()), "0", "cash", buyerName = buyer).also {
                repository.cancel(it.id)
            }
        }
        showPos()
        compose.onNodeWithText("履歴").performClick()
        compose.onNodeWithText("確認").performClick()
        compose.onNodeWithText("支払成功確認・売上確定").assertDoesNotExist()
        compose.onNodeWithText("結果不明 / 確認待ち").assertDoesNotExist()
        compose.onNodeWithText("会計中止 / 108円").performScrollTo().assertIsDisplayed()
        runBlocking {
            assertEquals("cancelled", repository.dao.checkoutById(cancelled.id)!!.status)
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun heldHistoryRestoresBuyerMethodAndTakeawayWithoutChangingDraft() {
        val held = runBlocking {
            repository.begin(
                listOf(line("takeaway")),
                "3",
                "card",
                status = "draft",
                buyerName = buyer,
            )
        }
        showPos()
        compose.onNodeWithText("履歴").performClick()
        compose.onNodeWithText("確認").performClick()
        field("帳票宛名（設定で必須の場合あり）").assertTextContains(buyer)
        compose.onNodeWithText("● 持ち帰り").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("● カード").performScrollTo().assertIsDisplayed()
        field("会計値引き（円）").assertTextContains("3")
        runBlocking {
            assertEquals("draft", repository.dao.checkoutById(held.id)!!.status)
            assertEquals(held.body, repository.dao.checkoutById(held.id)!!.body)
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun cashTenderShowsChangeBeforeSingleConfirmation() {
        val checkout = runBlocking {
            repository.begin(listOf(line()), "0", "cash", buyerName = buyer)
        }
        showPos()
        field("現金預り額").performScrollTo().performTextInput("200")
        hideKeyboard()
        compose.onNodeWithText("釣銭 92 円").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("支払成功確認・売上確定").performScrollTo().performClick()
        compose.waitUntil(10000) {
            runBlocking { repository.dao.checkoutById(checkout.id)!!.status == "confirmed" }
        }
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("売上確定 / 108円").fetchSemanticsNodes().isNotEmpty()
        }
        runBlocking {
            assertEquals(
                "200",
                JSONObject(repository.dao.checkoutById(checkout.id)!!.body).getString("tendered"),
            )
            assertEquals(1, repository.dao.pendingCount())
            assertEquals(checkout.id, repository.dao.pending().single().id)
        }
    }

    @Test
    fun paymentSnapshotUsesResolvedTaxCodeInsteadOfInferringReducedFromEightPercent() {
        showPos()
        runBlocking {
            val takeaway =
                repository.begin(listOf(line("takeaway")), "0", "card", buyerName = buyer)
            val reduced = JSONObject(takeaway.body).getJSONArray("lines").getJSONObject(0)
            assertEquals("reduced", reduced.getString("taxCode"))
            assertTrue(reduced.getBoolean("reducedTarget"))
            val dine = repository.begin(listOf(line("dine-in")), "0", "card", buyerName = buyer)
            val standard = JSONObject(dine.body).getJSONArray("lines").getJSONObject(0)
            assertEquals("110", JSONObject(dine.body).getString("total"))
            assertEquals("standard", standard.getString("taxCode"))
            assertFalse(standard.getBoolean("reducedTarget"))
            val snapshot = repository.snapshot()
            snapshot
                .getJSONObject("settings")
                .getJSONArray("taxRates")
                .put(
                    JSONObject()
                        .put("code", "standard")
                        .put("rate_bps", 800)
                        .put("effective_at", java.time.Instant.now().minusSeconds(1).toString())
                )
            repository.dao.metadata(Metadata("bootstrap", snapshot.toString()))
            repository.dao.products(listOf(product.copy(taxCode = "standard", rateBps = 800)))
            val ordinary =
                repository.begin(listOf(line("takeaway")), "0", "card", buyerName = buyer)
            val ordinaryLine = JSONObject(ordinary.body).getJSONArray("lines").getJSONObject(0)
            assertEquals(800, ordinaryLine.getInt("rateBps"))
            assertFalse(ordinaryLine.getBoolean("reducedTarget"))
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun effectivePriceAndTaxBoundaryChangesPreviewAndNewPaymentButKeepsStartedSnapshot() {
        showPos()
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            var now = java.time.Instant.now().plusSeconds(3)
            val boundary = now.plusSeconds(60)
            val clocked = Repository(context, database) { now }
            repository.dao.metadata(
                Metadata(
                    "scheduledPrice-${product.id}-${boundary}",
                    JSONObject()
                        .put("productId", product.id)
                        .put("name", product.name)
                        .put("price", "150")
                        .put("cost", "50")
                        .put("taxCode", "reduced")
                        .put("effectiveAt", boundary.toString())
                        .toString(),
                )
            )
            val snapshot = repository.snapshot()
            snapshot
                .getJSONObject("settings")
                .getJSONArray("taxRates")
                .put(
                    JSONObject()
                        .put("code", "reduced")
                        .put("rate_bps", 1200)
                        .put("effective_at", boundary.toString())
                )
            repository.dao.metadata(Metadata("bootstrap", snapshot.toString()))
            val old = clocked.begin(listOf(line("takeaway")), "0", "card", buyerName = buyer)
            val oldPreview = clocked.preview(listOf(line("takeaway")), "0")
            assertEquals("108", JSONObject(old.body).getString("total"))
            now = boundary.plusSeconds(1)
            assertTrue(
                runCatching {
                        clocked.begin(
                            listOf(line("takeaway")),
                            "0",
                            "card",
                            buyerName = buyer,
                            expectedPreview = oldPreview,
                        )
                    }
                    .isFailure
            )
            assertEquals(1, repository.dao.history().size)
            val preview = clocked.preview(listOf(line("takeaway")), "0")
            assertEquals("168", preview.calculation.total)
            val later = clocked.begin(listOf(line("takeaway")), "0", "card", buyerName = buyer)
            val saved = JSONObject(later.body)
            assertEquals("168", saved.getString("total"))
            assertEquals(1200, saved.getJSONArray("lines").getJSONObject(0).getInt("rateBps"))
            assertTrue(saved.getJSONArray("lines").getJSONObject(0).getBoolean("reducedTarget"))
            assertEquals(old.body, repository.dao.checkoutById(old.id)!!.body)
        }
    }

    @Test
    fun explicitFullDiscountIsAValidZeroPaymentAndConfirmsOnlyOnce() {
        showPos()
        addProduct()
        field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput(buyer)
        field("会計値引き（円）").performScrollTo().performTextReplacement("100")
        hideKeyboard()
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("合計 0 円").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("合計 0 円").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("保存して支払い開始").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(10000) { runBlocking { repository.dao.history().size == 1 } }
        field("現金預り額").performScrollTo().performTextInput("0")
        hideKeyboard()
        compose.onNodeWithText("支払成功確認・売上確定").performScrollTo().performClick()
        compose.waitUntil(10000) {
            runBlocking { repository.dao.history().single().status == "confirmed" }
        }
        runBlocking {
            val saved = repository.dao.history().single()
            assertEquals("0", JSONObject(saved.body).getString("total"))
            repository.confirm(saved.id, "0", "")
            assertEquals(1, repository.dao.pendingCount())
        }
    }

    @Test
    fun confirmedReceiptKeepsStoredReducedClassificationAfterMasterChangeAndSendsCompleteTcpRaster() {
        showPos()
        runBlocking {
            val pending = repository.begin(listOf(line("takeaway")), "0", "card", buyerName = buyer)
            val confirmed = repository.confirm(pending.id, "", "UI-PRINT-REFERENCE")
            val original = Printer.receiptLines(confirmed)
            assertTrue(original.contains("※ ${product.name} × 1"))
            assertTrue(original.contains("※ 軽減税率対象"))
            assertTrue(original.contains("宛名 $buyer 様"))
            repository.dao.products(
                listOf(
                    product.copy(
                        name = "変更後商品",
                        price = "999",
                        taxCode = "standard",
                        rateBps = 1000,
                    )
                )
            )
            val snapshot = repository.snapshot()
            snapshot.getJSONObject("settings").getJSONObject("receipt").put("sellerName", "変更後発行者")
            repository.dao.metadata(Metadata("bootstrap", snapshot.toString()))
            val saved = repository.dao.checkoutById(confirmed.id)!!
            assertEquals(confirmed.body, saved.body)
            assertEquals(original, Printer.receiptLines(saved))
            java.net.ServerSocket(0).use { listener ->
                val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
                try {
                    val received =
                        executor.submit<ByteArray> {
                            listener.accept().use { it.getInputStream().readBytes() }
                        }
                    Printer.print("127.0.0.1", saved, listener.localPort)
                    val bytes = received.get(15, java.util.concurrent.TimeUnit.SECONDS)
                    assertEquals(0x1b, bytes[0].toInt())
                    assertEquals(0x40, bytes[1].toInt())
                    val chunks = mutableListOf<Pair<Int, ByteArray>>()
                    var position = 2
                    while (
                        position + 8 <= bytes.size &&
                            bytes[position] == 0x1d.toByte() &&
                            bytes[position + 1] == 0x76.toByte()
                    ) {
                        val widthBytes =
                            (bytes[position + 4].toInt() and 255) +
                                ((bytes[position + 5].toInt() and 255) shl 8)
                        val height =
                            (bytes[position + 6].toInt() and 255) +
                                ((bytes[position + 7].toInt() and 255) shl 8)
                        assertEquals(72, widthBytes)
                        assertTrue(height > 0)
                        val end = position + 8 + widthBytes * height
                        assertTrue(end <= bytes.size)
                        chunks.add(height to bytes.copyOfRange(position + 8, end))
                        position = end
                    }
                    assertArrayEquals(
                        byteArrayOf(0x0a, 0x0a, 0x1d, 0x56, 0),
                        bytes.copyOfRange(position, bytes.size),
                    )
                    val height = chunks.sumOf { it.first }
                    assertTrue(height in 200..10000)
                    val bitmap = Bitmap.createBitmap(576, height, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    var rowOffset = 0
                    for ((rows, raster) in chunks) {
                        for (row in 0 until rows) for (column in 0 until 576) {
                            if (
                                raster[row * 72 + column / 8].toInt() and (0x80 shr (column % 8)) !=
                                    0
                            )
                                bitmap.setPixel(
                                    column,
                                    rowOffset + row,
                                    android.graphics.Color.BLACK,
                                )
                        }
                        rowOffset += rows
                    }
                    val context = InstrumentationRegistry.getInstrumentation().targetContext
                    File(context.getExternalFilesDir(null), "pos-receipt-reduced.png")
                        .outputStream()
                        .use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                } finally {
                    executor.shutdownNow()
                }
            }
        }
    }

    @Test
    fun registeredDeviceAndEndpointAreReShownAndReconnectKeepsAuthenticatedStaffScope() {
        showPos()
        compose.onNodeWithText("設定").performScrollTo().performClick()
        field("API URL（本番HTTPS）").performScrollTo().assertTextContains("http://127.0.0.1:9")
        field("登録済み端末ID（初回のみ）").performScrollTo().assertTextContains(fixtureDevice("hold"))
        field("API URL（本番HTTPS）").performScrollTo().performTextReplacement(fixtureApiBaseUrl())
        hideKeyboard()
        val priorLease = runBlocking { repository.snapshot().getString("leaseId") }
        compose.onNodeWithText("接続・初回同期").performScrollTo().performClick()
        compose.waitUntil(20000) {
            runBlocking { repository.snapshot().getString("leaseId") != priorLease }
        }
        runBlocking {
            assertEquals(fixtureStaff("cashier"), repository.dao.metadata("staffId"))
            assertEquals(
                fixtureDevice("hold"),
                repository.snapshot().getJSONObject("device").getString("id"),
            )
            assertEquals(0, repository.dao.pendingCount())
            val actor = repository.network.request("/v1/settings").getJSONObject("actor")
            assertEquals("cashier", actor.getString("role"))
            assertEquals(fixtureStaff("cashier"), actor.getString("staffId"))
            val failure =
                runCatching { repository.network.request("/v1/settings/tax-rate", JSONObject()) }
                    .exceptionOrNull()
            assertTrue(failure is NetworkFailure && failure.status == 403)
        }
    }

    @Test
    fun shiftCashInputsNeverReplaceExternalPaymentReferenceAndUnfinishedPaymentBlocksClose() {
        val checkout = runBlocking {
            repository.begin(listOf(line()), "0", "card", buyerName = buyer)
        }
        showPos()
        field("外部端末の成功確認番号").performScrollTo().performTextInput("EXTERNAL-REFERENCE-KEPT")
        hideKeyboard()
        compose.onNodeWithText("開局・締め").performScrollTo().performClick()
        field("釣銭準備金 / 現金実査額").performScrollTo().performTextReplacement("100")
        field("現金入出金理由").performScrollTo().performTextInput("合成の現金入金")
        hideKeyboard()
        compose.onNodeWithText("現金入金").performScrollTo().performClick()
        compose.waitUntil(10000) { runBlocking { repository.dao.pendingCount() == 1 } }
        compose.waitUntil(10000) {
            compose
                .onAllNodes(hasText("暫定締めを保存") and isEnabled())
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("暫定締めを保存").performScrollTo().performClick()
        compose.waitUntil(10000) {
            compose
                .onAllNodesWithText("外部決済の確認待ち", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        runBlocking {
            assertEquals("checking", repository.dao.checkoutById(checkout.id)!!.status)
            assertEquals(1, repository.dao.unknownCount())
            assertEquals(
                listOf("cash.move"),
                repository.dao.pending().map { JSONObject(it.payload).getString("type") },
            )
        }
        compose.onNodeWithText("販売").performScrollTo().performClick()
        field("外部端末の成功確認番号").performScrollTo().assertTextContains("EXTERNAL-REFERENCE-KEPT")
    }

    @Test
    fun invalidRawQuantityEditedDuringSaveNeverPersistsThePreviousQuantity() {
        showPos()
        addProduct()
        field("帳票宛名（設定で必須の場合あり）").performScrollTo().performTextInput(buyer)
        hideKeyboard()
        compose.waitUntil(10000) {
            compose.onAllNodesWithText("合計 108 円").fetchSemanticsNodes().isNotEmpty()
        }
        // Pause actual Room work, not its results: the operator can edit while save awaits its
        // quote.
        queryExecutor.pause()
        try {
            compose.onNodeWithText("保存して支払い開始").performScrollTo().performClick()
            compose.onNodeWithText("保存して支払い開始").assertIsNotEnabled()
            field("販売数量 1").performScrollTo().performTextReplacement("0")
            hideKeyboard()
        } finally {
            queryExecutor.release()
        }
        compose.waitUntil(10000) {
            compose
                .onAllNodesWithText("入力が変更されました。内容を確認してもう一度支払い開始を選んでください。")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        field("販売数量 1").performScrollTo().assertTextContains("0")
        compose.onNodeWithText("保存して支払い開始").assertIsNotEnabled()
        runBlocking {
            assertTrue(repository.dao.history().isEmpty())
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    @Test
    fun storeOperationsToolbarAndRetryRemainReachableWithKeyboardWithoutWritingBusinessRecords() {
        showPos()
        compose.onNodeWithText("店舗業務").performScrollTo().performClick()
        field("返品・調整・取消理由").performScrollTo().performTextInput("合成の業務確認理由")
        for (label in listOf("返品", "発注", "在庫", "棚卸", "移動", "同期確認")) {
            compose.onNodeWithText(label).performScrollTo().assertIsDisplayed().performClick()
        }
        compose.onNodeWithText("未完了操作を同じIDで再送").performScrollTo().assertIsDisplayed()
        runBlocking {
            assertTrue(repository.dao.history().isEmpty())
            assertEquals(0, repository.dao.pendingCount())
        }
    }

    private class GatedQueries : java.util.concurrent.Executor {
        private val delegate = java.util.concurrent.Executors.newSingleThreadExecutor()
        @Volatile private var gate: java.util.concurrent.CountDownLatch? = null

        fun pause() {
            check(gate == null)
            gate = java.util.concurrent.CountDownLatch(1)
        }

        fun release() {
            gate?.countDown()
            gate = null
        }

        override fun execute(command: Runnable) {
            val waiting = gate
            delegate.execute {
                check(waiting == null || waiting.await(90, java.util.concurrent.TimeUnit.SECONDS)) {
                    "The real Room query gate was not released"
                }
                command.run()
            }
        }

        fun close() {
            release()
            delegate.shutdownNow()
        }
    }
}
