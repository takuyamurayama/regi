package jp.regi.pos

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

class SecureVault(context: Context) {
    private val preferences = context.getSharedPreferences("regi-oauth", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.getKey("regi-oauth", null) as? SecretKey
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "regi-oauth",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    fun save(name: String, value: String) {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        preferences
            .edit()
            .putString(
                name,
                Base64.encodeToString(
                    cipher.iv + cipher.doFinal(value.toByteArray()),
                    Base64.NO_WRAP,
                ),
            )
            .commit()
    }

    fun read(name: String): String? {
        val encoded = preferences.getString(name, null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
    }

    fun clear(name: String) {
        preferences.edit().remove(name).commit()
    }
}

class AdministratorLoginRequired : IllegalStateException("管理者の再ログインが必要")

class OAuth(context: Context, private val clock: () -> Long = { System.currentTimeMillis() }) {
    private val vault = SecureVault(context)

    private data class TokenResponse(val body: JSONObject, val configuration: String)

    companion object {
        private val refreshLock = Mutex()
        private val credentialLock = Any()
        const val redirectUri = "regipos://oauth"
    }

    fun configured() = vault.read("configuration") != null

    fun configuration(): JSONObject? = vault.read("configuration")?.let(::JSONObject)

    fun requiresAdministratorLogin() = vault.read("administratorLoginRequired") == "true"

    fun configure(domain: String, clientId: String) =
        synchronized(credentialLock) {
            require(
                domain.startsWith("https://") ||
                    (BuildConfig.DEBUG && domain.startsWith("http://127.0.0.1:"))
            )
            require(clientId.isNotBlank())
            val previous = configuration()
            if (
                previous != null &&
                    (previous.optString("domain") != domain.trimEnd('/') ||
                        previous.optString("clientId") != clientId)
            ) {
                vault.clear("tokens")
                vault.clear("pending")
                vault.save("administratorLoginRequired", "true")
            }
            vault.save(
                "configuration",
                JSONObject()
                    .put("domain", domain.trimEnd('/'))
                    .put("clientId", clientId)
                    .put("revision", UUID.randomUUID().toString())
                    .toString(),
            )
        }

    private fun random(): String {
        val bytes = ByteArray(48)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    fun authorizationUrl(): Uri =
        synchronized(credentialLock) {
            val configuration = vault.read("configuration") ?: error("Cognito設定が必要です")
            val config = JSONObject(configuration)
            val verifier = random()
            val state = random()
            vault.save(
                "pending",
                JSONObject()
                    .put("verifier", verifier)
                    .put("state", state)
                    .put("startedAt", clock())
                    .put("configuration", configuration)
                    .toString(),
            )
            val challenge =
                Base64.encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()),
                    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
                )
            Uri.parse(config.getString("domain") + "/oauth2/authorize")
                .buildUpon()
                .appendQueryParameter("client_id", config.getString("clientId"))
                .appendQueryParameter("response_type", "code")
                .appendQueryParameter("scope", "openid profile")
                .appendQueryParameter("redirect_uri", redirectUri)
                .appendQueryParameter("code_challenge_method", "S256")
                .appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("state", state)
                .build()
        }

    suspend fun callback(uri: Uri) {
        require(uri.scheme == "regipos" && uri.host == "oauth") { "認証コールバックが異なります" }
        val request =
            synchronized(credentialLock) {
                val stored = vault.read("pending") ?: error("認証要求がありません")
                val pending = JSONObject(stored)
                val configuration = vault.read("configuration") ?: error("Cognito設定が必要です")
                require(
                    pending.getString("configuration") == configuration &&
                        clock() - pending.getLong("startedAt") in 0 until 600000 &&
                        MessageDigest.isEqual(
                            uri.getQueryParameter("state")?.toByteArray() ?: ByteArray(0),
                            pending.getString("state").toByteArray(),
                        )
                ) {
                    "認証state・設定・期限が一致しません"
                }
                val code = uri.getQueryParameter("code") ?: error("認証が完了していません")
                Triple(
                    stored,
                    configuration,
                    mapOf(
                        "grant_type" to "authorization_code",
                        "code" to code,
                        "redirect_uri" to redirectUri,
                        "code_verifier" to pending.getString("verifier"),
                    ),
                )
            }
        store(exchange(request.third, request.second), request.first)
    }

    private suspend fun exchange(
        fields: Map<String, String>,
        configuration: String,
    ): TokenResponse =
        withContext(Dispatchers.IO) {
            val config = JSONObject(configuration)
            val connection =
                URL(config.getString("domain") + "/oauth2/token").openConnection()
                    as HttpURLConnection
            try {
                connection.connectTimeout = 10000
                connection.readTimeout = 20000
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.doOutput = true
                val body =
                    (fields + ("client_id" to config.getString("clientId"))).entries.joinToString(
                        "&"
                    ) {
                        java.net.URLEncoder.encode(it.key, "UTF-8") +
                            "=" +
                            java.net.URLEncoder.encode(it.value, "UTF-8")
                    }
                connection.outputStream.use { it.write(body.toByteArray()) }
                if (connection.responseCode !in 200..299) {
                    val errorBody = connection.errorStream?.bufferedReader()?.use { it.readText() }
                    val invalidGrant =
                        errorBody?.let {
                            runCatching { JSONObject(it).optString("error") == "invalid_grant" }
                                .getOrDefault(false)
                        } ?: false
                    if (invalidGrant) {
                        synchronized(credentialLock) {
                            if (vault.read("configuration") == configuration) {
                                vault.clear("tokens")
                                vault.clear("pending")
                                vault.save("administratorLoginRequired", "true")
                            }
                        }
                        throw AdministratorLoginRequired()
                    }
                    error("Cognito認証更新に失敗しました。同じ資格情報で再試行してください")
                }
                TokenResponse(
                    JSONObject(connection.inputStream.bufferedReader().use { it.readText() }),
                    configuration,
                )
            } finally {
                connection.disconnect()
            }
        }

    private fun store(token: TokenResponse, pending: String? = null) =
        synchronized(credentialLock) {
            if (
                vault.read("configuration") != token.configuration ||
                    (pending != null && vault.read("pending") != pending)
            )
                throw AdministratorLoginRequired()
            val response = token.body
            val existing = vault.read("tokens")?.let(::JSONObject)
            val refresh =
                response.optString("refresh_token").ifBlank {
                    existing?.optString("refresh_token") ?: ""
                }
            vault.save(
                "tokens",
                JSONObject()
                    .put("id_token", response.getString("id_token"))
                    .put("refresh_token", refresh)
                    .put("expiresAt", clock() + response.getLong("expires_in") * 1000)
                    .toString(),
            )
            vault.clear("administratorLoginRequired")
            if (pending != null) vault.clear("pending")
        }

    suspend fun freshToken(): String =
        refreshLock.withLock {
            val snapshot =
                synchronized(credentialLock) {
                    val configuration =
                        vault.read("configuration") ?: throw AdministratorLoginRequired()
                    val saved =
                        JSONObject(vault.read("tokens") ?: throw AdministratorLoginRequired())
                    configuration to saved
                }
            val saved = snapshot.second
            if (saved.getLong("expiresAt") - clock() < 60000) {
                require(saved.getString("refresh_token").isNotBlank()) { "再ログインが必要です" }
                store(
                    exchange(
                        mapOf(
                            "grant_type" to "refresh_token",
                            "refresh_token" to saved.getString("refresh_token"),
                        ),
                        snapshot.first,
                    )
                )
            }
            synchronized(credentialLock) {
                if (vault.read("configuration") != snapshot.first)
                    throw AdministratorLoginRequired()
                JSONObject(vault.read("tokens") ?: throw AdministratorLoginRequired())
                    .getString("id_token")
            }
        }

    fun logout() {
        synchronized(credentialLock) {
            vault.clear("tokens")
            vault.clear("pending")
            configuration()?.let {
                vault.save(
                    "configuration",
                    it.put("revision", UUID.randomUUID().toString()).toString(),
                )
                vault.save("administratorLoginRequired", "true")
            }
        }
    }
}
