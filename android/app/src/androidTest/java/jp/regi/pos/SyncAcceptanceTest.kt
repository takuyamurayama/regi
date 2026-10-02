package jp.regi.pos

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.ServerSocket
import java.net.SocketException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

data class SyncRequest(val path: String, val body: JSONObject?, val bytes: Int)

class PosHttpStub(private val respond: (SyncRequest) -> Pair<Int, String>) : AutoCloseable {
    private val listener = ServerSocket(0)
    private val executor = Executors.newSingleThreadExecutor()
    val requests = java.util.Collections.synchronizedList(mutableListOf<SyncRequest>())
    val base = "http://127.0.0.1:${listener.localPort}"
    private val task =
        executor.submit {
            try {
                while (!listener.isClosed) {
                    listener.accept().use { socket ->
                        socket.soTimeout = 5000
                        val input = socket.getInputStream().buffered()
                        fun line(): String {
                            val bytes = java.io.ByteArrayOutputStream()
                            while (true) {
                                val next = input.read()
                                if (next < 0 || next == 10) break
                                if (next != 13) bytes.write(next)
                            }
                            return bytes.toString("UTF-8")
                        }
                        val path = line().split(' ')[1]
                        var length = 0
                        while (true) {
                            val header = line()
                            if (header.isEmpty()) break
                            if (header.startsWith("Content-Length:", true))
                                length = header.substringAfter(':').trim().toInt()
                        }
                        val raw = ByteArray(length)
                        var read = 0
                        while (read < length) {
                            val count = input.read(raw, read, length - read)
                            check(count > 0)
                            read += count
                        }
                        val rawText = String(raw, Charsets.UTF_8)
                        val body =
                            if (length == 0) null
                            else if (rawText.trimStart().startsWith("{")) JSONObject(rawText)
                            else JSONObject().put("form", rawText)
                        val request = SyncRequest(path, body, length)
                        requests.add(request)
                        val (status, text) = respond(request)
                        val bytes = text.toByteArray(Charsets.UTF_8)
                        socket
                            .getOutputStream()
                            .write(
                                ("HTTP/1.1 $status OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
                                    .toByteArray()
                            )
                        socket.getOutputStream().write(bytes)
                    }
                }
            } catch (failure: SocketException) {
                if (!listener.isClosed) throw failure
            }
        }

    override fun close() {
        listener.close()
        task.get(10, java.util.concurrent.TimeUnit.SECONDS)
        executor.shutdownNow()
    }
}

@RunWith(AndroidJUnit4::class)
class SyncAcceptanceTest {
    private val device = "40000000-0000-4000-8000-000000000031"
    private val store = "20000000-0000-4000-8000-000000000031"
    private val lease = "50000000-0000-4000-8000-000000000031"

    private fun defaultReply(
        request: SyncRequest,
        changes: JSONArray = JSONArray(),
        reviews: JSONArray = JSONArray(),
    ): Pair<Int, String> {
        val text =
            when {
                request.path == "/v1/sync/events" -> {
                    val events = request.body!!.getJSONArray("events")
                    JSONObject()
                        .put(
                            "results",
                            JSONArray(
                                (0 until events.length()).map {
                                    JSONObject()
                                        .put("id", events.getJSONObject(it).getString("id"))
                                        .put("status", "accepted")
                                }
                            ),
                        )
                        .toString()
                }
                request.path.endsWith("/lease") ->
                    JSONObject()
                        .put("leaseId", lease)
                        .put("recoveryToken", "stub-recovery")
                        .put("issuedAt", Instant.now().toString())
                        .put("authUntil", Instant.now().plusSeconds(259200).toString())
                        .put("contractUntil", Instant.now().plusSeconds(31536000).toString())
                        .put("staff", JSONArray())
                        .put("stocktakeId", JSONObject.NULL)
                        .toString()
                request.path.startsWith("/v1/sync/changes") ->
                    JSONObject().put("changes", changes).put("cursor", "10").toString()
                request.path.startsWith("/v1/sync/reviews") -> reviews.toString()
                request.path == "/v1/products" -> "[]"
                else -> "{}"
            }
        return 200 to text
    }

