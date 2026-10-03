package jp.regi.pos

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AuthenticationHeaderTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun requiredLoginAndSavedAndroidClientRemainVisibleAcrossPagesAndRestart() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val oauth = OAuth(context)
        oauth.logout()
        oauth.configure("https://auth.example.invalid", "android-settings-client")
        SecureVault(context).save("administratorLoginRequired", "true")
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            compose.waitUntil(20000) {
                compose.onAllNodesWithText("管理者の再ログインが必要").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("管理者の再ログインが必要").assertIsDisplayed()
            compose.onNodeWithText("設定").performClick()
            compose.onNodeWithText("android-settings-client").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("管理者の再ログインが必要").assertIsDisplayed()
            context.openFileOutput("d0-auth-header.png", Context.MODE_PRIVATE).use { stream ->
                compose
                    .onRoot()
                    .captureToImage()
                    .asAndroidBitmap()
                    .compress(Bitmap.CompressFormat.PNG, 100, stream)
            }
            compose.onNodeWithText("同期").performClick()
            compose.onNodeWithText("管理者の再ログインが必要").assertIsDisplayed()
            activity.recreate()
            compose.waitUntil(20000) {
                compose.onAllNodesWithText("管理者の再ログインが必要").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("管理者の再ログインが必要").assertIsDisplayed()
        }
        oauth.logout()
    }
}
