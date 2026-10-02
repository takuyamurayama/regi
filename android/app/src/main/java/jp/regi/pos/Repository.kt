package jp.regi.pos

import android.content.Context
import androidx.room.withTransaction
import androidx.work.*
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.bouncycastle.crypto.generators.SCrypt
import org.json.JSONArray
import org.json.JSONObject

class Repository(
    context: Context,
    val database: PosDatabase = PosDatabase.get(context),
    private val clock: () -> Instant = { Instant.now() },
) {
    val dao = database.dao()
    val network = Network(context) { clock().toEpochMilli() }
    private val work = WorkManager.getInstance(context)

    companion object {
        private val syncLock = Mutex()
    }

    private suspend fun effectiveNow(): Instant {
        val offset = (dao.metadata("serverClockOffset") ?: "0").toLong()
        val anchorElapsed =
            dao.metadata("serverClockElapsed")?.toLong() ?: return clock().plusMillis(offset)
        val elapsed = android.os.SystemClock.elapsedRealtime()
        require(elapsed >= anchorElapsed) { "再起動後はオンライン認証を更新してください" }
        val anchor = Instant.parse(dao.metadata("serverClockAnchor"))
        return maxOf(clock().plusMillis(offset), anchor.plusMillis(elapsed - anchorElapsed))
    }

    private suspend fun anchorClock(issuedAt: String) {
        dao.metadata(
            Metadata(
                "serverClockOffset",
                (Instant.parse(issuedAt).toEpochMilli() - clock().toEpochMilli()).toString(),
            )
        )
        dao.metadata(Metadata("serverClockAnchor", issuedAt))
        dao.metadata(
            Metadata("serverClockElapsed", android.os.SystemClock.elapsedRealtime().toString())
        )
    }

    suspend fun bootstrap(deviceId: String) {
        require(dao.pendingCount() == 0 && dao.unknownCount() == 0) {
            "未送信・確認待ちを解消してから認証情報を更新してください"
        }
        val registered =
            dao.metadata("bootstrap")?.let {
                JSONObject(it).getJSONObject("device").getString("id")
            }
        require(registered == null || registered == deviceId) {
            "登録済み端末の所属は変更できません。会計・履歴を保持し、新しい端末で登録してください"
        }
        val snapshot = network.request("/v1/sync/bootstrap?deviceId=$deviceId")
        val products = snapshot.getJSONArray("products")
        database.withTransaction {
            dao.products(
                (0 until products.length()).map { index -> product(products.getJSONObject(index)) }
            )
            dao.metadataPrefix("scheduledPrice-").forEach { dao.removeMetadata(it.key) }
            val schedules = snapshot.optJSONArray("priceSchedules") ?: JSONArray()
            for (index in 0 until schedules.length()) {
                val price = schedules.getJSONObject(index)
                dao.metadata(
                    Metadata(
                        "scheduledPrice-${price.getString("productId")}-${price.getString("effectiveAt")}",
                        price.toString(),
                    )
                )
            }
            dao.metadata(Metadata("bootstrap", snapshot.toString()))
            anchorClock(snapshot.getString("issuedAt"))
            dao.metadata(Metadata("lease-${snapshot.getString("leaseId")}", snapshot.toString()))
            dao.metadata(Metadata("cursor", snapshot.getString("cursor")))
            dao.metadata(
                Metadata(
                    "sequence",
                    maxOf(
                            (dao.metadata("sequence") ?: "0").toLong(),
                            snapshot.getString("sequence").toLong(),
                        )
                        .toString(),
                )
            )
            val activeShift = snapshot.optJSONObject("activeShift")
            if (activeShift != null) {
                dao.metadata(Metadata("shiftId", activeShift.getString("id")))
                dao.metadata(
                    Metadata("opening", activeShift.getJSONObject("body").getString("opening"))
                )
            } else {
                dao.removeMetadata("shiftId")
                dao.removeMetadata("opening")
            }
            dao.metadata(
                Metadata(
                    "stopped",
                    snapshot.getJSONObject("device").getBoolean("stopped").toString(),
                )
            )
        }
        val periodic =
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        work.enqueueUniquePeriodicWork("regi-sync", ExistingPeriodicWorkPolicy.KEEP, periodic)
    }

    suspend fun enroll(storeId: String, name: String): JSONObject {
        require(dao.metadata("bootstrap") == null) { "この端末は登録済みです。未送信・履歴を保護するため再登録できません" }
        val enrolled =
            command("/v1/devices/enroll", JSONObject().put("storeId", storeId).put("name", name))
        bootstrap(enrolled.getString("id"))
        return enrolled
    }

    private fun product(entry: JSONObject) =
        Product(
            entry.getString("id"),
            entry.getString("sku"),
            entry.optString("jan").takeUnless { it == "null" },
            entry.getString("name"),
            entry.getString("price"),
            entry.getString("cost"),
            entry.getInt("rate_bps"),
            entry.getBoolean("stock_managed"),
            entry.optString("tax_code"),
        )

    suspend fun snapshot() = JSONObject(dao.metadata("bootstrap") ?: error("初回同期が必要です"))

    suspend fun staff(): List<JSONObject> {
        val records = snapshot().getJSONArray("staff")
        return (0 until records.length()).map { records.getJSONObject(it) }
    }

    suspend fun authenticate(staffId: String, pin: String) {
        val entry = staff().first { it.getString("id") == staffId }
        val parts = entry.getString("pin_hash").split(":")
        val expected = parts[1].chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val actual = SCrypt.generate(pin.toByteArray(), parts[0].toByteArray(), 16384, 8, 1, 32)
        require(MessageDigest.isEqual(expected, actual)) { "PINが一致しません" }
        dao.metadata(Metadata("staffId", staffId))
        network.selectStaff(staffId)
    }

    suspend fun assertSaleAllowed() {
        val snapshot = snapshot()
        require(
            Money.offlineAllowed(
                effectiveNow(),
                Instant.parse(snapshot.getString("issuedAt")),
                Instant.parse(snapshot.getString("authUntil")),
                Instant.parse(snapshot.getString("contractUntil")),
            )
        ) {
            "72時間・認証・契約期限を確認し、オンライン同期してください"
        }
        require(snapshot.optString("stocktakeId").let { it.isBlank() || it == "null" }) {
            "店舗棚卸ロック中です"
        }
        require(dao.metadata("staffId") != null) { "担当者PIN認証が必要です" }
        require(dao.metadata("stopped") != "true") { "販売停止中です" }
        require(!dao.metadata("shiftId").isNullOrBlank()) { "開局してください" }
    }

    suspend fun openShift(opening: String, pin: String) {
        Money.value(opening)
        authenticate(dao.metadata("staffId") ?: error("担当者を選択してください"), pin)
        val snapshot = snapshot()
        require(snapshot.optString("stocktakeId").let { it.isBlank() || it == "null" }) {
            "店舗棚卸ロック中です"
        }
        require(
            Money.offlineAllowed(
                effectiveNow(),
                Instant.parse(snapshot.getString("issuedAt")),
                Instant.parse(snapshot.getString("authUntil")),
                Instant.parse(snapshot.getString("contractUntil")),
            )
        ) {
            "認証期限を確認してください"
        }
        database.withTransaction {
            require(dao.metadata("shiftId").isNullOrBlank()) { "開局済みです" }
            val id = UUID.randomUUID().toString()
            addEvent(id, "shift.open", JSONObject().put("opening", opening))
            dao.metadata(Metadata("shiftId", id))
            dao.metadata(Metadata("opening", opening))
            dao.metadata(Metadata("stopped", "false"))
        }
        enqueue()
    }

    private suspend fun addEvent(id: String, type: String, body: JSONObject) {
        val snapshot = snapshot()
        val sequence = (dao.metadata("sequence") ?: "0").toLong() + 1
        val event =
            JSONObject()
                .put("id", id)
                .put("deviceId", snapshot.getJSONObject("device").getString("id"))
                .put("leaseId", snapshot.getString("leaseId"))
                .put("sequence", sequence.toString())
                .put("staffId", dao.metadata("staffId"))
                .put("occurredAt", effectiveNow().toString())
                .put("ruleVersion", Money.ruleVersion)
                .put("type", type)
                .put("body", body)
        dao.event(Event(id, sequence, event.toString()))
        dao.metadata(Metadata("sequence", sequence.toString()))
    }

    suspend fun begin(
        lines: List<SaleLine>,
        discount: String,
        method: String,
        heldId: String? = null,
        status: String = "checking",
        buyerName: String = "",
    ): Checkout {
        assertSaleAllowed()
        require(status in listOf("checking", "draft"))
        if (heldId != null) require(dao.checkoutById(heldId)?.status == "draft") { "保留中の会計ではありません" }
        val snapshot = snapshot()
        val mode =
            snapshot.getJSONObject("settings").getJSONObject("tenant").getString("price_mode")
        val now = effectiveNow()
        val rates = snapshot.getJSONObject("settings").getJSONArray("taxRates")
        val refreshed =
            lines.map { line ->
                val product = dao.product(line.productId) ?: error("商品を同期してください")
                val scheduled =
                    dao.metadataPrefix("scheduledPrice-${line.productId}-")
                        .map { JSONObject(it.value) }
                        .filter { !Instant.parse(it.getString("effectiveAt")).isAfter(now) }
                        .maxByOrNull { Instant.parse(it.getString("effectiveAt")) }
                val masterTaxCode = scheduled?.optString("taxCode") ?: product.taxCode
                val taxCode =
                    if (masterTaxCode == "reduced" && line.taxContext == "dine-in") "standard"
                    else masterTaxCode
                val applicable =
                    (0 until rates.length())
                        .map { rates.getJSONObject(it) }
                        .filter {
                            it.getString("code") == taxCode &&
                                !Instant.parse(it.getString("effective_at")).isAfter(now)
                        }
                        .maxByOrNull { Instant.parse(it.getString("effective_at")) }
                line.copy(
                    name = scheduled?.optString("name") ?: product.name,
                    price = scheduled?.optString("price") ?: product.price,
                    cost = scheduled?.optString("cost") ?: product.cost,
                    rateBps = applicable?.getInt("rate_bps") ?: product.rateBps,
                )
            }
        val total = Money.calculate(refreshed, discount, mode)
        val receipt =
            snapshot.optJSONObject("receipt")
                ?: snapshot.getJSONObject("settings").optJSONObject("receipt")
                ?: JSONObject()
        require(!receipt.optBoolean("buyerRequired") || buyerName.isNotBlank()) { "帳票宛名を入力してください" }
        val body =
            JSONObject()
                .put("mode", mode)
                .put("discount", discount)
                .put("method", method)
                .put("total", total.total)
                .put("shiftId", dao.metadata("shiftId"))
                .put("leaseIdAtStart", snapshot.getString("leaseId"))
                .put("staffIdAtStart", dao.metadata("staffId"))
                .put("receipt", receipt)
                .put("buyerName", buyerName)
        body.put(
            "lines",
            JSONArray(
                total.lines.map { paid ->
                    val line = paid.input
                    JSONObject()
                        .put("productId", line.productId)
                        .put("name", line.name)
                        .put("quantity", line.quantity)
                        .put("price", line.price)
                        .put("discount", line.discount)
                        .put("rateBps", line.rateBps)
                        .put("cost", line.cost)
                        .put("stockManaged", line.stockManaged)
                        .put("taxContext", line.taxContext)
                        .put("net", paid.net)
                        .put("allocatedDiscount", paid.allocatedDiscount)
                        .put("paid", paid.paid)
                        .put("unitRefunds", JSONArray(paid.unitRefunds))
                }
            ),
        )
        body.put(
            "taxes",
            JSONArray(
                total.taxes.map { tax ->
                    JSONObject()
                        .put("rateBps", tax.rateBps)
                        .put("base", tax.base)
                        .put("tax", tax.tax)
                        .put("paid", tax.paid)
                }
            ),
        )
        val record =
            Checkout(
                heldId ?: UUID.randomUUID().toString(),
                status,
                body.toString(),
                now.toString(),
            )
        dao.checkout(record)
        return record
    }

    suspend fun unknown(id: String) {
        database.withTransaction {
            val record = dao.checkoutById(id) ?: error("会計がありません")
            require(record.status == "checking" || record.status == "unknown")
            dao.checkout(record.copy(status = "unknown"))
        }
    }

    suspend fun cancel(id: String) {
        database.withTransaction {
            val record = dao.checkoutById(id) ?: error("会計がありません")
            require(
                record.status == "draft" ||
                    (record.status == "checking" &&
                        JSONObject(record.body).getString("method") == "cash")
            ) {
                "外部決済・確認待ちは端末結果を照合してください"
            }
            dao.checkout(record.copy(status = "cancelled"))
        }
    }

    suspend fun confirm(id: String, tendered: String, reference: String): Checkout =
        database.withTransaction {
            val record = dao.checkoutById(id) ?: error("会計がありません")
            if (record.status == "confirmed") {
                val saved = JSONObject(record.body)
                require(
                    if (saved.getString("method") == "cash") saved.getString("tendered") == tendered
                    else saved.getString("reference") == reference
                ) {
                    "確定済み会計と確認内容が異なります"
                }
                return@withTransaction record
            }
            val originalLease =
                JSONObject(
                    dao.metadata("lease-${JSONObject(record.body).getString("leaseIdAtStart")}")
                        ?: error("開始時認証情報がありません")
                )
            val currentLease = snapshot()
            require(
                Money.offlineAllowed(
                    effectiveNow(),
                    Instant.parse(currentLease.getString("issuedAt")),
                    Instant.parse(currentLease.getString("authUntil")),
                    Instant.parse(currentLease.getString("contractUntil")),
                )
            ) {
                "認証期限を越えています。会計を保持したままオンライン認証を更新してください"
            }
            require(record.status == "checking" || record.status == "unknown")
            val body = JSONObject(record.body)
            val method = body.getString("method")
            body.put("paymentStartedAt", record.createdAt)
            body.put("paymentLeaseId", originalLease.getString("leaseId"))
            if (method == "cash") {
                require(Money.value(tendered) >= Money.value(body.getString("total"))) {
                    "現金預り額が不足しています"
                }
                body.put("tendered", tendered)
            } else {
                require(reference.isNotBlank()) { "外部端末の成功結果と確認番号が必要です" }
                body.put("reference", reference)
            }
            val snapshot = snapshot()
            val sequence = (dao.metadata("sequence") ?: "0").toLong() + 1
            val confirmedAt = maxOf(effectiveNow(), Instant.parse(record.createdAt)).toString()
            body.put("occurredAt", confirmedAt)
            val event =
                JSONObject()
                    .put("id", id)
                    .put("deviceId", snapshot.getJSONObject("device").getString("id"))
                    .put("leaseId", currentLease.getString("leaseId"))
                    .put("sequence", sequence.toString())
                    .put("staffId", body.getString("staffIdAtStart"))
                    .put("occurredAt", confirmedAt)
                    .put("ruleVersion", Money.ruleVersion)
                    .put("type", "sale")
                    .put("body", body)
            val result = record.copy(status = "confirmed", body = body.toString())
            dao.checkout(result)
            dao.event(Event(id, sequence, event.toString()))
            dao.metadata(Metadata("sequence", sequence.toString()))
            result
        }

    fun enqueue() {
        work.enqueueUniqueWork(
            "regi-immediate-sync",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build(),
        )
    }

    suspend fun command(path: String, input: JSONObject): JSONObject {
        val previous = dao.metadata("pendingCommand")?.takeIf { it.isNotBlank() }?.let(::JSONObject)
        if (previous != null)
            require(
                previous.getString("path") == path &&
                    previous.getString("input") == input.toString()
            ) {
                "未完了操作を先に再送してください"
            }
        val payload =
            previous?.getJSONObject("payload")
                ?: JSONObject(input.toString()).put("operationId", UUID.randomUUID().toString())
        dao.metadata(
            Metadata(
                "pendingCommand",
                JSONObject()
                    .put("path", path)
                    .put("input", input.toString())
                    .put("payload", payload)
                    .toString(),
            )
        )
        return try {
            val result = network.request(path, payload)
            dao.metadata(Metadata("pendingCommand", ""))
            result
        } catch (failure: NetworkFailure) {
            if (failure.status in 400..499) dao.metadata(Metadata("pendingCommand", ""))
            throw failure
        }
    }

    suspend fun retryCommand(): JSONObject {
        val pending =
            JSONObject(
                dao.metadata("pendingCommand")?.takeIf { it.isNotBlank() } ?: error("未完了操作はありません")
            )
        return command(pending.getString("path"), JSONObject(pending.getString("input")))
    }

    suspend fun sync() {
        syncLock.withLock {
            try {
                synchronize()
            } finally {
                dao.metadata(
                    Metadata(
                        "administratorLoginRequired",
                        network.oauth.requiresAdministratorLogin().toString(),
                    )
                )
            }
        }
    }

    private suspend fun openingAlias(id: String, response: JSONObject) {
        if (!response.has("shiftId") || !response.has("opening") || dao.metadata("shiftId") != id)
            return
        val event = dao.eventById(id) ?: return
        if (JSONObject(event.payload).optString("type") != "shift.open") return
        val target = response.getString("shiftId")
        UUID.fromString(target)
        Money.value(response.getString("opening"))
        dao.metadata(Metadata("shiftId", target))
        dao.metadata(Metadata("opening", response.getString("opening")))
    }

    private suspend fun synchronize() {
        var maxCount = 100
        var blocked: Exception? = null
        while (true) {
            val pending = dao.pending()
            if (pending.isEmpty()) break
            val batch =
                try {
                    SyncProtocol.nextBatch(pending, maxCount)
                } catch (failure: Exception) {
                    dao.result(pending.first().id, "pending", failure.message)
                    blocked = failure
                    break
                }
            val response =
                try {
                    require(batch.deviceId == snapshot().getJSONObject("device").getString("id")) {
                        "未送信イベントの端末が一致しません"
                    }
                    val lease =
                        dao.metadata("lease-${batch.leaseId}")?.let(::JSONObject)
                            ?: snapshot().takeIf { it.getString("leaseId") == batch.leaseId }
                            ?: error("イベント作成時の端末資格情報がありません。元記録を保持して管理者へ確認してください")
                    network.request("/v1/sync/events", batch.body, lease.getString("recoveryToken"))
                } catch (failure: NetworkFailure) {
                    if (failure.status == 413 && batch.events.size > 1) {
                        maxCount = SyncProtocol.smallerBatch(batch.events.size)
                        continue
                    }
                    val reason =
                        if (failure.status == 413) SyncPayloadTooLargeFailure() else failure
                    batch.events.forEach { dao.result(it.id, "pending", reason.message) }
                    blocked = reason
                    break
                } catch (failure: Exception) {
                    batch.events.forEach { dao.result(it.id, "pending", failure.message) }
                    blocked = failure
                    break
                }
            val raw = response.getJSONArray("results")
            val dispositions =
                try {
                    SyncProtocol.results(batch.events.map { it.id }.toSet(), raw)
                } catch (failure: Exception) {
                    batch.events.forEach { dao.result(it.id, "pending", failure.message) }
                    blocked = failure
                    break
                }
            database.withTransaction {
                dispositions.forEach { entry ->
                    dao.result(
                        entry.id,
                        if (entry.status == "retry") "pending" else entry.status,
                        entry.message,
                    )
                    val original =
                        (0 until raw.length())
                            .map { raw.getJSONObject(it) }
                            .first { it.getString("id") == entry.id }
                    openingAlias(entry.id, original)
                }
                dao.metadata(Metadata("reviewCount", dao.reviewCount().toString()))
            }
            if (dispositions.none { it.status != "retry" }) {
                blocked = IllegalStateException("未送信イベントが残っています。同じイベントを再送してください")
                break
            }
        }
        renewAuthentication()
        val changes = network.request("/v1/sync/changes?cursor=${dao.metadata("cursor") ?: "0"}")
        database.withTransaction {
            val entries = changes.getJSONArray("changes")
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                if (entry.getString("kind") == "product") {
                    dao.metadata(Metadata("masterRefreshRequired", "true"))
                    val price = entry.getJSONObject("body")
                    if (price.has("effectiveAt") && price.has("price"))
                        dao.metadata(
                            Metadata(
                                "scheduledPrice-${entry.getString("entity_id")}-${price.getString("effectiveAt")}",
                                price.toString(),
                            )
                        )
                }
                if (entry.getString("kind") == "tax-rate") {
                    val tax = entry.getJSONObject("body")
                    val cached = snapshot()
                    cached
                        .getJSONObject("settings")
                        .getJSONArray("taxRates")
                        .put(
                            JSONObject()
                                .put("id", entry.getString("entity_id"))
                                .put("code", tax.getString("code"))
                                .put("rate_bps", tax.getInt("rateBps"))
                                .put("effective_at", tax.getString("effectiveAt"))
                        )
                    dao.metadata(Metadata("bootstrap", cached.toString()))
                }
                if (entry.getString("kind") == "sale")
                    dao.result(entry.getString("entity_id"), "accepted", null)
                if (entry.getString("kind") == "device-event") {
                    val disposition = SyncProtocol.change(entry)
                    if (dao.eventById(disposition.id) != null) {
                        dao.result(disposition.id, disposition.status, disposition.message)
                        dao.metadata(
                            Metadata(
                                "deviceEvent-${disposition.id}",
                                entry.getJSONObject("body").toString(),
                            )
                        )
                        openingAlias(disposition.id, entry.getJSONObject("body"))
                    }
                }
            }
            dao.metadata(Metadata("cursor", changes.getString("cursor")))
        }
        if (
            dao.metadata("masterRefreshRequired") == "true" &&
                dao.pendingCount() == 0 &&
                dao.unknownCount() == 0
        ) {
            val current = network.request("/v1/products").getJSONArray("items")
            dao.products((0 until current.length()).map { product(current.getJSONObject(it)) })
            dao.metadata(Metadata("masterRefreshRequired", "false"))
            dao.metadataPrefix("scheduledPrice-")
                .filter {
                    !Instant.parse(JSONObject(it.value).getString("effectiveAt"))
                        .isAfter(Instant.now())
                }
                .forEach { dao.removeMetadata(it.key) }
        }
        val device = snapshot().getJSONObject("device")
        val serverReviews =
            network
                .request(
                    "/v1/sync/reviews?storeId=${device.getString("store_id")}&deviceId=${device.getString("id")}"
                )
                .getJSONArray("items")
        val reviewIds = SyncProtocol.reviewIds(serverReviews, device.getString("id"))
        database.withTransaction {
            dao.reviews()
                .filter { it.id !in reviewIds }
                .forEach { dao.result(it.id, "pending", "サーバーの要確認一覧にありません。同じ元記録を再送してください") }
            dao.metadata(Metadata("reviewCount", dao.reviewCount().toString()))
        }
        network.request(
            "/v1/devices/${device.getString("id")}/status",
            JSONObject()
                .put("operationId", UUID.randomUUID())
                .put("storeId", device.getString("store_id"))
                .put("pending", dao.pendingCount() + dao.unknownCount())
                .put("reviewCount", dao.reviewCount())
                .put("stopped", dao.metadata("stopped") == "true"),
        )
        if (dao.pendingCount() > 0)
            throw blocked ?: IllegalStateException("未送信イベントが残っています。同じイベントを再送してください")
    }

    suspend fun renewAuthentication() {
        val current = snapshot()
        val result =
            network.request(
                "/v1/devices/${current.getJSONObject("device").getString("id")}/lease",
                JSONObject(),
            )
        database.withTransaction {
            val updated = snapshot()
            result.keys().forEach { key -> updated.put(key, result.get(key)) }
            dao.metadata(Metadata("bootstrap", updated.toString()))
            dao.metadata(Metadata("lease-${result.getString("leaseId")}", updated.toString()))
            anchorClock(result.getString("issuedAt"))
            if (!result.isNull("stocktakeId")) dao.metadata(Metadata("stopped", "true"))
            val selected = dao.metadata("staffId")
            if (selected != null && staff().none { it.getString("id") == selected }) {
                dao.removeMetadata("staffId")
                network.selectStaff(null)
            }
        }
    }

    suspend fun close(actual: String) {
        Money.value(actual)
        require(dao.unknownCount() == 0) { "外部決済の確認待ちを解消してください" }
        database.withTransaction {
            val shift = dao.metadata("shiftId")?.takeIf { it.isNotBlank() } ?: error("未開局です")
            addEvent(
                UUID.randomUUID().toString(),
                "shift.close",
                JSONObject().put("shiftId", shift).put("actual", actual),
            )
            dao.metadata(
                Metadata(
                    "lastClose",
                    JSONObject()
                        .put("status", "provisional")
                        .put("actual", actual)
                        .put("shiftId", shift)
                        .toString(),
                )
            )
            dao.metadata(Metadata("shiftId", ""))
            dao.metadata(Metadata("stopped", "true"))
        }
        enqueue()
    }

    suspend fun cashMovement(amount: String, direction: String, reason: String) {
        Money.value(amount)
        require(direction in listOf("in", "out") && reason.isNotBlank()) { "入出金方向・理由を指定してください" }
        assertSaleAllowed()
        database.withTransaction {
            addEvent(
                UUID.randomUUID().toString(),
                "cash.move",
                JSONObject()
                    .put("shiftId", dao.metadata("shiftId"))
                    .put("amount", amount)
                    .put("direction", direction)
                    .put("reason", reason),
            )
        }
        enqueue()
    }

    suspend fun logout() {
        dao.removeMetadata("staffId")
        network.logout()
    }
}

class SyncWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        try {
            Repository(applicationContext).sync()
            Result.success()
        } catch (_: SyncPayloadTooLargeFailure) {
            Result.failure()
        } catch (_: AdministratorLoginRequired) {
            Result.failure()
        } catch (_: Exception) {
            Result.retry()
        }
}