    private suspend fun withRepository(
        respond: (SyncRequest) -> Pair<Int, String> = { defaultReply(it) },
        block: suspend (Repository, PosHttpStub) -> Unit,
    ) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "sync-${UUID.randomUUID()}.db"
        val database = Room.databaseBuilder(context, PosDatabase::class.java, name).build()
        PosHttpStub(respond).use { server ->
            try {
                val repository = Repository(context, database)
                repository.network.configure(
                    server.base,
                    "",
                    true,
                    "sync-test",
                    "10000000-0000-4000-8000-000000000031",
                )
                val boot =
                    JSONObject()
                        .put("device", JSONObject().put("id", device).put("store_id", store))
                        .put("leaseId", lease)
                        .put("recoveryToken", "stub-recovery")
                        .put("settings", JSONObject().put("taxRates", JSONArray()))
                repository.dao.metadata(Metadata("bootstrap", boot.toString()))
                repository.dao.metadata(Metadata("lease-$lease", boot.toString()))
                block(repository, server)
            } finally {
                database.close()
                context.deleteDatabase(name)
            }
        }
    }

    private fun event(
        sequence: Long,
        type: String = "sale",
        status: String = "pending",
        padding: String = "",
    ): Event {
        val id = UUID.randomUUID().toString()
        val payload =
            JSONObject()
                .put("id", id)
                .put("deviceId", device)
                .put("leaseId", lease)
                .put("sequence", sequence.toString())
                .put("type", type)
                .put("body", JSONObject().put("padding", padding))
        return Event(
            id,
            sequence,
            payload.toString(),
            status,
            if (status == "review") "要確認試験" else null,
        )
    }

    @Test
    fun drainsTwoHundredFiveEventsAndPostsSeparateCounts() = runBlocking {
        withRepository { repository, server ->
            repeat(205) { repository.dao.event(event(it + 1L)) }
            repository.sync()
            assertEquals(0, repository.dao.pendingCount())
            assertEquals(
                listOf(100, 100, 5),
                server.requests
                    .filter { it.path == "/v1/sync/events" }
                    .map { it.body!!.getJSONArray("events").length() },
            )
            val status = server.requests.last { it.path.endsWith("/status") }.body!!
            assertEquals(0, status.getInt("pending"))
            assertEquals(0, status.getInt("reviewCount"))
            assertEquals(4, repository.database.openHelper.readableDatabase.version)
        }
    }

    @Test
    fun pendingCountExcludesReviewAndChangesResolveEveryEventKind() = runBlocking {
        val events =
            listOf(
                event(1, "sale", "review"),
                event(2, "shift.open", "review"),
                event(3, "cash.move", "review"),
                event(4, "shift.close", "review"),
            )
        val changes =
            JSONArray(
                events.mapIndexed { index, event ->
                    JSONObject()
                        .put("kind", "device-event")
                        .put("entity_id", event.id)
                        .put(
                            "body",
                            JSONObject()
                                .put("id", event.id)
                                .put("status", if (index % 2 == 0) "accepted" else "dismissed"),
                        )
                }
            )
        withRepository({ defaultReply(it, changes) }) { repository, server ->
            events.forEach { repository.dao.event(it) }
            assertEquals(0, repository.dao.pendingCount())
            repository.dao.metadata(Metadata("masterRefreshRequired", "true"))
            repository.sync()
            assertEquals(0, repository.dao.reviews().size)
            assertEquals(0, repository.dao.pendingCount())
            assertTrue(server.requests.any { it.path == "/v1/products" })
        }
    }

