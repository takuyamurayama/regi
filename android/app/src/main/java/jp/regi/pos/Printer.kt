package jp.regi.pos

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import java.net.InetSocketAddress
import java.net.Socket
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

object Printer {
    private val transactionTimeFormatter =
        DateTimeFormatter.ofPattern("uuuu/MM/dd HH:mm:ss", Locale.JAPAN)
            .withZone(ZoneId.of("Asia/Tokyo"))

    private fun transactionTimeLabel(savedTime: String): String =
        "取引日時 ${transactionTimeFormatter.format(Instant.parse(savedTime))}（日本時間）"

    fun receiptLines(checkout: Checkout): List<String> {
        require(checkout.status == "confirmed") { "確定済みの保存記録のみ印刷できます" }
        val body = JSONObject(checkout.body)
        val lines = body.getJSONArray("lines")
        val receipt = body.optJSONObject("receipt") ?: JSONObject()
        val text =
            mutableListOf(
                if (receipt.optBoolean("registered"))
                    (if (receipt.optBoolean("buyerRequired")) "REGI 適格請求書" else "REGI 適格簡易領収書")
                else "REGI 領収書（非登録事業者）",
                receipt.optString("sellerName"),
                receipt.optString("storeName"),
                receipt.optString("address"),
                checkout.id,
                transactionTimeLabel(body.optString("occurredAt", checkout.createdAt)),
            )
        if (receipt.optBoolean("registered"))
            text.add("登録番号 ${receipt.getString("registrationNumber")}")
        if (body.optString("buyerName").isNotBlank())
            text.add("宛名 ${body.getString("buyerName")} 様")
        for (index in 0 until lines.length()) {
            val line = lines.getJSONObject(index)
            val reduced =
                line.has("reducedTarget") &&
                    !line.isNull("reducedTarget") &&
                    line.getBoolean("reducedTarget")
            text.add(
                "${if (reduced) "※ " else ""}${line.getString("name")} × ${line.getInt("quantity")}"
            )
            text.add("単価 ${line.getString("price")}円  税率 ${line.getInt("rateBps") / 100.0}%")
            text.add(
                "商品値引き ${line.getString("discount")}円 / 会計配分 ${line.getString("allocatedDiscount")}円"
            )
            text.add("明細支払 ${line.getString("paid")}円")
        }
        if (
            (0 until lines.length()).any {
                lines.getJSONObject(it).optBoolean("reducedTarget", false)
            }
        )
            text.add("※ 軽減税率対象")
        text.add("合計 ${body.getString("total")} 円")
        text.add("支払 ${PosLabels.paymentMethod(body.getString("method"))}")
        if (body.getString("method") == "cash") {
            text.add("預り ${body.getString("tendered")}円")
            text.add(
                "釣銭 ${Money.value(body.getString("tendered")) - Money.value(body.getString("total"))}円"
            )
        }
        val taxes = body.optJSONArray("taxes")
        if (taxes != null)
            for (index in 0 until taxes.length()) {
                val tax = taxes.getJSONObject(index)
                text.add(
                    "${tax.getInt("rateBps") / 100.0}% 税込 ${tax.getString("paid")}円 / 税額 ${tax.getString("tax")}円"
                )
            }
        return text
    }

    suspend fun print(host: String, checkout: Checkout, port: Int = 9100) =
        withContext(Dispatchers.IO) {
            val text = receiptLines(checkout)
            val width = 576
            val paint =
                Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.BLACK
                    textSize = 22f
                }
            val wrapped =
                text.flatMap { line ->
                    val segments = mutableListOf<String>()
                    var remaining = line
                    while (remaining.isNotEmpty()) {
                        val length =
                            paint
                                .breakText(remaining, true, (width - 16).toFloat(), null)
                                .coerceAtLeast(1)
                        segments.add(remaining.take(length))
                        remaining = remaining.drop(length)
                    }
                    if (segments.isEmpty()) listOf("") else segments
                }
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), 5000)
                socket.soTimeout = 5000
                socket.getOutputStream().use { output ->
                    output.write(byteArrayOf(0x1b, 0x40))
                    for (chunk in wrapped.chunked(40)) {
                        val height = chunk.size * 34
                        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        try {
                            val canvas = Canvas(bitmap)
                            canvas.drawColor(Color.WHITE)
                            chunk.forEachIndexed { index, line ->
                                canvas.drawText(line, 8f, (index * 34 + 28).toFloat(), paint)
                            }
                            val bytesPerRow = width / 8
                            val raster = ByteArray(bytesPerRow * height)
                            for (row in 0 until height) for (column in 0 until width) {
                                val pixel = bitmap.getPixel(column, row)
                                if (
                                    Color.red(pixel) + Color.green(pixel) + Color.blue(pixel) < 384
                                ) {
                                    val offset = row * bytesPerRow + column / 8
                                    raster[offset] =
                                        (raster[offset].toInt() or (0x80 shr (column % 8))).toByte()
                                }
                            }
                            output.write(
                                byteArrayOf(
                                    0x1d,
                                    0x76,
                                    0x30,
                                    0,
                                    bytesPerRow.toByte(),
                                    (bytesPerRow shr 8).toByte(),
                                    height.toByte(),
                                    (height shr 8).toByte(),
                                )
                            )
                            output.write(raster)
                        } finally {
                            bitmap.recycle()
                        }
                    }
                    output.write(byteArrayOf(0x0a, 0x0a, 0x1d, 0x56, 0x00))
                    output.flush()
                }
            }
        }
}
