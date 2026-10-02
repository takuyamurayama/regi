package jp.regi.pos

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.json.JSONArray
import java.net.ServerSocket
import java.util.concurrent.Executors

@RunWith(AndroidJUnit4::class)
class AcceptanceTest {
 @Test fun durablePaymentRecoveryAndIdempotentSync() = runBlocking {
  val context = InstrumentationRegistry.getInstrumentation().targetContext
  context.deleteDatabase("acceptance.db")
  fun open() = Room.databaseBuilder(context, PosDatabase::class.java, "acceptance.db").build()
  var database = open(); var repository = Repository(context, database)
  repository.network.configure("http://10.0.2.2:3000", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant"))
  repository.bootstrap(fixtureDevice("recovery"))
  repository.authenticate(fixtureStaff("cashier"), "1234")
  if (!repository.dao.metadata("shiftId").isNullOrBlank()) { repository.close("10000"); repository.sync() }
  repository.openShift("10000", "1234")
  repository.sync()
  repository.network.configure("http://127.0.0.1:9", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant"))
  val product = repository.dao.search("COFFEE").first()
  val checkout = repository.begin(listOf(SaleLine(product.id, product.name, 2, product.price, "0", product.rateBps, product.cost, product.stockManaged)), "1", "card")
  repository.unknown(checkout.id); database.close()
  database = open(); repository = Repository(context, database)
  val recovered = repository.dao.checkoutById(checkout.id)!!
  assertEquals("unknown", recovered.status)
  assertEquals("2159", JSONObject(recovered.body).getString("total"))
  val confirmationStarted = System.nanoTime()
  val confirmed = repository.confirm(checkout.id, "0", "TEST-EXTERNAL-SUCCESS")
  val confirmationMs = (System.nanoTime() - confirmationStarted) / 1000000
  println("REGI local confirmation_ms=$confirmationMs")
  assertTrue("Local confirmation must complete within one second, actual=$confirmationMs", confirmationMs < 1000)
  repository.confirm(checkout.id, "0", "TEST-EXTERNAL-SUCCESS")
  assertEquals(1, repository.dao.pendingCount())
  val payload = repository.dao.pending().first().payload
  repository.network.configure("http://10.0.2.2:3000", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant"))
  repository.sync(); assertEquals(0, repository.dao.pendingCount())
  val duplicate = repository.network.request("/v1/sync/events", JSONObject().put("events", JSONArray().put(JSONObject(payload))), JSONObject(repository.dao.metadata("lease-${JSONObject(payload).getString("leaseId")}")!!).getString("recoveryToken"))
  assertEquals("accepted", duplicate.getJSONArray("results").getJSONObject(0).getString("status"))
  assertEquals("confirmed", repository.dao.checkoutById(checkout.id)!!.status)
  val listener = ServerSocket(0); val executor = Executors.newSingleThreadExecutor()
  val received = executor.submit<Int> { listener.accept().use { socket -> socket.getInputStream().readBytes().size } }
  val printerCheckout = confirmed.copy(body = JSONObject(confirmed.body).put("method", "card").toString())
  Printer.print("127.0.0.1", printerCheckout, listener.localPort)
  assertTrue(received.get() > 50)
  listener.close(); executor.shutdownNow()
  repository.close("10000"); repository.sync(); database.close()
 }
 @Test fun heldCheckoutRepricesAndMigrationPreservesProduct() = runBlocking {
  val context = InstrumentationRegistry.getInstrumentation().targetContext
  context.deleteDatabase("hold.db")
  val database = Room.databaseBuilder(context, PosDatabase::class.java, "hold.db").build()
  val repository = Repository(context, database)
  repository.network.configure("http://10.0.2.2:3000", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant"))
  repository.bootstrap(fixtureDevice("hold"))
  repository.authenticate(fixtureStaff("cashier"), "1234")
  if (!repository.dao.metadata("shiftId").isNullOrBlank()) { repository.close("10000"); repository.sync() }
  repository.openShift("10000", "1234"); repository.sync()
  assertTrue(runCatching { repository.bootstrap(fixtureDevice("recovery")) }.isFailure)
  assertEquals(fixtureDevice("hold"), repository.snapshot().getJSONObject("device").getString("id"))
  assertTrue(runCatching { repository.enroll(fixtureStore("recovery"), "再登録は禁止") }.isFailure)
  val product = repository.dao.search("COFFEE").first()
  val held = repository.begin(listOf(SaleLine(product.id, product.name, 1, product.price, "0", product.rateBps, product.cost, true)), "0", "cash", status = "draft")
  assertEquals(0, repository.dao.unfinished().size)
  repository.dao.products(listOf(product.copy(price = "1200")))
  val resumed = repository.begin(listOf(SaleLine(product.id, product.name, 1, product.price, "0", product.rateBps, product.cost, true)), "0", "cash", held.id)
  assertEquals(held.id, resumed.id); assertEquals("1200", JSONObject(resumed.body).getString("total"))
  repository.cancel(resumed.id); repository.close("10000"); repository.sync(); database.close()
  context.deleteDatabase("migration.db")
  val helper = androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory().create(androidx.sqlite.db.SupportSQLiteOpenHelper.Configuration.builder(context).name("migration.db").callback(object: androidx.sqlite.db.SupportSQLiteOpenHelper.Callback(1) { override fun onCreate(database: androidx.sqlite.db.SupportSQLiteDatabase) {} ; override fun onUpgrade(database: androidx.sqlite.db.SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) {} }).build())
  val legacy = helper.writableDatabase
  legacy.execSQL("CREATE TABLE products (id TEXT NOT NULL PRIMARY KEY,sku TEXT NOT NULL,jan TEXT,name TEXT NOT NULL,price TEXT NOT NULL,cost TEXT NOT NULL,rateBps INTEGER NOT NULL,stockManaged INTEGER NOT NULL)")
  legacy.execSQL("INSERT INTO products VALUES ('kept','KEPT',NULL,'保持商品','100','40',1000,1)")
  PosDatabase.migration.migrate(legacy)
  legacy.query("SELECT taxCode,price FROM products WHERE id='kept'").use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals("100", cursor.getString(1)) }
  helper.close()
 }
 @Test fun accountSwitchClearsPosStaffButOfflineReconnectPreservesDownscope() {
  val context = InstrumentationRegistry.getInstrumentation().targetContext
  val network = Network(context)
  network.configure("http://10.0.2.2:3000", "", true, "first-account", fixture().getString("tenant"))
  network.selectStaff("selected-cashier")
  network.configure("http://127.0.0.1:9", "", true, "first-account", fixture().getString("tenant"))
  assertEquals("selected-cashier", context.getSharedPreferences("regi", android.content.Context.MODE_PRIVATE).getString("posStaff", null))
  network.configure("http://10.0.2.2:3000", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant"))
  assertNull(context.getSharedPreferences("regi", android.content.Context.MODE_PRIVATE).getString("posStaff", null))
 }
 @Test fun roomFiftyThousandSkuSearch() = runBlocking {
  val context = InstrumentationRegistry.getInstrumentation().targetContext
  context.deleteDatabase("sku-performance.db")
  val database = Room.databaseBuilder(context, PosDatabase::class.java, "sku-performance.db").build()
  database.dao().products(List(50000) { index -> Product("sku-$index", "SKU-$index", "JAN-$index", "商品$index", "100", "40", 1000, true) })
  val durations = List(60) { index -> val start = System.nanoTime(); val found = database.dao().search(listOf("JAN-49999", "商品49999", "品49999")[index % 3]); assertEquals(1, found.size); (System.nanoTime() - start) / 1000000 }
  val percentile = durations.sorted()[(durations.size * 95 + 99) / 100 - 1]
  println("REGI emulator persisted 50000 SKU exact/substring search p95_ms=$percentile")
  assertTrue("Product search p95 must be below 300ms, actual=$percentile", percentile < 300)
  database.close()
 }
 @Test fun fullRoomMigrationPreservesUnknownCheckoutAndPendingOutbox() = runBlocking {
  val context = InstrumentationRegistry.getInstrumentation().targetContext; context.deleteDatabase("full-migration.db")
  val helper = androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory().create(androidx.sqlite.db.SupportSQLiteOpenHelper.Configuration.builder(context).name("full-migration.db").callback(object: androidx.sqlite.db.SupportSQLiteOpenHelper.Callback(1) {
   override fun onCreate(database: androidx.sqlite.db.SupportSQLiteDatabase) {
    database.execSQL("CREATE TABLE products (id TEXT NOT NULL PRIMARY KEY, sku TEXT NOT NULL, jan TEXT, name TEXT NOT NULL, price TEXT NOT NULL, cost TEXT NOT NULL, rateBps INTEGER NOT NULL, stockManaged INTEGER NOT NULL)")
    database.execSQL("CREATE TABLE checkouts (id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL)")
    database.execSQL("CREATE TABLE outbox (id TEXT NOT NULL PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT)")
    database.execSQL("CREATE UNIQUE INDEX index_outbox_sequence ON outbox(sequence)"); database.execSQL("CREATE TABLE metadata (`key` TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)")
    database.execSQL("INSERT INTO checkouts VALUES ('unknown-payment','unknown','{\"total\":\"110\"}','2026-10-01T00:00:00Z')")
    database.execSQL("INSERT INTO outbox VALUES ('unsent-sale',1,'{\"total\":\"110\"}','pending',NULL)"); database.execSQL("INSERT INTO metadata VALUES ('sequence','1')")
   }
   override fun onUpgrade(database: androidx.sqlite.db.SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) {}
  }).build()); helper.writableDatabase; helper.close()
  val database = Room.databaseBuilder(context, PosDatabase::class.java, "full-migration.db").addMigrations(PosDatabase.migration, PosDatabase.indexMigration, PosDatabase.nameIndexMigration).build()
  assertEquals("unknown", database.dao().checkoutById("unknown-payment")!!.status); assertEquals(1, database.dao().pendingCount()); assertEquals("1", database.dao().metadata("sequence")); assertEquals("unsent-sale", database.dao().pending().first().id); database.close()
 }
 @Test fun expiredOfflineLeaseRefreshesOnlineWithoutDiscardingStartedPayment() = runBlocking {
  val context = InstrumentationRegistry.getInstrumentation().targetContext; context.deleteDatabase("lease-refresh.db")
  val database = Room.databaseBuilder(context, PosDatabase::class.java, "lease-refresh.db").build(); var now = java.time.Instant.now(); val repository = Repository(context, database) { now }
  repository.network.configure("http://10.0.2.2:3000", "", true, fixture().getString("cashierSubject"), fixture().getString("tenant")); repository.bootstrap(fixtureDevice("lease")); repository.authenticate(fixtureStaff("cashier"), "1234"); if (!repository.dao.metadata("shiftId").isNullOrBlank()) { repository.close("10000"); repository.sync() }; repository.openShift("10000", "1234"); repository.sync()
  val product = repository.dao.search("COFFEE").first(); val checkout = repository.begin(listOf(SaleLine(product.id, product.name, 1, product.price, "0", product.rateBps, product.cost, true)), "0", "card"); val originalLease = repository.snapshot().getString("leaseId")
  now = now.plusSeconds(73 * 3600); assertTrue(runCatching { repository.assertSaleAllowed() }.isFailure); assertTrue(runCatching { repository.confirm(checkout.id, "0", "SUCCESS-AFTER-REFRESH") }.isFailure)
  repository.renewAuthentication(); assertNotEquals(originalLease, repository.snapshot().getString("leaseId")); repository.assertSaleAllowed()
  val confirmed = repository.confirm(checkout.id, "0", "SUCCESS-AFTER-REFRESH"); assertEquals(originalLease, JSONObject(confirmed.body).getString("paymentLeaseId")); assertEquals("confirmed", confirmed.status)
  repository.sync(); assertEquals(0, repository.dao.pendingCount()); repository.close("10000"); repository.sync(); database.close()
 }
 @Test fun browserPkceRejectsWrongStateAndRefreshesEncryptedTokens() = runBlocking<Unit> {
  val context = InstrumentationRegistry.getInstrumentation().targetContext; val oauth = OAuth(context); oauth.logout(); val listener = ServerSocket(0); val requests = mutableListOf<String>(); val executor = Executors.newSingleThreadExecutor()
  val server = executor.submit { repeat(2) { index -> listener.accept().use { socket -> val reader = socket.getInputStream().bufferedReader(); reader.readLine(); var length = 0; while (true) { val header = reader.readLine(); if (header.isNullOrEmpty()) break; if (header.startsWith("Content-Length:", true)) length = header.substringAfter(':').trim().toInt() }; val body = CharArray(length); var read = 0; while (read < length) read += reader.read(body, read, length - read); requests.add(String(body)); val payload = if (index == 0) "{\"id_token\":\"ID-A\",\"refresh_token\":\"REFRESH-A\",\"expires_in\":0}" else "{\"id_token\":\"ID-B\",\"expires_in\":3600}"; socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.toByteArray().size}\r\nConnection: close\r\n\r\n" + payload).toByteArray()) } } }
  oauth.configure("http://127.0.0.1:${listener.localPort}", "test-public-client"); val authorization = oauth.authorizationUrl(); assertEquals("S256", authorization.getQueryParameter("code_challenge_method")); assertTrue(runCatching { oauth.callback(android.net.Uri.parse("regipos://oauth?code=test&state=wrong")) }.isFailure)
  oauth.callback(android.net.Uri.parse("regipos://oauth?code=test&state=${authorization.getQueryParameter("state")}")); assertEquals("ID-B", oauth.freshToken()); server.get(); assertTrue(requests[0].contains("code_verifier=")); assertTrue(requests[1].contains("grant_type=refresh_token")); assertTrue(requests[1].contains("refresh_token=REFRESH-A")); assertTrue(runCatching { oauth.callback(android.net.Uri.parse("regipos://oauth?code=test&state=${authorization.getQueryParameter("state")}")) }.isFailure); oauth.logout(); listener.close(); executor.shutdownNow()
 }
}