    @Test
    fun serverMissingReviewReturnsToPendingWithoutChangingPayload() = runBlocking {
        withRepository { repository, _ ->
            val original = event(1, "cash.move", "review")
            repository.dao.event(original)
            assertTrue(runCatching { repository.sync() }.isFailure)
            val pending = repository.dao.pending()
            assertEquals(1, pending.size)
            assertEquals(original.payload, pending.single().payload)
            assertEquals(original.id, pending.single().id)
        }
    }

    @Test
    fun utf8BatchLimitAnd413ShrinkPreserveEvents() = runBlocking {
        var rejected = false
        withRepository({ request ->
            if (request.path == "/v1/sync/events" && !rejected) {
                rejected = true
                413 to "{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"分割して再送\"}"
            } else defaultReply(request)
        }) { repository, server ->
            repeat(101) { repository.dao.event(event(it + 1L, padding = "日本語😀\"\n".repeat(500))) }
            repository.sync()
            assertEquals(0, repository.dao.pendingCount())
            val batches = server.requests.filter { it.path == "/v1/sync/events" }
            assertTrue(
                batches.all {
                    it.bytes <= 256 * 1024 && it.body!!.getJSONArray("events").length() <= 100
                }
            )
            assertTrue(
                batches[1].body!!.getJSONArray("events").length() <
                    batches[0].body!!.getJSONArray("events").length()
            )
        }
    }

    @Test
    fun retryAndUnknownWireStatusNeverBecomeUnstoredReview() = runBlocking {
        for (status in listOf("retry", "waiting", "dismissed", "unknown")) {
            withRepository({ request ->
                if (request.path == "/v1/sync/events")
                    200 to
                        JSONObject()
                            .put(
                                "results",
                                JSONArray()
                                    .put(
                                        JSONObject()
                                            .put(
                                                "id",
                                                request.body!!
                                                    .getJSONArray("events")
                                                    .getJSONObject(0)
                                                    .getString("id"),
                                            )
                                            .put("status", status)
                                    ),
                            )
                            .toString()
                else defaultReply(request)
            }) { repository, server ->
                val original = event(1)
                repository.dao.event(original)
                assertTrue(runCatching { repository.sync() }.isFailure)
                assertEquals(1, repository.dao.pending().size)
                assertEquals(original.payload, repository.dao.pending().single().payload)
                assertEquals(0, repository.dao.reviews().size)
                assertEquals(1, server.requests.count { it.path == "/v1/sync/events" })
            }
        }
    }

    @Test
    fun singleOversizeEventIsRetainedWithoutSending() = runBlocking {
        withRepository { repository, server ->
            repository.dao.event(event(1, padding = "日".repeat(100000)))
            assertTrue(runCatching { repository.sync() }.isFailure)
            assertEquals(1, repository.dao.pending().size)
            assertTrue(server.requests.none { it.path == "/v1/sync/events" })
        }
    }

    private suspend fun nonJson413(body: String) {
        var rejected = false
        withRepository({ request ->
            if (request.path == "/v1/sync/events" && !rejected) {
                rejected = true
                413 to body
            } else defaultReply(request)
        }) { repository, server ->
            repeat(4) { repository.dao.event(event(it + 1L)) }
            repository.sync()
            assertEquals(0, repository.dao.pendingCount())
            val batches = server.requests.filter { it.path == "/v1/sync/events" }
            assertEquals(listOf(4, 2, 2), batches.map { it.body!!.getJSONArray("events").length() })
        }
    }

    @Test fun html413ShrinksBatch() = runBlocking { nonJson413("<html>Payload too large</html>") }

    @Test fun empty413ShrinksBatch() = runBlocking { nonJson413("") }

