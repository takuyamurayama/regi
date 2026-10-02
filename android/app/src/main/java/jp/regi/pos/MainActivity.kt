package jp.regi.pos

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private val cartSaver =
    Saver<List<SaleLine>, String>(
        save = { lines ->
            JSONArray(
                    lines.map { line ->
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
                    }
                )
                .toString()
        },
        restore = { saved ->
            val entries = JSONArray(saved)
            (0 until entries.length()).map { index ->
                val line = entries.getJSONObject(index)
                SaleLine(
                    line.getString("productId"),
                    line.getString("name"),
                    line.getInt("quantity"),
                    line.getString("price"),
                    line.getString("discount"),
                    line.getInt("rateBps"),
                    line.getString("cost"),
                    line.getBoolean("stockManaged"),
                    line.optString("taxContext", "master"),
                )
            }
        },
    )
private val quantitySaver =
    Saver<Map<Int, String>, String>(
        save = { values -> JSONObject(values.mapKeys { it.key.toString() }).toString() },
        restore = { saved ->
            val values = JSONObject(saved)
            values.keys().asSequence().associate { it.toInt() to values.getString(it) }
        },
    )
private val checkoutSaver =
    Saver<Checkout?, String>(
        save = { record ->
            record?.let {
                JSONObject()
                    .put("id", it.id)
                    .put("status", it.status)
                    .put("body", it.body)
                    .put("createdAt", it.createdAt)
                    .toString()
            }
        },
        restore = { saved ->
            val value = JSONObject(saved)
            Checkout(
                value.getString("id"),
                value.getString("status"),
                value.getString("body"),
                value.getString("createdAt"),
            )
        },
    )

