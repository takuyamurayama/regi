package jp.regi.pos

import org.json.JSONArray
import org.json.JSONObject

data class SyncBatch(
    val events: List<Event>,
    val body: JSONObject,
    val leaseId: String,
    val deviceId: String,
    val bytes: Int,
)

data class SyncDisposition(val id: String, val status: String, val message: String?)

class SyncPayloadTooLargeFailure : IllegalStateException("1件のイベントが送信上限を超えています。元記録を保持し管理者へ確認してください")

object SyncProtocol {
    fun nextBatch(
        pending: List<Event>,
        maxCount: Int = 100,
        maxBytes: Int = 256 * 1024,
    ): SyncBatch {
        require(pending.isNotEmpty() && maxCount in 1..100 && maxBytes > 0)
        val first = JSONObject(pending.first().payload)
        val lease = first.getString("leaseId")
        val device = first.getString("deviceId")
        val selected = mutableListOf<Event>()
        val entries = JSONArray()
        var body = JSONObject().put("events", entries)
        var bytes = body.toString().toByteArray(Charsets.UTF_8).size
        for (event in pending.take(maxCount)) {
            val payload = JSONObject(event.payload)
            require(
                payload.getString("id") == event.id &&
                    payload.getString("sequence") == event.sequence.toString()
            ) {
                "未送信イベントのID・連番が一致しません"
            }
            if (payload.getString("leaseId") != lease || payload.getString("deviceId") != device)
                break
            val candidate =
                JSONObject()
                    .put("events", JSONArray(selected.map { JSONObject(it.payload) } + payload))
            val candidateBytes = candidate.toString().toByteArray(Charsets.UTF_8).size
            if (candidateBytes > maxBytes) {
                if (selected.isEmpty()) throw SyncPayloadTooLargeFailure()
                break
            }
            selected.add(event)
            body = candidate
            bytes = candidateBytes
        }
        return SyncBatch(selected, body, lease, device, bytes)
    }

    fun smallerBatch(size: Int): Int {
        if (size <= 1) throw SyncPayloadTooLargeFailure()
        return maxOf(1, size / 2)
    }

    fun results(requested: Set<String>, raw: JSONArray): List<SyncDisposition> {
        val seen = mutableSetOf<String>()
        return (0 until raw.length()).map { index ->
            val entry = raw.getJSONObject(index)
            val id = entry.getString("id")
            val status = entry.getString("status")
            require(
                id in requested && seen.add(id) && status in listOf("accepted", "review", "retry")
            ) {
                "同期応答のID・状態が不正です。元記録を保持して再送してください"
            }
            SyncDisposition(
                id,
                status,
                entry.optString("message").takeIf { it.isNotBlank() }
                    ?: entry.optString("code").takeIf { it.isNotBlank() },
            )
        }
    }

    fun change(entry: JSONObject): SyncDisposition {
        val body = entry.getJSONObject("body")
        val id = entry.getString("entity_id")
        require(id == body.getString("id")) { "同期差分のイベントIDが一致しません" }
        val status =
            when (body.getString("status")) {
                "accepted",
                "dismissed" -> "accepted"
                "pending",
                "waiting" -> "pending"
                "review" -> "review"
                else -> error("同期差分のイベント状態が不正です")
            }
        return SyncDisposition(id, status, body.optString("message").takeIf { it.isNotBlank() })
    }

    fun reviewIds(raw: JSONArray, deviceId: String): Set<String> =
        (0 until raw.length())
            .map { index ->
                val review = raw.getJSONObject(index)
                require(
                    review.getString("device_id") == deviceId &&
                        review.getString("status") == "review"
                ) {
                    "要確認一覧の端末・状態が一致しません"
                }
                review.getString("id")
            }
            .toSet()
}