    @Test
    fun partialRetryAndReviewCountsAllowMasterRefreshAfterReplay() = runBlocking {
        val originals = listOf(event(1), event(2, "cash.move"), event(3, "shift.close"))
        var attempts = 0
        var recovering = false
        val reviews =
            JSONArray()
                .put(
                    JSONObject()
                        .put("id", originals[1].id)
                        .put("device_id", device)
                        .put("status", "review")
                )
        withRepository({ request ->
            if (request.path == "/v1/sync/events" && !recovering) {
                attempts++
                val events = request.body!!.getJSONArray("events")
                200 to
                    JSONObject()
                        .put(
                            "results",
                            JSONArray(
                                (0 until events.length()).map { index ->
                                    val id = events.getJSONObject(index).getString("id")
                                    JSONObject()
                                        .put("id", id)
                                        .put(
                                            "status",
                                            if (attempts == 1 && id == originals[0].id) "accepted"
                                            else if (id == originals[1].id) "review" else "retry",
                                        )
                                        .put("message", "同期状態試験")
                                }
                            ),
                        )
                        .toString()
            } else defaultReply(request, reviews = reviews)
        }) { repository, server ->
            originals.forEach { repository.dao.event(it) }
            assertTrue(runCatching { repository.sync() }.isFailure)
            assertEquals(listOf(originals[2].id), repository.dao.pending().map { it.id })
            assertEquals(originals[2].payload, repository.dao.pending().single().payload)
            assertEquals(1, repository.dao.pendingCount())
            assertEquals(1, repository.dao.reviewCount())
            assertEquals("1", repository.dao.metadata("reviewCount"))
            val status = server.requests.last { it.path.endsWith("/status") }.body!!
            assertEquals(1, status.getInt("pending"))
            assertEquals(1, status.getInt("reviewCount"))
            recovering = true
            repository.dao.metadata(Metadata("masterRefreshRequired", "true"))
            repository.sync()
            assertEquals(0, repository.dao.pendingCount())
            assertEquals(1, repository.dao.reviewCount())
            assertTrue(server.requests.any { it.path == "/v1/products" })
            assertEquals("false", repository.dao.metadata("masterRefreshRequired"))
        }
    }

    @Test
    fun dismissedOpeningMapsCashAmountWithoutRewritingOutboxOrAnotherShift() = runBlocking {
        val original = event(1, "shift.open", "review")
        val target = UUID.randomUUID().toString()
        val body =
            JSONObject()
                .put("id", original.id)
                .put("status", "dismissed")
                .put("shiftId", target)
                .put("opening", "1000")
        val changes =
            JSONArray()
                .put(
                    JSONObject()
                        .put("kind", "device-event")
                        .put("entity_id", original.id)
                        .put("body", body)
                )
        for (current in listOf(original.id, UUID.randomUUID().toString())) {
            withRepository({ defaultReply(it, changes) }) { repository, _ ->
                repository.dao.event(original)
                repository.dao.metadata(Metadata("shiftId", current))
                repository.dao.metadata(Metadata("opening", "2000"))
                repository.sync()
                assertEquals(
                    if (current == original.id) target else current,
                    repository.dao.metadata("shiftId"),
                )
                assertEquals(
                    if (current == original.id) "1000" else "2000",
                    repository.dao.metadata("opening"),
                )
                assertEquals(original.payload, repository.dao.eventById(original.id)!!.payload)
                assertEquals("accepted", repository.dao.eventById(original.id)!!.status)
            }
        }
    }

    @Test
    fun httpFailureAndMissingResultsPreserveOriginalPending() = runBlocking {
        for (response in
            listOf(
                500 to "{\"code\":\"INTERNAL_ERROR\",\"message\":\"再試行\"}",
                200 to "{\"results\":[]}",
                200 to "{\"results\":\"invalid\"}",
            )) {
            withRepository({ if (it.path == "/v1/sync/events") response else defaultReply(it) }) {
                repository,
                server ->
                val original = event(1)
                repository.dao.event(original)
                assertTrue(runCatching { repository.sync() }.isFailure)
                assertEquals(original.payload, repository.dao.pending().single().payload)
                assertEquals(0, repository.dao.reviewCount())
                assertEquals(1, server.requests.count { it.path == "/v1/sync/events" })
            }
        }
    }
}