class MainActivity : ComponentActivity() {
    private var callback by mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        callback = intent?.data
        setContent { MaterialTheme { Pos(Repository(this), callback) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        callback = intent.data
    }
}

/** UI state always resumes on Main after asynchronous Room reads, including test frame clocks. */
@Composable
private fun MainThreadEffect(vararg keys: Any?, block: suspend () -> Unit) {
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    LaunchedEffect(*keys) {
        val task = scope.launch { block() }
        try {
            task.join()
        } finally {
            task.cancel()
        }
    }
}

@Composable
fun Pos(repository: Repository, callback: Uri? = null) {
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    var page by rememberSaveable { mutableStateOf("販売") }
    var products by remember { mutableStateOf(emptyList<Product>()) }
    var cart by rememberSaveable(stateSaver = cartSaver) { mutableStateOf(emptyList<SaleLine>()) }
    var quantities by
        rememberSaveable(stateSaver = quantitySaver) { mutableStateOf(emptyMap<Int, String>()) }
    var heldId by rememberSaveable { mutableStateOf<String?>(null) }
    var history by remember { mutableStateOf(emptyList<Checkout>()) }
    var current by rememberSaveable(stateSaver = checkoutSaver) { mutableStateOf<Checkout?>(null) }
    var staff by remember { mutableStateOf(emptyList<JSONObject>()) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var initialLoading by remember { mutableStateOf(true) }
    var pending by remember { mutableStateOf(0) }
    var reviews by remember { mutableStateOf(emptyList<Event>()) }
    var administratorLoginRequired by remember {
        mutableStateOf(repository.network.oauth.requiresAdministratorLogin())
    }
    var query by rememberSaveable { mutableStateOf("") }
    var base by remember {
        mutableStateOf(
            repository.network.configuredBaseUrl()
                ?: if (BuildConfig.DEBUG) "http://10.0.2.2:3000" else "https://"
        )
    }
    var token by remember { mutableStateOf("") }
    var device by remember { mutableStateOf("40000000-0000-4000-8000-000000000001") }
    var pin by remember { mutableStateOf("") }
    var tendered by rememberSaveable { mutableStateOf("") }
    var reference by rememberSaveable { mutableStateOf("") }
    var shiftAmount by rememberSaveable { mutableStateOf("0") }
    var cashReason by rememberSaveable { mutableStateOf("") }
    var shiftId by remember { mutableStateOf("") }
    var opening by remember { mutableStateOf("0") }
    var printer by remember { mutableStateOf("") }
    var method by rememberSaveable { mutableStateOf("cash") }
    var taxContext by rememberSaveable { mutableStateOf("master") }
    var discount by rememberSaveable { mutableStateOf("0") }
    var domain by remember {
        mutableStateOf(repository.network.oauth.configuration()?.optString("domain") ?: "")
    }
    var clientId by remember {
        mutableStateOf(repository.network.oauth.configuration()?.optString("clientId") ?: "")
    }
    var deviceName by remember { mutableStateOf("店舗POS") }
    var storeId by remember { mutableStateOf("") }
    var buyerName by rememberSaveable { mutableStateOf("") }
    var preview by remember { mutableStateOf<SalePreview?>(null) }
    var quotedCart by remember { mutableStateOf(emptyList<SaleLine>()) }
    var quotedDiscount by remember { mutableStateOf("") }
    var previewError by remember { mutableStateOf("") }
    var buyerRequired by remember { mutableStateOf(false) }
    var enrollmentStores by remember { mutableStateOf(emptyList<JSONObject>()) }
    val context = androidx.compose.ui.platform.LocalContext.current
    suspend fun refresh() {
        history = repository.dao.history()
        pending = repository.dao.pendingCount()
        reviews = repository.dao.reviews()
        shiftId = repository.dao.metadata("shiftId") ?: ""
        opening = repository.dao.metadata("opening") ?: "0"
        administratorLoginRequired = repository.network.oauth.requiresAdministratorLogin()
        repository.dao.metadata(
            Metadata("administratorLoginRequired", administratorLoginRequired.toString())
        )
        staff =
            try {
                repository.staff()
            } catch (_: Exception) {
                emptyList()
            }
        if (current == null) current = repository.dao.unfinished().firstOrNull()
        else current = repository.dao.checkoutById(current!!.id)
        buyerRequired =
            runCatching {
                    repository
                        .snapshot()
                        .getJSONObject("settings")
                        .getJSONObject("receipt")
                        .optBoolean("buyerRequired")
                }
                .getOrDefault(false)
        products = repository.dao.search(query)
        repository.dao.metadata("bootstrap")?.let { saved ->
            device = JSONObject(saved).getJSONObject("device").getString("id")
        }
        initialLoading = false
    }
    fun action(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = ""
        scope.launch {
            try {
                block()
                refresh()
            } catch (failure: Exception) {
                error = "${failure.message}。入力・同期・端末結果を確認してください。"
            } finally {
                pending = repository.dao.pendingCount()
                reviews = repository.dao.reviews()
                administratorLoginRequired = repository.network.oauth.requiresAdministratorLogin()
                repository.dao.metadata(
                    Metadata("administratorLoginRequired", administratorLoginRequired.toString())
                )
                busy = false
            }
        }
    }
    MainThreadEffect(Unit) {
        withContext(Dispatchers.Main.immediate) {
            refresh()
            repository.enqueue()
        }
    }
    MainThreadEffect(repository) {
        while (true) {
            val required = repository.network.oauth.requiresAdministratorLogin()
            if (required != administratorLoginRequired) {
                administratorLoginRequired = required
                repository.dao.metadata(Metadata("administratorLoginRequired", required.toString()))
            }
            delay(1000)
        }
    }
    MainThreadEffect(callback) {
        if (callback != null)
            action {
                repository.network.oauth.callback(callback)
                if (repository.dao.metadata("bootstrap") != null) repository.renewAuthentication()
                val entries = repository.network.request("/v1/settings").getJSONArray("stores")
                enrollmentStores = (0 until entries.length()).map { entries.getJSONObject(it) }
                repository.enqueue()
            }
    }
    val invalidQuantities = quantities.filter { (_, value) -> value.toIntOrNull() !in 1..10000 }
    val validBuyer = buyerName.length <= 200 && (!buyerRequired || buyerName.isNotBlank())
    MainThreadEffect(cart, discount, quantities, history) {
        preview = null
        previewError = ""
        if (cart.isNotEmpty()) {
            val requestedCart = cart
            val requestedDiscount = discount
            while (true) {
                try {
                    require(invalidQuantities.isEmpty()) { "数量は1〜10000の整数で入力してください" }
                    preview = repository.preview(requestedCart, requestedDiscount)
                    quotedCart = requestedCart
                    quotedDiscount = requestedDiscount
                    previewError = ""
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    preview = null
                    previewError =
                        failure.message?.takeIf { it.isNotBlank() } ?: "数量・値引きは範囲内の整数で入力してください"
                }
                delay(1000)
            }
        }
    }
    val visiblePreview =
        preview.takeIf {
            quotedCart == cart && quotedDiscount == discount && invalidQuantities.isEmpty()
        }
    val canSave =
        !initialLoading &&
            cart.isNotEmpty() &&
            visiblePreview != null &&
            invalidQuantities.isEmpty() &&
            validBuyer
    fun clearCart() {
        cart = emptyList()
        quantities = emptyMap()
        heldId = null
        buyerName = ""
        discount = "0"
        method = "cash"
        taxContext = "master"
        tendered = ""
        reference = ""
    }
    suspend fun beginCheckout(status: String): Checkout? {
        val inputCart = cart
        val inputQuantities = quantities
        val inputDiscount = discount
        val inputMethod = method
        val inputBuyer = buyerName
        val inputHeld = heldId
        val latest = repository.preview(inputCart, inputDiscount)
        if (
            inputCart != cart ||
                inputQuantities != quantities ||
                quantities.values.any { it.toIntOrNull() !in 1..10000 } ||
                inputDiscount != discount ||
                inputMethod != method ||
                inputBuyer != buyerName ||
                inputHeld != heldId
        ) {
            error = "入力が変更されました。内容を確認してもう一度支払い開始を選んでください。"
            return null
        }
        if (latest != visiblePreview) {
            preview = latest
            error = "価格・税率が更新されました。最新の合計を確認してもう一度支払い開始を選んでください。"
            return null
        }
        return repository.begin(
            inputCart,
            inputDiscount,
            inputMethod,
            inputHeld,
            status,
            inputBuyer,
            expectedPreview = latest,
        )
    }
    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 12.dp, vertical = 4.dp)) {
        PosHeader(pending, reviews.size, administratorLoginRequired, error) { page = it }
        if (busy || initialLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        when (page) {
            "店舗業務" -> Operations(repository)
            "設定" -> {
                ConnectionSettings(
                    modifier = Modifier.weight(1f),
                    form =
                        ConnectionFormState(
                            base,
                            token,
                            device,
                            domain,
                            clientId,
                            deviceName,
                            storeId,
                            printer,
                            enrollmentStores,
                            busy,
                        ),
                    actions =
                        ConnectionActions(
                            onBase = { base = it },
                            onToken = { token = it },
                            onDevice = { device = it },
                            onDomain = { domain = it },
                            onClientId = { clientId = it },
                            onDeviceName = { deviceName = it },
                            onStore = { storeId = it },
                            onPrinter = { printer = it },
                            onLogin = {
                                action {
                                    repository.network.configure(base, "", false, "")
                                    repository.network.oauth.configure(domain, clientId)
                                    context.startActivity(
                                        Intent(
                                            Intent.ACTION_VIEW,
                                            repository.network.oauth.authorizationUrl(),
                                        )
                                    )
                                }
                            },
                            onEnroll = {
                                action {
                                    device = repository.enroll(storeId, deviceName).getString("id")
                                }
                            },
                            onConnect = {
                                action {
                                    repository.network.configureConnection(
                                        base,
                                        token,
                                        BuildConfig.DEBUG && token.isBlank(),
                                    )
                                    repository.bootstrap(device)
                                }
                            },
                            onLogout = {
                                action {
                                    repository.logout()
                                    staff = emptyList()
                                }
                            },
                        ),
                )
            }
            "開局・締め" -> {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    Text(
                        if (shiftId.isBlank()) "未開局です。担当者PINと釣銭準備金を確認してください。"
                        else "開局 ${shiftId.take(8)} / 釣銭準備金 $opening 円"
                    )
                    OutlinedTextField(pin, { pin = it }, label = { Text("担当者PIN") })
                    Row(Modifier.horizontalScroll(rememberScrollState())) {
                        staff.forEach { entry ->
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action { repository.authenticate(entry.getString("id"), pin) }
                                },
                            ) {
                                Text(entry.getString("name"))
                            }
                        }
                    }
                    OutlinedTextField(
                        shiftAmount,
                        { shiftAmount = it },
                        label = { Text("釣銭準備金 / 現金実査額") },
                    )
                    Row {
                        Button(
                            enabled = !busy,
                            onClick = { action { repository.openShift(shiftAmount, pin) } },
                        ) {
                            Text("開局")
                        }
                        Button(
                            enabled = !busy,
                            onClick = { action { repository.close(shiftAmount) } },
                        ) {
                            Text("暫定締めを保存")
                        }
                    }
                    Text("締めは端末に保存し、同期で管理側へ送信します。確認待ちの会計は先に解消してください。")
                    OutlinedTextField(cashReason, { cashReason = it }, label = { Text("現金入出金理由") })
                    Row {
                        listOf("in", "out").forEach { direction ->
                            Button(
                                enabled = !busy,
                                onClick = {
                                    action {
                                        repository.cashMovement(shiftAmount, direction, cashReason)
                                    }
                                },
                            ) {
                                Text(if (direction == "in") "現金入金" else "現金出金")
                            }
                        }
                    }
                }
            }
            "同期" -> {
                Button(enabled = !busy, onClick = { action { repository.sync() } }) {
                    Text("再送・差分取得")
                }
                Text("受領応答までは送信待ちを保持。要確認の元記録は削除しません。")
                LazyColumn(Modifier.weight(1f)) {
                    items(reviews, key = { it.id }) { event ->
                        Text(
                            "${event.id} / ${JSONObject(event.payload).optString("type")}\n${event.error ?: "管理者がサーバーの要確認一覧で確認してください"}",
                            Modifier.padding(vertical = 8.dp),
                        )
                    }
                }
            }
            "履歴" ->
                LazyColumn {
                    items(history) { checkout ->
                        Row(Modifier.fillMaxWidth().padding(8.dp)) {
                            Text(
                                "${checkout.id.take(8)} ${PosLabels.checkoutStatus(checkout.status)} ${JSONObject(checkout.body).getString("total")}円",
                                Modifier.weight(1f),
                            )
                            TextButton(
                                onClick = {
                                    if (checkout.status == "draft") {
                                        val body = JSONObject(checkout.body)
                                        val lines = body.getJSONArray("lines")
                                        cart =
                                            (0 until lines.length()).map {
                                                val line = lines.getJSONObject(it)
                                                SaleLine(
                                                    line.getString("productId"),
                                                    line.getString("name"),
                                                    line.getInt("quantity"),
                                                    line.getString("price"),
                                                    line.getString("discount"),
                                                    line.getInt("rateBps"),
                                                    line.getString("cost"),
                                                    line.getBoolean("stockManaged"),
                                                    line.optString("taxContext", "master"),
                                                )
                                            }
                                        discount = body.getString("discount")
                                        method = body.getString("method")
                                        buyerName = body.optString("buyerName")
                                        taxContext =
                                            cart.map { it.taxContext }.distinct().singleOrNull()
                                                ?: "master"
                                        quantities = emptyMap()
                                        tendered = ""
                                        reference = ""
                                        heldId = checkout.id
                                        current = null
                                    } else current = checkout
                                    page = "販売"
                                }
                            ) {
                                Text("確認")
                            }
                            Button(
                                enabled = !busy && checkout.status == "confirmed",
                                onClick = { action { Printer.print(printer, checkout) } },
                            ) {
                                Text("再印刷")
                            }
                        }
                    }
                }
            else ->
                Row(Modifier.weight(1f)) {
                    MainThreadEffect(query, initialLoading) {
                        if (!initialLoading)
                            withContext(Dispatchers.Main.immediate) {
                                products = repository.dao.search(query)
                            }
                    }
                    Column(Modifier.weight(1.2f).padding(end = 16.dp)) {
                        OutlinedTextField(
                            query,
                            { query = it },
                            label = { Text("商品検索 / JANバーコード") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        LazyColumn {
                            items(products) { product ->
                                OutlinedButton(
                                    enabled = !initialLoading && !busy && current == null,
                                    modifier = Modifier.fillMaxWidth(),
                                    onClick = {
                                        cart =
                                            cart +
                                                SaleLine(
                                                    product.id,
                                                    product.name,
                                                    1,
                                                    product.price,
                                                    "0",
                                                    product.rateBps,
                                                    product.cost,
                                                    product.stockManaged,
                                                    taxContext,
                                                )
                                    },
                                ) {
                                    Text("${product.name}　${product.price}円")
                                }
                            }
                        }
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                        if (current == null) {
                            CartForm(
                                form =
                                    CartFormState(
                                        cart,
                                        quantities,
                                        visiblePreview,
                                        invalidQuantities.keys,
                                        discount,
                                        buyerName,
                                        taxContext,
                                        method,
                                        previewError,
                                        validBuyer,
                                        canSave,
                                        busy,
                                    ),
                                onQuantity = { index, value ->
                                    quantities = quantities + (index to value)
                                    value
                                        .toIntOrNull()
                                        ?.takeIf { it > 0 }
                                        ?.let { count ->
                                            cart =
                                                cart.mapIndexed { position, item ->
                                                    if (position == index)
                                                        item.copy(quantity = count)
                                                    else item
                                                }
                                        }
                                },
                                onLineDiscount = { index, value ->
                                    cart =
                                        cart.mapIndexed { position, item ->
                                            if (position == index) item.copy(discount = value)
                                            else item
                                        }
                                },
                                onRemove = { index ->
                                    cart = cart.filterIndexed { position, _ -> position != index }
                                    quantities =
                                        quantities
                                            .filterKeys { it != index }
                                            .mapKeys { (position, _) ->
                                                if (position > index) position - 1 else position
                                            }
                                },
                                onTaxContext = { value ->
                                    taxContext = value
                                    cart = cart.map { it.copy(taxContext = value) }
                                },
                                onDiscount = { discount = it },
                                onBuyer = { buyerName = it },
                                onMethod = { method = it },
                                onStart = {
                                    action {
                                        beginCheckout("checking")?.let { saved ->
                                            current = saved
                                            heldId = null
                                        }
                                    }
                                },
                                onHold = { action { beginCheckout("draft")?.let { clearCart() } } },
                            )
                        } else {
                            val checkout = current!!
                            SavedCheckoutPanel(
                                checkout = checkout,
                                busy = busy,
                                tendered = tendered,
                                reference = reference,
                                onTendered = { tendered = it },
                                onReference = { reference = it },
                                onConfirm = {
                                    action {
                                        current =
                                            repository.confirm(checkout.id, tendered, reference)
                                        repository.enqueue()
                                        clearCart()
                                    }
                                },
                                onCancel = {
                                    action {
                                        repository.cancel(checkout.id)
                                        current = null
                                        clearCart()
                                    }
                                },
                                onUnknown = {
                                    action {
                                        repository.unknown(checkout.id)
                                        current = repository.dao.checkoutById(checkout.id)
                                    }
                                },
                                onPrint = { action { Printer.print(printer, checkout) } },
                                onNext = {
                                    current = null
                                    clearCart()
                                },
                            )
                        }
                    }
                }
        }
    }
}

