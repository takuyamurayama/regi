package jp.regi.pos

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class NetworkFailure(val status: Int, message: String) : IllegalStateException(message)

class Network(private val context: Context) {
    val oauth = OAuth(context)
    private val preferences = context.getSharedPreferences("regi", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.getKey("regi-token", null) as? SecretKey
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "regi-token",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    fun configure(
        baseUrl: String,
        token: String,
        development: Boolean,
        subject: String,
        tenantId: String? = null,
    ) {
        require(
            baseUrl.startsWith("https://") ||
                (BuildConfig.DEBUG && development && baseUrl.startsWith("http://"))
        )
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(token.toByteArray())
        val configuration =
            preferences
                .edit()
                .putString("base", baseUrl.trimEnd('/'))
                .putString("token", Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP))
                .putBoolean("development", BuildConfig.DEBUG && development)
                .putString("subject", subject)
        if (
            subject != preferences.getString("subject", null) ||
                (tenantId != null && tenantId != preferences.getString("tenant", null))
        )
            configuration.remove("posStaff")
        if (tenantId != null) configuration.putString("tenant", tenantId)
        configuration.commit()
    }

    private fun token(): String {
        val stored = preferences.getString("token", null) ?: return ""
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
    }

    fun selectStaff(staffId: String?) {
        preferences.edit().putString("posStaff", staffId).commit()
    }

    fun logout() {
        oauth.logout()
        preferences
            .edit()
            .remove("token")
            .remove("posStaff")
            .putBoolean("development", false)
            .commit()
    }

    suspend fun request(
        path: String,
        body: JSONObject? = null,
        recovery: String? = null,
    ): JSONObject =
        withContext(Dispatchers.IO) {
            val base = preferences.getString("base", null) ?: error("API接続を設定してください")
            val connection = URL(base + path).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10000
                connection.readTimeout = 20000
                connection.requestMethod = if (body == null) "GET" else "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                if (recovery != null) connection.setRequestProperty("x-recovery-token", recovery)
                if (recovery != null) Unit
                else if (BuildConfig.DEBUG && preferences.getBoolean("development", false)) {
                    connection.setRequestProperty(
                        "x-tenant-id",
                        preferences.getString("tenant", "10000000-0000-4000-8000-000000000001"),
                    )
                    connection.setRequestProperty(
                        "x-staff-subject",
                        preferences.getString("subject", "local-cashier"),
                    )
                } else
                    connection.setRequestProperty(
                        "Authorization",
                        "Bearer ${if (oauth.configured()) oauth.freshToken() else token()}",
                    )
                preferences.getString("posStaff", null)?.let {
                    connection.setRequestProperty("x-pos-staff-id", it)
                }
                if (body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val stream =
                    if (connection.responseCode in 200..299) connection.inputStream
                    else connection.errorStream
                val text = stream.bufferedReader().use { it.readText() }
                if (connection.responseCode !in 200..299) {
                    val error = JSONObject(text)
                    throw NetworkFailure(
                        connection.responseCode,
                        "${error.optString("code")}: ${error.optString("message")} ${error.optString("nextAction")}",
                    )
                }
                if (text.trimStart().startsWith("[")) JSONObject().put("items", JSONArray(text))
                else JSONObject(text)
            } finally {
                connection.disconnect()
            }
        }
}
