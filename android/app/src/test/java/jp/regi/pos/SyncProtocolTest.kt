package jp.regi.pos

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SyncProtocolTest {
    private fun event(sequence: Long, lease: String = "lease-a", padding: String = ""): Event {
        val id = "event-$sequence"
        return Event(
            id,
            sequence,
            JSONObject()
                .put("id", id)
                .put("sequence", sequence.toString())
                .put("leaseId", lease)
                .put("deviceId", "device-a")
                .put("padding", padding)
                .toString(),
        )
    }

    @Test
    fun batchesRespectCountBytesAndContiguousLeaseOrder() {
        val batch = SyncProtocol.nextBatch((1L..101L).map { event(it) })
        assertEquals(100, batch.events.size)
        assertEquals(100L, batch.events.last().sequence)
        assertEquals(batch.body.toString().toByteArray(Charsets.UTF_8).size, batch.bytes)
        val alternating = SyncProtocol.nextBatch(listOf(event(1), event(2, "lease-b"), event(3)))
        assertEquals(listOf(1L), alternating.events.map { it.sequence })
        val japanese =
            SyncProtocol.nextBatch((1L..100L).map { event(it, padding = "日本語😀\"\n".repeat(500)) })
        assertTrue(japanese.events.size < 100)
        assertTrue(japanese.bytes <= 256 * 1024)
    }

    @Test
    fun exactUtf8BoundaryAndSingleOversizeDoNotLoop() {
        val empty = SyncProtocol.nextBatch(listOf(event(1))).bytes
        val exact = event(1, padding = "x".repeat(1024 - empty))
        assertEquals(1024, SyncProtocol.nextBatch(listOf(exact), maxBytes = 1024).bytes)
        assertTrue(
            runCatching {
                    SyncProtocol.nextBatch(
                        listOf(event(1, padding = "x".repeat(1025 - empty))),
                        maxBytes = 1024,
                    )
                }
                .isFailure
        )
        assertTrue(runCatching { SyncProtocol.nextBatch(emptyList()) }.isFailure)
        assertEquals(1, SyncProtocol.smallerBatch(2))
        assertEquals(50, SyncProtocol.smallerBatch(100))
        assertTrue(runCatching { SyncProtocol.smallerBatch(1) }.isFailure)
    }

    @Test
    fun wireResultsAllowExactlyThreeStatusesAndOnlyRequestedUniqueIds() {
        fun result(id: String, status: String) = JSONObject().put("id", id).put("status", status)
        val dispositions =
            SyncProtocol.results(
                setOf("a", "b", "c"),
                JSONArray()
                    .put(result("a", "accepted"))
                    .put(result("b", "review"))
                    .put(result("c", "retry")),
            )
        assertEquals(listOf("accepted", "review", "retry"), dispositions.map { it.status })
        for (status in listOf("waiting", "dismissed", "unknown")) assertTrue(
            runCatching { SyncProtocol.results(setOf("a"), JSONArray().put(result("a", status))) }
                .isFailure
        )
        assertTrue(
            runCatching {
                    SyncProtocol.results(setOf("a"), JSONArray().put(result("other", "accepted")))
                }
                .isFailure
        )
        assertTrue(
            runCatching {
                    SyncProtocol.results(
                        setOf("a"),
                        JSONArray().put(result("a", "accepted")).put(result("a", "review")),
                    )
                }
                .isFailure
        )
        assertTrue(
            runCatching {
                    SyncProtocol.results(
                        setOf("a"),
                        JSONArray().put(JSONObject().put("status", "accepted")),
                    )
                }
                .isFailure
        )
        assertEquals(
            1,
            SyncProtocol.results(setOf("a", "b"), JSONArray().put(result("a", "accepted"))).size,
        )
    }

    @Test
    fun serverChangesAndReviewScopeAreValidatedSeparatelyFromWire() {
        for ((server, local) in
            mapOf(
                "pending" to "pending",
                "waiting" to "pending",
                "review" to "review",
                "accepted" to "accepted",
                "dismissed" to "accepted",
            )) {
            val change =
                JSONObject()
                    .put("entity_id", "a")
                    .put("body", JSONObject().put("id", "a").put("status", server))
            assertEquals(local, SyncProtocol.change(change).status)
        }
        assertTrue(
            runCatching {
                    SyncProtocol.change(
                        JSONObject()
                            .put("entity_id", "a")
                            .put("body", JSONObject().put("id", "b").put("status", "accepted"))
                    )
                }
                .isFailure
        )
        assertTrue(
            runCatching {
                    SyncProtocol.change(
                        JSONObject()
                            .put("entity_id", "a")
                            .put("body", JSONObject().put("id", "a").put("status", "other"))
                    )
                }
                .isFailure
        )
        assertEquals(
            setOf("a"),
            SyncProtocol.reviewIds(
                JSONArray()
                    .put(
                        JSONObject().put("id", "a").put("device_id", "mine").put("status", "review")
                    ),
                "mine",
            ),
        )
        assertTrue(
            runCatching {
                    SyncProtocol.reviewIds(
                        JSONArray()
                            .put(
                                JSONObject()
                                    .put("id", "a")
                                    .put("device_id", "other")
                                    .put("status", "review")
                            ),
                        "mine",
                    )
                }
                .isFailure
        )
    }
}