@Composable
private fun PosHeader(
    pending: Int,
    reviewCount: Int,
    administratorLoginRequired: Boolean,
    error: String,
    onPage: (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("REGI POS", style = MaterialTheme.typography.headlineMedium)
        listOf("販売", "履歴", "同期", "開局・締め", "店舗業務", "設定").forEach { label ->
            TextButton(onClick = { onPage(label) }) { Text(label) }
        }
    }
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Text(
            "未送信 $pending 件 / 要確認 $reviewCount 件 / オフライン上限72時間",
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            style = MaterialTheme.typography.labelMedium,
        )
        if (administratorLoginRequired)
            Text(
                "管理者の再ログインが必要",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelMedium,
            )
    }
    if (error.isNotBlank())
        Text(
            error,
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
        )
}

/** Keep each editable row in its own composable so the API 28 DEX verifier sees bounded methods. */
@Composable
private fun CartLineInputs(
    index: Int,
    line: SaleLine,
    resolved: SaleLine,
    quantity: String,
    invalidQuantity: Boolean,
    onQuantity: (String) -> Unit,
    onDiscount: (String) -> Unit,
    onRemove: () -> Unit,
) {
    Row {
        Text(
            "${resolved.name}\n単価 ${resolved.price} 円 / 税率 ${resolved.rateBps / 100.0}%",
            Modifier.weight(1f),
        )
        OutlinedTextField(
            quantity,
            onQuantity,
            label = { Text("販売数量 ${index + 1}") },
            isError = invalidQuantity,
            supportingText = if (invalidQuantity) ({ Text("1〜10000の整数") }) else null,
            modifier = Modifier.weight(1f),
        )
        OutlinedTextField(
            line.discount,
            onDiscount,
            label = { Text("商品値引き ${index + 1}") },
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onRemove) { Text("削除") }
    }
}

