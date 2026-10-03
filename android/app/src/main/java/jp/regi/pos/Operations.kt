package jp.regi.pos

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class OrderFormLine(val product: Product, val quantity: String, val cost: String)

@Composable
fun Operations(repository: Repository) {
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    var task by remember { mutableStateOf("返品") }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    var records by remember { mutableStateOf(emptyList<JSONObject>()) }
    var products by remember { mutableStateOf(emptyList<Product>()) }
    var query by remember { mutableStateOf("") }
    var recordQuery by remember { mutableStateOf("") }
    var product by remember { mutableStateOf<Product?>(null) }
    var quantity by remember { mutableStateOf("1") }
    var amount by remember { mutableStateOf("0") }
    var reason by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var supplier by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var returnLines by remember { mutableStateOf(emptyList<JSONObject>()) }
    var chosenQuantities by remember { mutableStateOf(emptyMap<Int, String>()) }
    var restock by remember { mutableStateOf(true) }
    var orderLines by remember { mutableStateOf(emptyList<OrderFormLine>()) }
    var countLines by remember { mutableStateOf(emptyMap<String, Int>()) }
    var reviewEvents by remember { mutableStateOf(emptyList<JSONObject>()) }
    var acknowledgeReviews by remember { mutableStateOf(false) }
    var includedInCount by remember { mutableStateOf(false) }
    var revision by remember { mutableStateOf(emptyMap<Int, String>()) }
    var receipts by remember { mutableStateOf(emptyList<JSONObject>()) }
    var result by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var stores by remember { mutableStateOf(emptyList<JSONObject>()) }
    var destination by remember { mutableStateOf("") }
    suspend fun input() =
        JSONObject()
            .put("storeId", repository.snapshot().getJSONObject("device").getString("store_id"))
    suspend fun load(kind: String) {
        val response =
            repository.network.request(
                "/v1/documents/$kind?storeId=${input().getString("storeId")}&q=${java.net.URLEncoder.encode(recordQuery, "UTF-8")}"
            )
        val entries = response.getJSONArray("items")
        records = (0 until entries.length()).map { entries.getJSONObject(it) }
    }
    fun action(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = ""
        scope.launch {
            try {
                block()
            } catch (failure: Exception) {
                error = "${failure.message}。権限・入力・同期を確認してください。"
            } finally {
                busy = false
            }
        }
    }
    fun indexedLines(): JSONArray {
        val entries =
            chosenQuantities.mapNotNull { (index, count) ->
                val value = count.toIntOrNull() ?: error("数量を整数で入力してください")
                if (value > 0)
                    JSONObject().put("index", index).put("quantity", value).put("restock", restock)
                else null
            }
        require(entries.isNotEmpty()) { "処理する明細数量を入力してください" }
        return JSONArray(entries)
    }
    LaunchedEffect(Unit) {
        withContext(Dispatchers.Main.immediate) {
            products = repository.dao.search("")
            val entries = repository.snapshot().getJSONObject("settings").getJSONArray("stores")
            stores = (0 until entries.length()).map { entries.getJSONObject(it) }
        }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp)) {
        Text("店舗業務（オンライン / Cognito権限をPIN担当者に縮小）", style = MaterialTheme.typography.titleLarge)
        Row {
            listOf("返品", "発注", "在庫", "棚卸", "移動", "同期確認").forEach { label ->
                TextButton(
                    onClick = {
                        task = label
                        selected = null
                        records = emptyList()
                        chosenQuantities = emptyMap()
                        result = ""
                    }
                ) {
                    Text(label)
                }
            }
            Button(
                enabled = !busy,
                onClick = { action { result = repository.retryCommand().toString(2) } },
            ) {
                Text("未完了操作を同じIDで再送")
            }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedTextField(reason, { reason = it }, label = { Text("返品・調整・取消理由") })
        if (task in listOf("発注", "在庫", "棚卸", "移動")) {
            OutlinedTextField(
                query,
                {
                    query = it
                    product = null
                },
                label = { Text("業務商品検索 / SKU / JAN") },
            )
            LaunchedEffect(query) {
                withContext(Dispatchers.Main.immediate) { products = repository.dao.search(query) }
            }
            Column(Modifier.fillMaxWidth()) {
                products.forEach { entry ->
                    key(entry.id) {
                        TextButton(
                            onClick = {
                                product = entry
                                amount = entry.cost
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (product?.id == entry.id) "● ${entry.name}" else entry.name)
                        }
                    }
                }
            }
            Row {
                OutlinedTextField(
                    quantity,
                    { quantity = it },
                    label = { Text("数量 / 実査数量") },
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    amount,
                    { amount = it },
                    label = { Text("仕入単価（円）") },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (task == "返品" || task == "発注" || task == "移動" || task == "棚卸") {
            OutlinedTextField(
                recordQuery,
                { recordQuery = it },
                label = { Text("取引番号・仕入先・商品名で検索") },
            )
            Button(
                enabled = !busy,
                onClick = {
                    action {
                        load(
                            if (task == "返品") "sale"
                            else if (task == "移動") "transfer"
                            else if (task == "棚卸") "stocktake" else "purchase-order"
                        )
                    }
                },
            ) {
                Text("記録を検索")
            }
            records.forEach { record ->
                TextButton(
                    onClick = {
                        action {
                            selected = record
                            chosenQuantities = emptyMap()
                            if (task == "返品" && record.getString("kind") == "sale") {
                                val response =
                                    repository.network.request(
                                        "/v1/sales/${record.getString("id")}/returnable"
                                    )
                                val entries = response.getJSONArray("lines")
                                returnLines =
                                    (0 until entries.length()).map { entries.getJSONObject(it) }
                            }
                        }
                    }
                ) {
                    Text(
                        "${record.getString("id").take(8)} / ${record.getString("status")} / ${record.getJSONObject("body").optString("supplier", record.getJSONObject("body").optString("total"))}"
                    )
                }
            }
        }
        when (task) {
            "返品" -> {
                val sale = selected
                if (sale?.getString("kind") == "sale") {
                    returnLines.forEach { line ->
                        val index = line.getInt("index")
                        Row {
                            Text(
                                "${line.getString("name")} / 返品可能 ${line.getInt("remaining")}",
                                Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                chosenQuantities[index] ?: "0",
                                { chosenQuantities = chosenQuantities + (index to it) },
                                label = { Text("返品数量 ${index + 1}") },
                            )
                        }
                    }
                    Row {
                        Checkbox(restock, { restock = it })
                        Text("再入庫可能な商品として返品")
                    }
                    Button(
                        enabled = !busy,
                        onClick = {
                            action {
                                selected =
                                    repository.command(
                                        "/v1/refunds",
                                        input()
                                            .put("saleId", sale.getString("id"))
                                            .put("reason", reason)
                                            .put("lines", indexedLines()),
                                    )
                                result = selected.toString()
                            }
                        },
                    ) {
                        Text("選択明細を返品予約")
                    }
                }
                Button(enabled = !busy, onClick = { action { load("refund") } }) {
                    Text("未完了返品を取得")
                }
                if (sale?.getString("kind") == "refund" && sale.getString("status") == "pending") {
                    OutlinedTextField(reference, { reference = it }, label = { Text("外部返金確認番号") })
                    Row {
                        listOf("unknown", "success", "failed").forEach { state ->
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action {
                                        val payload =
                                            input().put("result", state).put("reference", reference)
                                        repository.dao
                                            .metadata("shiftId")
                                            ?.takeIf { it.isNotBlank() }
                                            ?.let { payload.put("shiftId", it) }
                                        selected =
                                            repository.command(
                                                "/v1/refunds/${sale.getString("id")}/confirm",
                                                payload,
                                            )
                                        result = selected.toString()
                                    }
                                },
                            ) {
                                Text(
                                    if (state == "success") "返金成功を確定"
                                    else if (state == "unknown") "確認待ちを維持" else "返金失敗を記録"
                                )
                            }
                        }
                    }
                }
            }
            "発注" -> {
                Row {
                    OutlinedTextField(
                        supplier,
                        { supplier = it },
                        label = { Text("仕入先") },
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        date,
                        { date = it },
                        label = { Text("入荷予定日 YYYY-MM-DD") },
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        enabled = product != null && !busy,
                        onClick = {
                            orderLines = orderLines + OrderFormLine(product!!, quantity, amount)
                        },
                    ) {
                        Text("発注明細を追加")
                    }
                }
                orderLines.forEachIndexed { index, line ->
                    Row {
                        Text("${line.product.name} ×${line.quantity} / ${line.cost}円")
                        TextButton(
                            onClick = {
                                orderLines =
                                    orderLines.filterIndexed { position, _ -> position != index }
                            }
                        ) {
                            Text("明細削除")
                        }
                    }
                }
                Button(
                    enabled = !busy && orderLines.isNotEmpty(),
                    onClick = {
                        action {
                            selected =
                                repository.command(
                                    "/v1/purchase-orders",
                                    input()
                                        .put("supplier", supplier)
                                        .put("expectedAt", date)
                                        .put(
                                            "lines",
                                            JSONArray(
                                                orderLines.map {
                                                    JSONObject()
                                                        .put("productId", it.product.id)
                                                        .put("quantity", it.quantity.toInt())
                                                        .put("unitCost", it.cost)
                                                }
                                            ),
                                        ),
                                )
                            orderLines = emptyList()
                            load("purchase-order")
                        }
                    },
                ) {
                    Text("複数明細で下書き作成")
                }
                val order = selected
                if (order != null) {
                    val lines = order.getJSONObject("body").getJSONArray("lines")
                    for (index in 0 until lines.length()) {
                        val line = lines.getJSONObject(index)
                        Row {
                            Text(
                                "${line.optString("name", line.getString("productId"))} 入荷済${line.getInt("received")} / 発注${line.getInt("quantity")}",
                                Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                chosenQuantities[index] ?: "0",
                                { chosenQuantities = chosenQuantities + (index to it) },
                                label = { Text("入荷数量 ${index + 1}") },
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                revision[index] ?: line.getInt("quantity").toString(),
                                { revision = revision + (index to it) },
                                label = { Text("改訂発注数量 ${index + 1}") },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                    Row {
                        if (order.getString("status") == "draft")
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action {
                                        selected =
                                            repository.command(
                                                "/v1/purchase-orders/${order.getString("id")}/approve",
                                                input(),
                                            )
                                    }
                                },
                            ) {
                                Text("発注承認")
                            }
                        if (order.getString("status") == "approved")
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action {
                                        selected =
                                            repository.command(
                                                "/v1/purchase-orders/${order.getString("id")}/issue",
                                                input(),
                                            )
                                    }
                                },
                            ) {
                                Text("発注発行")
                            }
                        if (order.getString("status") in listOf("issued", "partial"))
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action {
                                        result =
                                            repository
                                                .command(
                                                    "/v1/purchase-orders/${order.getString("id")}/receipts",
                                                    input().put("lines", indexedLines()),
                                                )
                                                .toString()
                                        load("purchase-order")
                                        selected =
                                            records.first {
                                                it.getString("id") == order.getString("id")
                                            }
                                        chosenQuantities = emptyMap()
                                    }
                                },
                            ) {
                                Text("選択明細を分納入荷")
                            }
                    }
                    if (order.getString("status") in listOf("issued", "partial", "received")) {
                        Button(
                            enabled = !busy,
                            onClick = {
                                action {
                                    selected =
                                        repository.command(
                                            "/v1/purchase-orders/${order.getString("id")}/revise",
                                            input()
                                                .put("reason", reason)
                                                .put(
                                                    "quantities",
                                                    JSONArray(
                                                        (0 until lines.length()).map {
                                                            (revision[it]
                                                                    ?: lines
                                                                        .getJSONObject(it)
                                                                        .getInt("quantity")
                                                                        .toString())
                                                                .toInt()
                                                        }
                                                    ),
                                                ),
                                        )
                                }
                            },
                        ) {
                            Text("履歴付き数量改訂")
                        }
                        Button(
                            enabled = !busy,
                            onClick = {
                                action {
                                    val entries =
                                        repository.network
                                            .request(
                                                "/v1/documents/receipt?storeId=${input().getString("storeId")}"
                                            )
                                            .getJSONArray("items")
                                    receipts =
                                        (0 until entries.length())
                                            .map { entries.getJSONObject(it) }
                                            .filter {
                                                it.getJSONObject("body").getString("orderId") ==
                                                    order.getString("id")
                                            }
                                }
                            },
                        ) {
                            Text("入荷記録を取得")
                        }
                        receipts
                            .filter { it.getString("status") == "confirmed" }
                            .forEach { receipt ->
                                Button(
                                    enabled = !busy,
                                    onClick = {
                                        action {
                                            result =
                                                repository
                                                    .command(
                                                        "/v1/receipts/${receipt.getString("id")}/cancel",
                                                        input().put("reason", reason),
                                                    )
                                                    .toString()
                                            receipts = emptyList()
                                            load("purchase-order")
                                        }
                                    },
                                ) {
                                    Text("誤入荷取消 ${receipt.getString("id").take(8)}")
                                }
                            }
                    }
                }
            }
            "在庫" -> {
                Button(
                    enabled = product != null && !busy,
                    onClick = {
                        action {
                            result =
                                repository
                                    .command(
                                        "/v1/inventory/adjustments",
                                        input()
                                            .put("productId", product!!.id)
                                            .put("quantity", quantity.toInt())
                                            .put("reason", reason),
                                    )
                                    .toString()
                        }
                    },
                ) {
                    Text("増減台帳へ調整・廃棄を追加")
                }
                Button(
                    enabled = !busy,
                    onClick = {
                        action {
                            result =
                                repository.network
                                    .request(
                                        "/v1/inventory?storeId=${input().getString("storeId")}"
                                    )
                                    .toString(2)
                        }
                    },
                ) {
                    Text("在庫を取得")
                }
            }
            "同期確認" -> {
                Button(
                    enabled = !busy,
                    onClick = {
                        action {
                            val entries =
                                repository.network
                                    .request(
                                        "/v1/sync/reviews?storeId=${input().getString("storeId")}"
                                    )
                                    .getJSONArray("items")
                            reviewEvents =
                                (0 until entries.length()).map { entries.getJSONObject(it) }
                        }
                    },
                ) {
                    Text("隔離イベントを取得")
                }
                Row {
                    Checkbox(includedInCount, { includedInCount = it })
                    Text("遅延売上の在庫減少を実査に含めた")
                }
                reviewEvents.forEach { event ->
                    Text(
                        "${event.getString("id").take(8)} / ${event.getJSONObject("result").optString("code")}"
                    )
                    Button(
                        enabled = !busy,
                        onClick = {
                            action {
                                val payload = input().put("reason", reason)
                                if (
                                    event.getJSONObject("result").optString("code") in
                                        listOf("STOCKTAKE_RECONCILE", "STOCKTAKE_ACTIVE")
                                )
                                    payload.put("inventoryIncludedInCount", includedInCount)
                                result =
                                    repository
                                        .command(
                                            "/v1/sync/reviews/${event.getString("id")}/retry",
                                            payload,
                                        )
                                        .toString()
                                repository.sync()
                            }
                        },
                    ) {
                        Text("原記録を管理者再検証")
                    }
                }
            }
            "棚卸" -> {
                Button(
                    enabled = !busy,
                    onClick = {
                        action {
                            repository.dao.metadata(Metadata("stopped", "true"))
                            repository.sync()
                            selected = repository.command("/v1/stocktakes", input())
                            repository.renewAuthentication()
                        }
                    },
                ) {
                    Text("販売停止・全端末同期確認・棚卸開始")
                }
                Button(
                    enabled = product != null && !busy,
                    onClick = { countLines = countLines + (product!!.id to quantity.toInt()) },
                ) {
                    Text("実査明細を追加")
                }
                countLines.forEach { (id, count) ->
                    Text("${products.find { it.id == id }?.name ?: id.take(8)} 実査 $count")
                }
                Button(
                    enabled = !busy,
                    onClick = {
                        action {
                            val entries =
                                repository.network
                                    .request(
                                        "/v1/sync/reviews?storeId=${input().getString("storeId")}"
                                    )
                                    .getJSONArray("items")
                            reviewEvents =
                                (0 until entries.length()).map { entries.getJSONObject(it) }
                        }
                    },
                ) {
                    Text("棚卸中の隔離記録を確認")
                }
                reviewEvents.forEach { Text(it.getString("id")) }
                Row {
                    Checkbox(acknowledgeReviews, { acknowledgeReviews = it })
                    Text("隔離原記録を全件照合した（承認理由必須）")
                }
                if (selected?.getString("kind") == "stocktake")
                    Button(
                        enabled = !busy && countLines.isNotEmpty(),
                        onClick = {
                            action {
                                result =
                                    repository
                                        .command(
                                            "/v1/stocktakes/${selected!!.getString("id")}/confirm",
                                            input()
                                                .put("reason", reason)
                                                .put(
                                                    "reviewEventIds",
                                                    JSONArray(
                                                        if (acknowledgeReviews)
                                                            reviewEvents.map { it.getString("id") }
                                                        else emptyList<String>()
                                                    ),
                                                )
                                                .put(
                                                    "counts",
                                                    JSONArray(
                                                        countLines.map {
                                                            JSONObject()
                                                                .put("productId", it.key)
                                                                .put("quantity", it.value)
                                                        }
                                                    ),
                                                ),
                                        )
                                        .toString()
                                repository.renewAuthentication()
                                countLines = emptyMap()
                            }
                        },
                    ) {
                        Text("棚卸全明細を確定")
                    }
            }
            "移動" -> {
                stores.forEach { store ->
                    TextButton(onClick = { destination = store.getString("id") }) {
                        Text(
                            if (destination == store.getString("id")) "● ${store.getString("name")}"
                            else store.getString("name")
                        )
                    }
                }
                Button(
                    enabled = product != null && destination.isNotBlank() && !busy,
                    onClick = {
                        action {
                            selected =
                                repository.command(
                                    "/v1/transfers",
                                    input()
                                        .put("toStoreId", destination)
                                        .put(
                                            "lines",
                                            JSONArray()
                                                .put(
                                                    JSONObject()
                                                        .put("productId", product!!.id)
                                                        .put("quantity", quantity.toInt())
                                                ),
                                        ),
                                )
                            result = selected.toString()
                        }
                    },
                ) {
                    Text("移動出庫")
                }
                if (selected?.getString("status") == "transit")
                    Button(
                        enabled = !busy,
                        onClick = {
                            action {
                                result =
                                    repository
                                        .command(
                                            "/v1/transfers/${selected!!.getString("id")}/receive",
                                            input(),
                                        )
                                        .toString()
                            }
                        },
                    ) {
                        Text("到着店舗で受入")
                    }
            }
        }
        if (result.isNotBlank()) Text(result)
    }
}
