package jp.regi.pos

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

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

@Composable
fun Pos(repository: Repository, callback: Uri? = null) {
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    var page by remember { mutableStateOf("販売") }
    var products by remember { mutableStateOf(emptyList<Product>()) }
    var cart by remember { mutableStateOf(emptyList<SaleLine>()) }
    var heldId by remember { mutableStateOf<String?>(null) }
    var history by remember { mutableStateOf(emptyList<Checkout>()) }
    var current by remember { mutableStateOf<Checkout?>(null) }
    var staff by remember { mutableStateOf(emptyList<JSONObject>()) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf(0) }
    var reviews by remember { mutableStateOf(emptyList<Event>()) }
    var administratorLoginRequired by remember {
        mutableStateOf(repository.network.oauth.requiresAdministratorLogin())
    }
    var query by remember { mutableStateOf("") }
    var base by remember {
        mutableStateOf(if (BuildConfig.DEBUG) "http://10.0.2.2:3000" else "https://")
    }
    var token by remember { mutableStateOf("") }
    var device by remember { mutableStateOf("40000000-0000-4000-8000-000000000001") }
    var pin by remember { mutableStateOf("") }
    var tendered by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var printer by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("cash") }
    var taxContext by remember { mutableStateOf("master") }
    var discount by remember { mutableStateOf("0") }
    var domain by remember {
        mutableStateOf(repository.network.oauth.configuration()?.optString("domain") ?: "")
    }
    var clientId by remember {
        mutableStateOf(repository.network.oauth.configuration()?.optString("clientId") ?: "")
    }
    var deviceName by remember { mutableStateOf("店舗POS") }
    var storeId by remember { mutableStateOf("") }
    var priceMode by remember { mutableStateOf("inclusive") }
    var buyerName by remember { mutableStateOf("") }
    var enrollmentStores by remember { mutableStateOf(emptyList<JSONObject>()) }
    val context = androidx.compose.ui.platform.LocalContext.current
    suspend fun refresh() {
        products = repository.dao.search(query)
        history = repository.dao.history()
        pending = repository.dao.pendingCount()
        reviews = repository.dao.reviews()
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
    LaunchedEffect(Unit) {
        withContext(Dispatchers.Main.immediate) {
            refresh()
            repository.enqueue()
        }
    }
    LaunchedEffect(repository) {
        while (true) {
            val required = repository.network.oauth.requiresAdministratorLogin()
            if (required != administratorLoginRequired) {
                administratorLoginRequired = required
                repository.dao.metadata(Metadata("administratorLoginRequired", required.toString()))
            }
            delay(1000)
        }
    }
    LaunchedEffect(callback) {
        if (callback != null)
            action {
                repository.network.oauth.callback(callback)
                if (repository.dao.metadata("bootstrap") != null) repository.renewAuthentication()
                val entries = repository.network.request("/v1/settings").getJSONArray("stores")
                enrollmentStores = (0 until entries.length()).map { entries.getJSONObject(it) }
                repository.enqueue()
            }
    }
    LaunchedEffect(history) {
        priceMode =
            try {
                repository
                    .snapshot()
                    .getJSONObject("settings")
                    .getJSONObject("tenant")
                    .getString("price_mode")
            } catch (_: Exception) {
                "inclusive"
            }
    }
    val total =
        try {
            Money.calculate(cart, discount, priceMode).total
        } catch (_: Exception) {
            "0"
        }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("REGI POS", style = MaterialTheme.typography.headlineMedium)
            listOf("販売", "履歴", "同期", "開局・締め", "店舗業務", "設定").forEach { label ->
                TextButton(onClick = { page = label }) { Text(label) }
            }
        }
        Text("未送信 $pending 件 / 要確認 ${reviews.size} 件 / オフライン上限72時間")
        if (administratorLoginRequired)
            Text("管理者の再ログインが必要", color = MaterialTheme.colorScheme.error)
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        when (page) {
            "店舗業務" -> Operations(repository)
            "設定" -> {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    OutlinedTextField(base, { base = it }, label = { Text("API URL（本番HTTPS）") })
                    if (BuildConfig.DEBUG)
                        OutlinedTextField(
                            token,
                            { token = it },
                            label = { Text("開発用手動token（本番では非表示）") },
                        )
                    OutlinedTextField(device, { device = it }, label = { Text("登録済み端末ID（初回のみ）") })
                    OutlinedTextField(
                        domain,
                        { domain = it },
                        label = { Text("Cognito Hosted UI URL") },
                    )
                    OutlinedTextField(
                        clientId,
                        { clientId = it },
                        label = { Text("Android専用 Cognito client ID（変更して再ログイン）") },
                    )
                    Button(
                        enabled = !busy,
                        onClick = {
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
                    ) {
                        Text("Cognito・MFAログイン / 更新")
                    }
                    enrollmentStores.forEach { entry ->
                        TextButton(onClick = { storeId = entry.getString("id") }) {
                            Text(
                                if (storeId == entry.getString("id")) "● ${entry.getString("name")}"
                                else entry.getString("name")
                            )
                        }
                    }
                    OutlinedTextField(deviceName, { deviceName = it }, label = { Text("端末表示名") })
                    Button(
                        enabled = !busy && storeId.isNotBlank(),
                        onClick = {
                            action {
                                val enrolled = repository.enroll(storeId, deviceName)
                                device = enrolled.getString("id")
                            }
                        },
                    ) {
                        Text("選択店舗へ管理者認証で端末登録")
                    }
                    Button(
                        enabled = !busy,
                        onClick = {
                            action {
                                repository.network.configure(
                                    base,
                                    token,
                                    BuildConfig.DEBUG && token.isBlank(),
                                    "local-cashier",
                                )
                                repository.bootstrap(device)
                            }
                        },
                    ) {
                        Text("接続・初回同期")
                    }
                    OutlinedTextField(
                        printer,
                        { printer = it },
                        label = { Text("Epson LAN IP（9100）") },
                    )
                    Button(
                        enabled = !busy,
                        onClick = {
                            action {
                                repository.logout()
                                staff = emptyList()
                            }
                        },
                    ) {
                        Text("ログアウト（会計・未送信記録は保持）")
                    }
                    Text("本番認証・署名配布・実機印刷は導入手順に従って検証してください。")
                }
            }
            "開局・締め" -> {
                OutlinedTextField(pin, { pin = it }, label = { Text("担当者PIN") })
                Row {
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
                OutlinedTextField(tendered, { tendered = it }, label = { Text("釣銭準備金 / 現金実査額") })
                Row {
                    Button(
                        enabled = !busy,
                        onClick = { action { repository.openShift(tendered, pin) } },
                    ) {
                        Text("開局")
                    }
                    Button(enabled = !busy, onClick = { action { repository.close(tendered) } }) {
                        Text("同期して暫定締め")
                    }
                }
                OutlinedTextField(reference, { reference = it }, label = { Text("現金入出金理由") })
                Row {
                    listOf("in", "out").forEach { direction ->
                        Button(
                            enabled = !busy,
                            onClick = {
                                action { repository.cashMovement(tendered, direction, reference) }
                            },
                        ) {
                            Text(if (direction == "in") "現金入金" else "現金出金")
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
                                "${checkout.id.take(8)} ${checkout.status} ${JSONObject(checkout.body).getString("total")}円",
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
                    LaunchedEffect(query) {
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
                                    enabled = current == null,
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
                                                )
                                    },
                                ) {
                                    Text("${product.name}　${product.price}円")
                                }
                            }
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        if (current == null) {
                            Text("カート", style = MaterialTheme.typography.titleLarge)
                            LazyColumn(Modifier.weight(1f)) {
                                items(cart.indices.toList()) { index ->
                                    val line = cart[index]
                                    Row {
                                        Text(line.name, Modifier.weight(1f))
                                        OutlinedTextField(
                                            line.quantity.toString(),
                                            { value ->
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
                                            label = { Text("販売数量 ${index + 1}") },
                                            modifier = Modifier.weight(1f),
                                        )
                                        OutlinedTextField(
                                            line.discount,
                                            { value ->
                                                cart =
                                                    cart.mapIndexed { position, item ->
                                                        if (position == index)
                                                            item.copy(discount = value)
                                                        else item
                                                    }
                                            },
                                            label = { Text("商品値引き ${index + 1}") },
                                            modifier = Modifier.weight(1f),
                                        )
                                        TextButton(
                                            onClick = {
                                                cart =
                                                    cart.filterIndexed { position, _ ->
                                                        position != index
                                                    }
                                            }
                                        ) {
                                            Text("削除")
                                        }
                                    }
                                }
                            }
                            Row {
                                listOf(
                                        "master" to "商品設定",
                                        "dine-in" to "店内飲食",
                                        "takeaway" to "持ち帰り",
                                    )
                                    .forEach { (value, label) ->
                                        TextButton(
                                            onClick = {
                                                taxContext = value
                                                cart = cart.map { it.copy(taxContext = value) }
                                            }
                                        ) {
                                            Text(if (taxContext == value) "● $label" else label)
                                        }
                                    }
                            }
                            OutlinedTextField(
                                discount,
                                { discount = it },
                                label = { Text("会計値引き（円）") },
                            )
                            OutlinedTextField(
                                buyerName,
                                { buyerName = it },
                                label = { Text("帳票宛名（設定で必須の場合あり）") },
                            )
                            Row {
                                listOf("cash", "card", "qr").forEach { value ->
                                    TextButton(onClick = { method = value }) {
                                        Text(if (value == method) "● $value" else value)
                                    }
                                }
                            }
                            Text("合計 $total 円", style = MaterialTheme.typography.headlineMedium)
                            Button(
                                enabled = !busy && cart.isNotEmpty(),
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    action {
                                        current =
                                            repository.begin(
                                                cart,
                                                discount,
                                                method,
                                                heldId,
                                                buyerName = buyerName,
                                            )
                                        heldId = null
                                    }
                                },
                            ) {
                                Text("保存して支払い開始")
                            }
                            TextButton(
                                enabled = !busy && cart.isNotEmpty(),
                                onClick = {
                                    action {
                                        repository.begin(
                                            cart,
                                            discount,
                                            method,
                                            heldId,
                                            "draft",
                                            buyerName,
                                        )
                                        heldId = null
                                        cart = emptyList()
                                    }
                                },
                            ) {
                                Text("保留して保存")
                            }
                        } else {
                            val checkout = current!!
                            val body = JSONObject(checkout.body)
                            Text(
                                "${checkout.status} / ${body.getString("total")}円",
                                style = MaterialTheme.typography.headlineSmall,
                            )
                            OutlinedTextField(
                                tendered,
                                { tendered = it },
                                label = { Text("現金預り額") },
                            )
                            OutlinedTextField(
                                reference,
                                { reference = it },
                                label = { Text("外部端末の成功確認番号") },
                            )
                            if (checkout.status != "confirmed") {
                                Button(
                                    enabled = !busy,
                                    onClick = {
                                        action {
                                            current =
                                                repository.confirm(checkout.id, tendered, reference)
                                            repository.enqueue()
                                            cart = emptyList()
                                        }
                                    },
                                ) {
                                    Text("支払成功確認・売上確定")
                                }
                                if (
                                    body.getString("method") == "cash" &&
                                        checkout.status == "checking"
                                )
                                    TextButton(
                                        enabled = !busy,
                                        onClick = {
                                            action {
                                                repository.cancel(checkout.id)
                                                current = null
                                                cart = emptyList()
                                            }
                                        },
                                    ) {
                                        Text("現金会計を中止")
                                    }
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        action {
                                            repository.unknown(checkout.id)
                                            current = repository.dao.checkoutById(checkout.id)
                                        }
                                    },
                                ) {
                                    Text("結果不明 / 確認待ち")
                                }
                            } else {
                                Button(
                                    enabled = !busy,
                                    onClick = { action { Printer.print(printer, checkout) } },
                                ) {
                                    Text("印刷（保存済み会計）")
                                }
                                TextButton(
                                    onClick = {
                                        current = null
                                        tendered = ""
                                        reference = ""
                                    }
                                ) {
                                    Text("次の販売")
                                }
                            }
                        }
                    }
                }
        }
    }
}