@Composable
private fun SavedCheckoutPanel(
    checkout: Checkout,
    busy: Boolean,
    tendered: String,
    reference: String,
    onTendered: (String) -> Unit,
    onReference: (String) -> Unit,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    onUnknown: () -> Unit,
    onPrint: () -> Unit,
    onNext: () -> Unit,
) {
    val body = JSONObject(checkout.body)
    Text(
        "${PosLabels.checkoutStatus(checkout.status)} / ${body.getString("total")}円",
        style = MaterialTheme.typography.headlineSmall,
    )
    if (checkout.status in listOf("checking", "unknown")) {
        if (body.getString("method") == "cash") {
            OutlinedTextField(tendered, onTendered, label = { Text("現金預り額") })
            val change =
                runCatching { Money.value(tendered) - Money.value(body.getString("total")) }
                    .getOrNull()
            Text(
                if (change == null) "預り額を入力してください"
                else if (change.signum() < 0) "現金預り額が不足しています" else "釣銭 $change 円"
            )
        } else {
            Text("外部端末の成功結果を確認してください。確認番号を記録してから売上を確定します。")
            OutlinedTextField(reference, onReference, label = { Text("外部端末の成功確認番号") })
        }
        Button(enabled = !busy, onClick = onConfirm) { Text("支払成功確認・売上確定") }
        if (body.getString("method") == "cash" && checkout.status == "checking")
            TextButton(enabled = !busy, onClick = onCancel) { Text("現金会計を中止") }
        TextButton(enabled = !busy, onClick = onUnknown) { Text("結果不明 / 確認待ち") }
    } else if (checkout.status == "confirmed") {
        if (body.getString("method") == "cash") {
            Text(
                "預り ${body.getString("tendered")} 円 / 釣銭 ${Money.value(body.getString("tendered")) - Money.value(body.getString("total"))} 円"
            )
        }
        Button(enabled = !busy, onClick = onPrint) { Text("印刷（保存済み会計）") }
        TextButton(onClick = onNext) { Text("次の販売") }
    } else {
        Text(if (checkout.status == "cancelled") "中止済みの会計です。売上には計上していません。" else "履歴の状態を確認してください。")
        TextButton(onClick = onNext) { Text("次の販売") }
    }
}

