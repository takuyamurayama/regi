package jp.regi.pos

import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset

data class SaleLine(
    val productId: String,
    val name: String,
    val quantity: Int,
    val price: String,
    val discount: String,
    val rateBps: Int,
    val cost: String,
    val stockManaged: Boolean,
    val taxContext: String = "master",
)

data class PaidLine(
    val input: SaleLine,
    val net: String,
    val allocatedDiscount: String,
    val paid: String,
    val unitRefunds: List<String>,
)

data class TaxTotal(val rateBps: Int, val base: String, val tax: String, val paid: String)

data class Total(val total: String, val lines: List<PaidLine>, val taxes: List<TaxTotal>)

object Money {
    const val ruleVersion = "regi-1"

    fun value(input: String): BigInteger {
        require(input.matches(Regex("^(0|[1-9][0-9]{0,29})$")))
        return BigInteger(input)
    }

    fun allocate(total: BigInteger, weights: List<BigInteger>): List<BigInteger> {
        require(total.signum() >= 0 && weights.all { it.signum() >= 0 })
        val sum = weights.fold(BigInteger.ZERO, BigInteger::add)
        if (sum == BigInteger.ZERO) {
            require(total == BigInteger.ZERO)
            return weights.map { BigInteger.ZERO }
        }
        val result = weights.map { total * it / sum }.toMutableList()
        var remaining = total - result.fold(BigInteger.ZERO, BigInteger::add)
        val order =
            weights.indices.sortedWith(
                compareByDescending<Int> { total * weights[it] % sum }.thenBy { it }
            )
        for (index in order) {
            if (remaining <= BigInteger.ZERO) break
            result[index] += BigInteger.ONE
            remaining--
        }
        return result
    }

    fun calculate(lines: List<SaleLine>, discount: String, mode: String): Total {
        require(lines.isNotEmpty() && lines.size <= 500 && mode in listOf("inclusive", "exclusive"))
        val net =
            lines.map { line ->
                require(line.quantity in 1..10000 && line.rateBps in 0..10000)
                value(line.cost)
                val gross = value(line.price) * line.quantity.toBigInteger()
                val reduction = value(line.discount)
                require(reduction <= gross)
                gross - reduction
            }
        val reduction = value(discount)
        require(reduction <= net.fold(BigInteger.ZERO, BigInteger::add))
        val allocated = allocate(reduction, net)
        val bases = net.indices.map { net[it] - allocated[it] }
        val paid = bases.toMutableList()
        val taxes =
            lines
                .map { it.rateBps }
                .distinct()
                .map { rate ->
                    val indexes = lines.indices.filter { lines[it].rateBps == rate }
                    val base = indexes.fold(BigInteger.ZERO) { sum, index -> sum + bases[index] }
                    val tax =
                        base * rate.toBigInteger() /
                            (if (mode == "inclusive") 10000 + rate else 10000).toBigInteger()
                    if (mode == "exclusive") {
                        val shares = allocate(tax, indexes.map { bases[it] })
                        indexes.forEachIndexed { position, index ->
                            paid[index] += shares[position]
                        }
                    }
                    TaxTotal(
                        rate,
                        base.toString(),
                        tax.toString(),
                        (if (mode == "inclusive") base else base + tax).toString(),
                    )
                }
        return Total(
            paid.fold(BigInteger.ZERO, BigInteger::add).toString(),
            lines.indices.map { index ->
                PaidLine(
                    lines[index],
                    net[index].toString(),
                    allocated[index].toString(),
                    paid[index].toString(),
                    allocate(paid[index], List(lines[index].quantity) { BigInteger.ONE }).map {
                        it.toString()
                    },
                )
            },
            taxes,
        )
    }

    fun businessDate(instant: String): String =
        Instant.parse(instant)
            .plusSeconds(4 * 3600)
            .atOffset(ZoneOffset.UTC)
            .toLocalDate()
            .toString()

    fun offlineAllowed(
        now: Instant,
        issued: Instant,
        authUntil: Instant,
        contractUntil: Instant,
    ): Boolean =
        !now.isBefore(issued) &&
            now.isBefore(authUntil) &&
            now.isBefore(contractUntil) &&
            now.epochSecond - issued.epochSecond <= 72 * 3600
}
