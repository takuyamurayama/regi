package jp.regi.pos

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(
    tableName = "products",
    indices = [Index(value = ["sku"]), Index(value = ["jan"]), Index(value = ["name"])],
)
data class Product(
    @PrimaryKey val id: String,
    val sku: String,
    val jan: String?,
    val name: String,
    val price: String,
    val cost: String,
    val rateBps: Int,
    val stockManaged: Boolean,
    val taxCode: String = "",
)

@Entity(tableName = "checkouts")
data class Checkout(
    @PrimaryKey val id: String,
    val status: String,
    val body: String,
    val createdAt: String,
)

@Entity(tableName = "outbox", indices = [Index(value = ["sequence"], unique = true)])
data class Event(
    @PrimaryKey val id: String,
    val sequence: Long,
    val payload: String,
    val status: String = "pending",
    val error: String? = null,
)

@Entity(tableName = "metadata") data class Metadata(@PrimaryKey val key: String, val value: String)

@Dao
interface PosDao {
    @Query(
        "SELECT * FROM products WHERE jan = :query OR sku = :query OR name = :query ORDER BY sku LIMIT 100"
    )
    suspend fun exact(query: String): List<Product>

    @Query(
        "SELECT * FROM products WHERE name LIKE '%' || :query || '%' OR sku LIKE '%' || :query || '%' LIMIT 100"
    )
    suspend fun matching(query: String): List<Product>

    @Query(
        """
        SELECT * FROM products
        WHERE (instr(CAST(name AS BLOB),CAST(:query AS BLOB)) > 0
               AND name GLOB '*' || :query || '*')
           OR (instr(CAST(sku AS BLOB),CAST(:query AS BLOB)) > 0
               AND sku GLOB '*' || :query || '*')
        LIMIT 100
        """
    )
    suspend fun matchingJapaneseLiteral(query: String): List<Product>

    suspend fun search(query: String): List<Product> {
        val found = if (query.isNotBlank()) exact(query) else emptyList()
        if (found.isNotEmpty()) return found
        // Android ICU LIKE folds Unicode case. Only these uncased BMP characters use GLOB;
        // the binary prefilter avoids decoding misses, and GLOB preserves termination at NUL.
        // other inputs retain LIKE, including its wildcards, NUL and 50,000-byte pattern limit.
        val literal =
            query.isNotEmpty() &&
                query.length <= 16384 &&
                query.all {
                    it in '0'..'9' ||
                        it in '\u3041'..'\u3096' ||
                        it in '\u30a1'..'\u30fa' ||
                        it in '\u4e00'..'\u9fff'
                }
        return (if (literal) matchingJapaneseLiteral(query) else matching(query)).sortedBy {
            it.sku
        }
    }

    @Upsert suspend fun products(products: List<Product>)

    @Query("SELECT * FROM products WHERE id=:id") suspend fun product(id: String): Product?

    @Upsert suspend fun checkout(checkout: Checkout)

    @Query("SELECT * FROM checkouts ORDER BY createdAt DESC LIMIT 100")
    suspend fun history(): List<Checkout>

    @Query("SELECT * FROM checkouts WHERE status IN ('checking','unknown') ORDER BY createdAt DESC")
    suspend fun unfinished(): List<Checkout>

    @Query("SELECT * FROM checkouts WHERE id = :id") suspend fun checkoutById(id: String): Checkout?

    @Insert suspend fun event(event: Event)

    @Query("SELECT * FROM outbox WHERE status='pending' ORDER BY sequence LIMIT 100")
    suspend fun pending(): List<Event>

    @Query("SELECT COUNT(*) FROM outbox WHERE status='pending'") suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM outbox WHERE status='review'") suspend fun reviewCount(): Int

    @Query("SELECT * FROM outbox WHERE id=:id") suspend fun eventById(id: String): Event?

    @Query("SELECT COUNT(*) FROM checkouts WHERE status IN ('checking','unknown')")
    suspend fun unknownCount(): Int

    @Query("UPDATE outbox SET status=:status,error=:error WHERE id=:id")
    suspend fun result(id: String, status: String, error: String?)

    @Query("SELECT * FROM outbox WHERE status='review'") suspend fun reviews(): List<Event>

    @Query("SELECT value FROM metadata WHERE `key`=:key") suspend fun metadata(key: String): String?

    @Upsert suspend fun metadata(metadata: Metadata)

    @Query("SELECT * FROM metadata WHERE `key` LIKE :prefix || '%'")
    suspend fun metadataPrefix(prefix: String): List<Metadata>

    @Query("DELETE FROM metadata WHERE `key`=:key") suspend fun removeMetadata(key: String)
}

@Database(
    entities = [Product::class, Checkout::class, Event::class, Metadata::class],
    version = 4,
    exportSchema = false,
)
abstract class PosDatabase : RoomDatabase() {
    abstract fun dao(): PosDao

    companion object {
        @Volatile private var instance: PosDatabase? = null
        val migration =
            object : Migration(1, 2) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        "ALTER TABLE products ADD COLUMN taxCode TEXT NOT NULL DEFAULT ''"
                    )
                }
            }
        val indexMigration =
            object : Migration(2, 3) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_products_sku ON products(sku)"
                    )
                    database.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_products_jan ON products(jan)"
                    )
                }
            }
        val nameIndexMigration =
            object : Migration(3, 4) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_products_name ON products(name)"
                    )
                }
            }

        fun get(context: Context): PosDatabase =
            instance
                ?: synchronized(this) {
                    instance
                        ?: Room.databaseBuilder(
                                context.applicationContext,
                                PosDatabase::class.java,
                                "regi.db",
                            )
                            .addMigrations(migration, indexMigration, nameIndexMigration)
                            .build()
                            .also { instance = it }
                }
    }
}