private data class CartFormState(
    val cart: List<SaleLine>,
    val quantities: Map<Int, String>,
    val preview: SalePreview?,
    val invalidQuantities: Set<Int>,
    val discount: String,
    val buyerName: String,
    val taxContext: String,
    val method: String,
    val previewError: String,
    val validBuyer: Boolean,
    val canSave: Boolean,
    val busy: Boolean,
)

@Composable
private fun CartForm(
    form: CartFormState,
    onQuantity: (Int, String) -> Unit,
    onLineDiscount: (Int, String) -> Unit,
    onRemove: (Int) -> Unit,
    onTaxContext: (String) -> Unit,
    onDiscount: (String) -> Unit,
    onBuyer: (String) -> Unit,
    onMethod: (String) -> Unit,
    onStart: () -> Unit,
    onHold: () -> Unit,
) {
    val cart = form.cart
    val quantities = form.quantities
    val visiblePreview = form.preview
    val total = visiblePreview?.calculation?.total
    val invalidQuantities = form.invalidQuantities
    val discount = form.discount
    val buyerName = form.buyerName
    val taxContext = form.taxContext
    val method = form.method
    val previewError = form.previewError
    val validBuyer = form.validBuyer
    val canSave = form.canSave
    val busy = form.busy
    Text("カート", style = MaterialTheme.typography.titleLarge)
    Column {
        cart.indices.forEach { index ->
            val line = cart[index]
            CartLineInputs(
                index = index,
                line = line,
                resolved = visiblePreview?.lines?.getOrNull(index) ?: line,
                quantity = quantities[index] ?: line.quantity.toString(),
                invalidQuantity = index in invalidQuantities,
                onQuantity = { value -> onQuantity(index, value) },
                onDiscount = { value -> onLineDiscount(index, value) },
                onRemove = { onRemove(index) },
            )
        }
    }
    Row {
        listOf("master" to "商品設定", "dine-in" to "店内飲食", "takeaway" to "持ち帰り").forEach {
            (value, label) ->
            TextButton(onClick = { onTaxContext(value) }) {
                Text(if (taxContext == value) "● $label" else label)
            }
        }
    }
    OutlinedTextField(
        discount,
        onDiscount,
        label = { Text("会計値引き（円）") },
        isError = previewError.isNotBlank(),
    )
    OutlinedTextField(
        buyerName,
        onBuyer,
        label = { Text("帳票宛名（設定で必須の場合あり）") },
        isError = !validBuyer,
        supportingText =
            if (!validBuyer)
                ({ Text(if (buyerName.length > 200) "帳票宛名は200文字以内で入力してください" else "帳票宛名を入力してください") })
            else null,
    )
    Row {
        listOf("cash", "card", "qr").forEach { value ->
            val label = PosLabels.paymentMethod(value)
            TextButton(onClick = { onMethod(value) }) {
                Text(if (value == method) "● $label" else label)
            }
        }
    }
    if (previewError.isNotBlank()) Text(previewError, color = MaterialTheme.colorScheme.error)
    Text(
        if (total == null) "合計 未確定" else "合計 $total 円",
        style = MaterialTheme.typography.headlineMedium,
    )
    visiblePreview?.calculation?.taxes?.forEach { tax ->
        Text("税率 ${tax.rateBps / 100.0}% / 税額 ${tax.tax} 円")
    }
    Button(enabled = !busy && canSave, modifier = Modifier.fillMaxWidth(), onClick = onStart) {
        Text("保存して支払い開始")
    }
    TextButton(enabled = !busy && canSave, onClick = onHold) { Text("保留して保存") }
}

