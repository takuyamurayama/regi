package jp.regi.pos

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class SecureVault(context: Context) {
 private val preferences = context.getSharedPreferences("regi-oauth", Context.MODE_PRIVATE)
 private fun key(): SecretKey {
  val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  return store.getKey("regi-oauth", null) as? SecretKey ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(KeyGenParameterSpec.Builder("regi-oauth", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()) }.generateKey()
 }
 fun save(name: String, value: String) { val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }; preferences.edit().putString(name, Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)).commit() }
 fun read(name: String): String? { val encoded = preferences.getString(name, null) ?: return null; val bytes = Base64.decode(encoded, Base64.NO_WRAP); val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }; return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size))) }
 fun clear(name: String) { preferences.edit().remove(name).commit() }
}
class OAuth(context: Context) {
 private val vault = SecureVault(context)
 companion object { private val refreshLock = Mutex(); const val redirectUri = "regipos://oauth" }
 fun configured() = vault.read("configuration") != null
 fun configure(domain: String, clientId: String) { require(domain.startsWith("https://") || (BuildConfig.DEBUG && domain.startsWith("http://127.0.0.1:"))); require(clientId.isNotBlank()); vault.save("configuration", JSONObject().put("domain", domain.trimEnd('/')).put("clientId", clientId).toString()) }
 private fun random(): String { val bytes = ByteArray(48); SecureRandom().nextBytes(bytes); return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
 fun authorizationUrl(): Uri {
  val config = JSONObject(vault.read("configuration") ?: error("Cognito設定が必要です")); val verifier = random(); val state = random()
  vault.save("pending", JSONObject().put("verifier", verifier).put("state", state).put("startedAt", System.currentTimeMillis()).toString())
  val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  return Uri.parse(config.getString("domain") + "/oauth2/authorize").buildUpon().appendQueryParameter("client_id", config.getString("clientId")).appendQueryParameter("response_type", "code").appendQueryParameter("scope", "openid profile").appendQueryParameter("redirect_uri", redirectUri).appendQueryParameter("code_challenge_method", "S256").appendQueryParameter("code_challenge", challenge).appendQueryParameter("state", state).build()
 }
 suspend fun callback(uri: Uri) {
  require(uri.scheme == "regipos" && uri.host == "oauth") { "認証コールバックが異なります" }
  val pending = JSONObject(vault.read("pending") ?: error("認証要求がありません"))
  require(System.currentTimeMillis() - pending.getLong("startedAt") < 600000 && MessageDigest.isEqual(uri.getQueryParameter("state")?.toByteArray() ?: ByteArray(0), pending.getString("state").toByteArray())) { "認証state・期限が一致しません" }
  val code = uri.getQueryParameter("code") ?: error("認証が完了していません")
  val response = exchange(mapOf("grant_type" to "authorization_code", "code" to code, "redirect_uri" to redirectUri, "code_verifier" to pending.getString("verifier")))
  store(response); vault.clear("pending")
 }
 private suspend fun exchange(fields: Map<String, String>): JSONObject = withContext(Dispatchers.IO) {
  val config = JSONObject(vault.read("configuration") ?: error("Cognito設定が必要です")); val connection = URL(config.getString("domain") + "/oauth2/token").openConnection() as HttpURLConnection
  try { connection.connectTimeout = 10000; connection.readTimeout = 20000; connection.requestMethod = "POST"; connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded"); connection.doOutput = true
   val body = (fields + ("client_id" to config.getString("clientId"))).entries.joinToString("&") { java.net.URLEncoder.encode(it.key, "UTF-8") + "=" + java.net.URLEncoder.encode(it.value, "UTF-8") }
   connection.outputStream.use { it.write(body.toByteArray()) }; require(connection.responseCode in 200..299) { "Cognito認証更新に失敗しました。ログインしてください" }; JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
  } finally { connection.disconnect() }
 }
 private fun store(response: JSONObject) { val existing = vault.read("tokens")?.let(::JSONObject); val refresh = response.optString("refresh_token").ifBlank { existing?.optString("refresh_token") ?: "" }; vault.save("tokens", JSONObject().put("id_token", response.getString("id_token")).put("refresh_token", refresh).put("expiresAt", System.currentTimeMillis() + response.getLong("expires_in") * 1000).toString()) }
 suspend fun freshToken(): String = refreshLock.withLock {
  val saved = JSONObject(vault.read("tokens") ?: error("Cognitoログインが必要です"))
  if (saved.getLong("expiresAt") - System.currentTimeMillis() < 60000) { require(saved.getString("refresh_token").isNotBlank()) { "再ログインが必要です" }; store(exchange(mapOf("grant_type" to "refresh_token", "refresh_token" to saved.getString("refresh_token")))) }
  JSONObject(vault.read("tokens")!!).getString("id_token")
 }
 fun logout() { vault.clear("tokens"); vault.clear("pending") }
}
