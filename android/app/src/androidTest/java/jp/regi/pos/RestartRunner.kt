package jp.regi.pos

import android.app.Instrumentation
import android.os.Bundle
import androidx.room.Room
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

class RestartRunner : Instrumentation() {
    private lateinit var arguments: Bundle

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        this.arguments = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        val evidence = Bundle()
        val stage = arguments.getString("stage") ?: ""
        try {
            runBlocking {
                require(stage in listOf("prepare", "recover"))
                val fixture =
                    JSONObject(arguments.getString("regiTestFixture") ?: error("Fixture required"))
                if (stage == "prepare") targetContext.deleteDatabase("process-restart.db")
                val database =
                    Room.databaseBuilder(
                            targetContext,
                            PosDatabase::class.java,
                            "process-restart.db",
                        )
                        .build()
                try {
                    val repository = Repository(targetContext, database)
                    repository.network.configure(
                        fixtureApiBaseUrl(arguments),
                        "",
                        true,
                        fixture.getString("cashierSubject"),
                        fixture.getString("tenant"),
                    )
                    if (stage == "prepare") {
                        repository.bootstrap(fixture.getJSONObject("devices").getString("hold"))
                        repository.authenticate(fixture.getString("cashier"), "1234")
                        repository.openShift("1000", "1234")
                        repository.sync()
                        repository.network.configure(
                            "http://127.0.0.1:9",
                            "",
                            true,
                            fixture.getString("cashierSubject"),
                            fixture.getString("tenant"),
                        )
                        val product = repository.dao.search("COFFEE").single()
                        val checkout =
                            repository.begin(
                                listOf(
                                    SaleLine(
                                        product.id,
                                        product.name,
                                        2,
                                        product.price,
                                        "0",
                                        product.rateBps,
                                        product.cost,
                                        true,
                                    )
                                ),
                                "1",
                                "card",
                            )
                        repository.unknown(checkout.id)
                        repository.dao.metadata(Metadata("restart-checkout", checkout.id))
                        check(repository.dao.checkoutById(checkout.id)?.status == "unknown")
                    } else {
                        val checkoutId =
                            repository.dao.metadata("restart-checkout")
                                ?: error("Persisted checkout missing")
                        val checkout =
                            repository.dao.checkoutById(checkoutId)
                                ?: error("Persisted checkout missing")
                        check(checkout.status == "unknown")
                        check(JSONObject(checkout.body).getString("total") == "2159")
                        repository.confirm(checkoutId, "0", "AFTER-PROCESS-DEATH")
                        repository.confirm(checkoutId, "0", "AFTER-PROCESS-DEATH")
                        check(repository.dao.pendingCount() == 1)
                        repository.sync()
                        check(repository.dao.pendingCount() == 0)
                        check(repository.dao.checkoutById(checkoutId)?.status == "confirmed")
                        repository.close("1000")
                        repository.sync()
                    }
                } finally {
                    database.close()
                }
            }
            evidence.putString("result", "REGI_RESTART_SUCCESS:$stage")
            evidence.putInt("pid", android.os.Process.myPid())
            finish(android.app.Activity.RESULT_OK, evidence)
        } catch (failure: Throwable) {
            evidence.putString("error", failure.stackTraceToString())
            finish(android.app.Activity.RESULT_CANCELED, evidence)
        }
    }
}