private data class ConnectionFormState(
    val base: String,
    val token: String,
    val device: String,
    val domain: String,
    val clientId: String,
    val deviceName: String,
    val storeId: String,
    val printer: String,
    val enrollmentStores: List<JSONObject>,
    val busy: Boolean,
)

private data class ConnectionActions(
    val onBase: (String) -> Unit,
    val onToken: (String) -> Unit,
    val onDevice: (String) -> Unit,
    val onDomain: (String) -> Unit,
    val onClientId: (String) -> Unit,
    val onDeviceName: (String) -> Unit,
    val onStore: (String) -> Unit,
    val onPrinter: (String) -> Unit,
    val onLogin: () -> Unit,
    val onEnroll: () -> Unit,
    val onConnect: () -> Unit,
    val onLogout: () -> Unit,
)

@Composable
private fun ConnectionSettings(
    modifier: Modifier,
    form: ConnectionFormState,
    actions: ConnectionActions,
) {
    val base = form.base
    val token = form.token
    val device = form.device
    val domain = form.domain
    val clientId = form.clientId
    val deviceName = form.deviceName
    val storeId = form.storeId
    val printer = form.printer
    val enrollmentStores = form.enrollmentStores
    val busy = form.busy
    Column(modifier.verticalScroll(rememberScrollState())) {
        OutlinedTextField(base, actions.onBase, label = { Text("API URL（本番HTTPS）") })
        if (BuildConfig.DEBUG)
            OutlinedTextField(token, actions.onToken, label = { Text("開発用手動token（本番では非表示）") })
        OutlinedTextField(device, actions.onDevice, label = { Text("登録済み端末ID（初回のみ）") })
        OutlinedTextField(domain, actions.onDomain, label = { Text("Cognito Hosted UI URL") })
        OutlinedTextField(
            clientId,
            actions.onClientId,
            label = { Text("Android専用 Cognito client ID（変更して再ログイン）") },
        )
        Button(enabled = !busy, onClick = actions.onLogin) { Text("Cognito・MFAログイン / 更新") }
        enrollmentStores.forEach { entry ->
            TextButton(onClick = { actions.onStore(entry.getString("id")) }) {
                Text(
                    if (storeId == entry.getString("id")) "● ${entry.getString("name")}"
                    else entry.getString("name")
                )
            }
        }
        OutlinedTextField(deviceName, actions.onDeviceName, label = { Text("端末表示名") })
        Button(enabled = !busy && storeId.isNotBlank(), onClick = actions.onEnroll) {
            Text("選択店舗へ管理者認証で端末登録")
        }
        Button(enabled = !busy, onClick = actions.onConnect) { Text("接続・初回同期") }
        OutlinedTextField(printer, actions.onPrinter, label = { Text("Epson LAN IP（9100）") })
        Button(enabled = !busy, onClick = actions.onLogout) { Text("ログアウト（会計・未送信記録は保持）") }
        Text("本番認証・署名配布・実機印刷は導入手順に従って検証してください。")
    }
}
