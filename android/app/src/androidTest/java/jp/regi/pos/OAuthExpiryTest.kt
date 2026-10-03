package jp.regi.pos

import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OAuthExpiryTest {
    @Test
    fun staleRefreshResponseCannotRestoreOrPurgeSwitchedClientTokens() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val oauth = OAuth(context)
        for (status in listOf(200, 400)) {
            val started = java.util.concurrent.CountDownLatch(1)
            val release = java.util.concurrent.CountDownLatch(1)
            PosHttpStub {
                    started.countDown()
                    check(release.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    status to
                        if (status == 200)
                            "{\"id_token\":\"STALE-ID\",\"refresh_token\":\"STALE-REFRESH\",\"expires_in\":3600}"
                        else "{\"error\":\"invalid_grant\"}"
                }
                .use { server ->
                    oauth.logout()
                    oauth.configure(server.base, "old-inflight-client")
                    SecureVault(context)
                        .save(
                            "tokens",
                            JSONObject()
                                .put("id_token", "OLD-ID")
                                .put("refresh_token", "OLD-REFRESH")
                                .put("expiresAt", 0)
                                .toString(),
                        )
                    coroutineScope {
                        val inflight = async(Dispatchers.IO) { runCatching { oauth.freshToken() } }
                        check(started.await(10, java.util.concurrent.TimeUnit.SECONDS))
                        oauth.configure(server.base, "new-inflight-client")
                        val current =
                            JSONObject()
                                .put("id_token", "NEW-ID")
                                .put("refresh_token", "NEW-REFRESH")
                                .put("expiresAt", Long.MAX_VALUE)
                                .toString()
                        SecureVault(context).save("tokens", current)
                        SecureVault(context).clear("administratorLoginRequired")
                        release.countDown()
                        assertTrue(inflight.await().isFailure)
                        assertEquals(current, SecureVault(context).read("tokens"))
                        assertFalse(oauth.requiresAdministratorLogin())
                    }
                }
        }
        oauth.logout()
    }

    @Test
    fun invalidGrantPurgesEncryptedTokensAcrossRestart() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val oauth = OAuth(context)
        oauth.logout()
        PosHttpStub { 400 to "{\"error\":\"invalid_grant\"}" }
            .use { server ->
                oauth.configure(server.base, "android-public-client")
                SecureVault(context)
                    .save(
                        "tokens",
                        JSONObject()
                            .put("id_token", "OLD-ID")
                            .put("refresh_token", "OLD-REFRESH")
                            .put("expiresAt", 0)
                            .toString(),
                    )
                assertTrue(runCatching { oauth.freshToken() }.isFailure)
                assertNull(SecureVault(context).read("tokens"))
                assertTrue(oauth.requiresAdministratorLogin())
                assertTrue(OAuth(context).requiresAdministratorLogin())
                assertTrue(runCatching { OAuth(context).freshToken() }.isFailure)
            }
        oauth.logout()
    }

    @Test
    fun thirtyDaysRefreshAndLeaseRenewalKeepTokensUntilInvalidGrant() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val loginAt = Instant.parse("2026-10-01T00:00:00Z")
        var now = loginAt
        var exchanges = 0
        var leases = 0
        val databaseName = "oauth-clock-${UUID.randomUUID()}.db"
        val database = Room.databaseBuilder(context, PosDatabase::class.java, databaseName).build()
        val device = "40000000-0000-4000-8000-000000000032"
        val store = "20000000-0000-4000-8000-000000000032"
        PosHttpStub { request ->
                when {
                    request.path == "/oauth2/token" -> {
                        exchanges++
                        assertTrue(
                            request.body!!
                                .getString("form")
                                .contains("client_id=android-thirty-day-client")
                        )
                        if (!now.isBefore(loginAt.plusSeconds(30 * 86400L)))
                            400 to "{\"error\":\"invalid_grant\"}"
                        else
                            200 to
                                JSONObject()
                                    .put("id_token", "ID-$exchanges")
                                    .put("expires_in", 3600)
                                    .apply {
                                        if (exchanges == 1)
                                            put("refresh_token", "THIRTY-DAY-REFRESH")
                                    }
                                    .toString()
                    }
                    request.path.endsWith("/lease") -> {
                        leases++
                        200 to
                            JSONObject()
                                .put("leaseId", UUID.randomUUID())
                                .put("recoveryToken", "stub-recovery")
                                .put("issuedAt", now.toString())
                                .put("authUntil", now.plusSeconds(259200).toString())
                                .put("contractUntil", now.plusSeconds(31536000).toString())
                                .put("staff", org.json.JSONArray())
                                .put("stocktakeId", JSONObject.NULL)
                                .toString()
                    }
                    request.path.startsWith("/v1/sync/changes") ->
                        200 to "{\"changes\":[],\"cursor\":\"0\"}"
                    request.path.startsWith("/v1/sync/reviews") -> 200 to "[]"
                    else -> 200 to "{}"
                }
            }
            .use { server ->
                try {
                    val repository = Repository(context, database) { now }
                    repository.network.configure(server.base, "", true, "clock-test")
                    context
                        .getSharedPreferences("regi", Context.MODE_PRIVATE)
                        .edit()
                        .putBoolean("development", false)
                        .commit()
                    val oauth = repository.network.oauth
                    oauth.logout()
                    oauth.configure(server.base, "android-thirty-day-client")
                    val authorization = oauth.authorizationUrl()
                    now = loginAt.minusMillis(1)
                    assertTrue(
                        runCatching {
                                oauth.callback(
                                    Uri.parse(
                                        "regipos://oauth?code=clock-test&state=${authorization.getQueryParameter("state")}"
                                    )
                                )
                            }
                            .isFailure
                    )
                    assertEquals(0, exchanges)
                    now = loginAt
                    oauth.callback(
                        Uri.parse(
                            "regipos://oauth?code=clock-test&state=${authorization.getQueryParameter("state")}"
                        )
                    )
                    val checkout =
                        Checkout(
                            UUID.randomUUID().toString(),
                            "unknown",
                            "{\"total\":\"100\"}",
                            now.toString(),
                        )
                    repository.dao.checkout(checkout)
                    repository.dao.metadata(
                        Metadata(
                            "bootstrap",
                            JSONObject()
                                .put(
                                    "device",
                                    JSONObject().put("id", device).put("store_id", store),
                                )
                                .put("leaseId", UUID.randomUUID())
                                .put("settings", JSONObject().put("taxRates", org.json.JSONArray()))
                                .toString(),
                        )
                    )
                    repeat(30) { day ->
                        now = loginAt.plusSeconds(day * 86400L + 7200)
                        repository.sync()
                        assertFalse(oauth.requiresAdministratorLogin())
                        assertEquals(
                            now.plusSeconds(259200).toString(),
                            repository.snapshot().getString("authUntil"),
                        )
                    }
                    assertEquals(31, exchanges)
                    assertEquals(30, leases)
                    assertEquals(
                        "THIRTY-DAY-REFRESH",
                        JSONObject(SecureVault(context).read("tokens")!!).getString("refresh_token"),
                    )
                    val statuses = server.requests.filter { it.path.endsWith("/status") }
                    assertTrue(
                        statuses.all {
                            it.body!!.getInt("pending") == 1 && it.body.getInt("reviewCount") == 0
                        }
                    )
                    now = loginAt.plusSeconds(29 * 86400L + 23 * 3600L)
                    coroutineScope {
                        (1..5).map { async(Dispatchers.IO) { oauth.freshToken() } }.awaitAll()
                    }
                    assertEquals(32, exchanges)
                    now = loginAt.plusSeconds(30 * 86400L)
                    assertTrue(runCatching { repository.sync() }.isFailure)
                    assertNull(SecureVault(context).read("tokens"))
                    assertTrue(OAuth(context).requiresAdministratorLogin())
                    assertEquals("true", repository.dao.metadata("administratorLoginRequired"))
                    assertEquals(checkout, repository.dao.checkoutById(checkout.id))
                    assertEquals(0, repository.dao.pendingCount())
                    oauth.configure(server.base, "switched-android-client")
                    assertEquals(
                        "switched-android-client",
                        oauth.configuration()!!.getString("clientId"),
                    )
                } finally {
                    database.close()
                    context.deleteDatabase(databaseName)
                    OAuth(context).logout()
                }
            }
    }

    @Test
    fun clientSwitchPurgesOldTokensButTransientFailureKeepsThem() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val oauth = OAuth(context)
        oauth.logout()
        PosHttpStub { 500 to "{\"error\":\"temporarily_unavailable\"}" }
            .use { server ->
                oauth.configure(server.base, "old-android-client")
                val tokens =
                    JSONObject()
                        .put("id_token", "OLD-ID")
                        .put("refresh_token", "OLD-REFRESH")
                        .put("expiresAt", 0)
                        .toString()
                SecureVault(context).save("tokens", tokens)
                assertTrue(runCatching { oauth.freshToken() }.isFailure)
                assertEquals(tokens, SecureVault(context).read("tokens"))
                oauth.configure(server.base, "new-android-client")
                assertNull(SecureVault(context).read("tokens"))
                assertTrue(oauth.requiresAdministratorLogin())
                assertEquals(
                    "new-android-client",
                    OAuth(context).configuration()!!.getString("clientId"),
                )
            }
        oauth.logout()
    }
}
