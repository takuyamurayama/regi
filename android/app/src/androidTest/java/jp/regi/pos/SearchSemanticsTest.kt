package jp.regi.pos

import androidx.room.Room
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class SearchSemanticsTest {
    @Test
    fun searchRetainsExactLikeUnicodeWildcardNulOrderAndLimitSemantics() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "search-semantics.db"
        context.deleteDatabase(name)
        val database = Room.databaseBuilder(context, PosDatabase::class.java, name).build()
        try {
            val named =
                listOf(
                    Triple("literal", "ITEM-1", "商品49999"),
                    Triple("upper", "mix-B", "Alpha"),
                    Triple("lower", "mix-a", "alpha"),
                    Triple("unicode-upper", "unicode-A", "ÄΣ色"),
                    Triple("unicode-lower", "unicode-B", "äσ色"),
                    Triple("symbols", "slash\\sku_%", "記号%_\\品🙂"),
                    Triple("quote", "quote", "引用'品"),
                    Triple("name-nul", "nul-name", "先頭\u0000商品末尾"),
                    Triple("sku-nul", "番号\u000049999", "NUL入りSKU"),
                    Triple("both-nul", "先頭\u0000末尾", "先頭\u0000末尾"),
                    Triple("hiragana", "かな1", "ひらがな商品"),
                    Triple("katakana", "カタカナ1", "カタカナ商品"),
                    Triple("decomposed", "別かな2", "ひらか\u3099な商品"),
                ) + List(150) { Triple("bulk-$it", "BULK-${150 - it}", "商品 bulk $it") }
            database
                .dao()
                .products(
                    named.map { (id, sku, label) ->
                        Product(id, sku, "JAN-$id", label, "100", "40", 1000, true)
                    }
                )
            database
                .dao()
                .products(
                    List(125) { index ->
                        Product(
                            "exact-limit-$index",
                            "EXACT-${125 - index}",
                            null,
                            "exact-limit",
                            "100",
                            "40",
                            1000,
                            true,
                        )
                    } +
                        listOf(
                            Product(
                                "exact-jan",
                                "E-JAN",
                                "exact-cross",
                                "JAN match",
                                "100",
                                "40",
                                1000,
                                true,
                            ),
                            Product(
                                "exact-two",
                                "E-TWO",
                                "exact-cross",
                                "exact-cross",
                                "100",
                                "40",
                                1000,
                                true,
                            ),
                            Product(
                                "exact-name",
                                "E-NAME",
                                null,
                                "exact-cross",
                                "100",
                                "40",
                                1000,
                                true,
                            ),
                            Product(
                                "exact-many",
                                "exact-cross",
                                "exact-cross",
                                "exact-cross",
                                "100",
                                "40",
                                1000,
                                true,
                            ),
                        )
                )
            val queries =
                listOf(
                    "商品49999",
                    "JAN-literal",
                    "item-1",
                    "MIX",
                    "ALPHA",
                    "alpha",
                    "ä",
                    "Ä",
                    "σ",
                    "Σ",
                    "品",
                    "品49999",
                    "%",
                    "_",
                    "bulk",
                    "BULK",
                    "\\",
                    "\\品",
                    "'品",
                    "🙂",
                    "",
                    "0",
                    "49999",
                    "末尾",
                    "先頭",
                    "\u0000",
                    "先頭\u0000末尾",
                    "商品\u0000",
                    "not-present",
                    "exact-cross",
                    "exact-limit",
                    "かな",
                    "ひらがな",
                    "タカナ",
                    "が",
                    "か\u3099",
                    "色",
                    "品49",
                    "商品49",
                    "49",
                    "未登録",
                )
            for (query in queries) {
                // Keep the previous SQL itself as an independent compatibility oracle.
                val exact =
                    if (query.isNotBlank())
                        database.openHelper.readableDatabase
                            .query(
                                SimpleSQLiteQuery(
                                    "SELECT * FROM products WHERE jan = ? OR sku = ? OR name = ? ORDER BY sku LIMIT 100",
                                    arrayOf(query, query, query),
                                )
                            )
                            .use { cursor ->
                                buildList {
                                    while (cursor.moveToNext()) add(
                                        cursor.getString(cursor.getColumnIndexOrThrow("id"))
                                    )
                                }
                            }
                    else emptyList()
                val expected =
                    if (exact.isNotEmpty()) exact
                    else
                        database.openHelper.readableDatabase
                            .query(
                                SimpleSQLiteQuery(
                                    "SELECT * FROM products WHERE name LIKE '%' || ? || '%' OR sku LIKE '%' || ? || '%' LIMIT 100",
                                    arrayOf(query, query),
                                )
                            )
                            .use { cursor ->
                                val rows = mutableListOf<Pair<String, String>>()
                                while (cursor.moveToNext()) rows.add(
                                    cursor.getString(cursor.getColumnIndexOrThrow("id")) to
                                        cursor.getString(cursor.getColumnIndexOrThrow("sku"))
                                )
                                rows.sortedBy { it.second }.map { it.first }
                            }
                assertEquals(
                    "Existing search behavior for query ${query.toCharArray().map { it.code }}",
                    expected,
                    database.dao().search(query).map { it.id },
                )
            }
            assertEquals(listOf("upper", "lower"), database.dao().search("ALPHA").map { it.id })
            assertEquals(
                listOf("unicode-upper", "unicode-lower"),
                database.dao().search("Σ").map { it.id },
            )
            assertEquals(
                listOf("unicode-upper", "unicode-lower"),
                database.dao().search("σ").map { it.id },
            )
            assertEquals(listOf("literal"), database.dao().search("品49999").map { it.id })
            assertEquals(4, database.dao().search("exact-cross").size)
            assertEquals(100, database.dao().search("exact-limit").size)
            for (query in
                listOf("品", "品49999", "商品", "0", "49999", "末尾", "先頭", "かな", "が", "タカナ", "色")) {
                fun ids(operator: String): List<String> =
                    database.openHelper.readableDatabase
                        .query(
                            SimpleSQLiteQuery(
                                "SELECT * FROM products WHERE name $operator ? OR sku $operator ? LIMIT 100",
                                Array<Any>(2) { if (operator == "GLOB") "*$query*" else "%$query%" },
                            )
                        )
                        .use { cursor ->
                            buildList {
                                while (cursor.moveToNext()) add(
                                    cursor.getString(cursor.getColumnIndexOrThrow("id"))
                                )
                            }
                        }
                assertEquals(
                    "Supported literal including NUL rows: $query",
                    ids("LIKE"),
                    ids("GLOB"),
                )
                val indexed =
                    database.openHelper.readableDatabase
                        .query(
                            SimpleSQLiteQuery(
                                "SELECT * FROM products WHERE rowid IN (SELECT rowid FROM products INDEXED BY index_products_name WHERE name GLOB ? UNION ALL SELECT rowid FROM products INDEXED BY index_products_sku WHERE sku GLOB ?) ORDER BY rowid LIMIT 100",
                                Array<Any>(2) { "*$query*" },
                            )
                        )
                        .use { cursor ->
                            buildList {
                                while (cursor.moveToNext()) add(
                                    cursor.getString(cursor.getColumnIndexOrThrow("id"))
                                )
                            }
                        }
                assertEquals(
                    "Covering indices preserve first100 rows: $query",
                    ids("LIKE"),
                    indexed,
                )
                val binaryPrefiltered =
                    database.openHelper.readableDatabase
                        .query(
                            SimpleSQLiteQuery(
                                "SELECT * FROM products WHERE (instr(CAST(name AS BLOB),CAST(? AS BLOB)) > 0 AND name GLOB ?) OR (instr(CAST(sku AS BLOB),CAST(? AS BLOB)) > 0 AND sku GLOB ?) LIMIT 100",
                                arrayOf(query, "*$query*", query, "*$query*"),
                            )
                        )
                        .use { cursor ->
                            val idColumn = cursor.getColumnIndexOrThrow("id")
                            buildList {
                                while (cursor.moveToNext()) add(cursor.getString(idColumn))
                            }
                        }
                assertEquals(
                    "Binary prefilter keeps NUL/Unicode/first100 rows: $query",
                    ids("LIKE"),
                    binaryPrefiltered,
                )
            }
            assertEquals(100, database.dao().search("").size)
            val longQuery = "品".repeat(17000)
            val previousFailure =
                runCatching {
                        database.openHelper.readableDatabase
                            .query(
                                SimpleSQLiteQuery(
                                    "SELECT * FROM products WHERE name LIKE '%' || ? || '%' OR sku LIKE '%' || ? || '%' LIMIT 100",
                                    arrayOf(longQuery, longQuery),
                                )
                            )
                            .use { it.moveToFirst() }
                    }
                    .exceptionOrNull()
            assertNotNull(
                "The previous LIKE pattern byte limit must remain effective",
                previousFailure,
            )
            assertEquals(
                previousFailure!!::class.java,
                runCatching { database.dao().search(longQuery) }.exceptionOrNull()?.javaClass,
            )
            assertEquals(4, database.openHelper.readableDatabase.version)
        } finally {
            database.close()
            context.deleteDatabase(name)
        }
    }
}
