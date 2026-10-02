package jp.regi.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.room.Room

/** Non-exported debug harness: the production Pos renders against a named real Room database. */
class PosTestActivity : ComponentActivity() {
    private lateinit var database: PosDatabase

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val name = requireNotNull(intent.getStringExtra("regiTestDatabase"))
        require(name.matches(Regex("pos-ui-[0-9a-f-]+\\.db")))
        database = Room.databaseBuilder(this, PosDatabase::class.java, name).build()
        setContent { MaterialTheme { Pos(Repository(this, database)) } }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::database.isInitialized) database.close()
    }
}
