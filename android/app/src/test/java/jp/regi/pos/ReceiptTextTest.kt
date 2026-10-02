package jp.regi.pos

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReceiptTextTest {
    private fun checkout(flag: Boolean?, rate: Int): Checkout {
        val line =
            JSONObject()
                .put("name", "保存済商品")
                .put("quantity", 1)
                .put("price", "100")
                .put("discount", "0")
                .put("allocatedDiscount", "0")
                .put("paid", "108")
                .put("rateBps", rate)
        if (flag != null) line.put("reducedTarget", flag)
        val body =
            JSONObject()
                .put("lines", JSONArray().put(line))
                .put("total", "108")
                .put("method", "cash")
                .put("tendered", "200")
                .put("buyerName", "合成宛名")
                .put("occurredAt", "2026-10-02T00:00:00Z")
                .put(
                    "receipt",
                    JSONObject()
                        .put("registered", true)
                        .put("buyerRequired", true)
                        .put("registrationNumber", "T0000000000000")
                        .put("sellerName", "保存済発行者")
                        .put("storeName", "合成店"),
                )
                .put(
                    "taxes",
                    JSONArray()
                        .put(JSONObject().put("rateBps", rate).put("paid", "108").put("tax", "8")),
                )
        return Checkout("synthetic-receipt", "confirmed", body.toString(), "2026-10-02T00:00:00Z")
    }

    @Test
    fun reducedMarkerUsesStoredClassificationAcrossRatesAndPreservesCashReceipt() {
        val saved = checkout(true, 1200)
        val text = Printer.receiptLines(saved)
        assertTrue(text.contains("※ 保存済商品 × 1"))
        assertEquals(1, text.count { it == "※ 軽減税率対象" })
        assertTrue(text.contains("REGI 適格請求書"))
        assertTrue(text.contains("登録番号 T0000000000000"))
        assertTrue(text.contains("宛名 合成宛名 様"))
        assertTrue(text.contains("支払 現金"))
        assertTrue(text.contains("預り 200円"))
        assertTrue(text.contains("釣銭 92円"))
        assertTrue(text.contains("12.0% 税込 108円 / 税額 8円"))
        assertEquals(text, Printer.receiptLines(saved.copy()))
    }

    @Test
    fun ordinaryEightPercentAndLegacyUnknownNeverInventReducedClassification() {
        for (flag in listOf(false, null)) {
            val text = Printer.receiptLines(checkout(flag, 800))
            assertTrue(text.contains("保存済商品 × 1"))
            assertFalse(text.any { it.contains("軽減税率対象") || it.startsWith("※ ") })
            assertTrue(text.contains("8.0% 税込 108円 / 税額 8円"))
        }
    }

    @Test
    fun transactionTimeUsesJapanTimezoneAcrossMidnightAndPreservesSavedSource() {
        val original = checkout(true, 800)
        val body = JSONObject(original.body).put("occurredAt", "2026-10-02T16:34:21.079Z")
        val saved = original.copy(body = body.toString())
        assertTrue(Printer.receiptLines(saved).contains("取引日時 2026/10/03 01:34:21（日本時間）"))
        assertEquals(body.toString(), saved.body)
        assertEquals("2026-10-02T16:34:21.079Z", JSONObject(saved.body).getString("occurredAt"))

        val legacy =
            saved.copy(
                body = JSONObject(saved.body).apply { remove("occurredAt") }.toString(),
                createdAt = "2026-10-02T14:59:59Z",
            )
        assertTrue(Printer.receiptLines(legacy).contains("取引日時 2026/10/02 23:59:59（日本時間）"))
        assertEquals("2026-10-02T14:59:59Z", legacy.createdAt)
        assertFalse(JSONObject(legacy.body).has("occurredAt"))
    }
}
