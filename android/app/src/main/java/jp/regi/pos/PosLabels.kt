package jp.regi.pos

/**
 * Display text only; persisted payment methods and checkout states retain their protocol values.
 */
internal object PosLabels {
    fun paymentMethod(value: String): String =
        when (value) {
            "cash" -> "現金"
            "card" -> "カード"
            "qr" -> "QR"
            else -> "支払方法を確認"
        }

    fun checkoutStatus(value: String): String =
        when (value) {
            "draft" -> "保留"
            "checking" -> "支払い確認中"
            "unknown" -> "結果不明・確認待ち"
            "confirmed" -> "売上確定"
            "cancelled" -> "会計中止"
            else -> "状態を確認"
        }
}
