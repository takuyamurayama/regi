package jp.regi.pos

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import java.io.File
import java.math.BigInteger
import java.util.Random

class MoneyTest {
 @Test fun sharedFixtures() {
  val fixtures = JSONArray(File("../../tests/fixtures/money.json").readText())
  for (index in 0 until fixtures.length()) {
   val fixture = fixtures.getJSONObject(index); val entries = fixture.getJSONArray("lines")
   val lines = (0 until entries.length()).map { position -> val line = entries.getJSONObject(position); SaleLine(line.getString("productId"), line.getString("name"), line.getInt("quantity"), line.getString("price"), line.getString("discount"), line.getInt("rateBps"), line.getString("cost"), line.getBoolean("stockManaged")) }
   val result = Money.calculate(lines, fixture.getString("discount"), fixture.getString("mode"))
   assertEquals(fixture.getString("total"), result.total)
   result.lines.forEachIndexed { position, line -> assertEquals(fixture.getJSONArray("paid").getString(position), line.paid) }
   result.taxes.forEachIndexed { position, tax -> assertEquals(fixture.getJSONArray("tax").getString(position), tax.tax) }
  }
 }
 @Test fun tenThousandConservationCases() {
  val random = Random(7391)
  repeat(10000) {
   val lines = List(1 + random.nextInt(10)) { index -> SaleLine(index.toString(), "商品", 1 + random.nextInt(10), random.nextInt(100000).toString(), "0", listOf(0, 800, 1000, 1200)[random.nextInt(4)], "0", true) }
   val sum = lines.fold(BigInteger.ZERO) { total, line -> total + Money.value(line.price) * line.quantity.toBigInteger() }
   val discount = (random.nextDouble() * sum.toDouble()).toLong().toString()
   val result = Money.calculate(lines, discount, if (random.nextBoolean()) "inclusive" else "exclusive")
   assertEquals(BigInteger(result.total), result.lines.fold(BigInteger.ZERO) { total, line -> total + BigInteger(line.paid) })
   assertEquals(BigInteger(discount), result.lines.fold(BigInteger.ZERO) { total, line -> total + BigInteger(line.allocatedDiscount) })
   result.lines.forEach { line -> assertEquals(BigInteger(line.paid), line.unitRefunds.fold(BigInteger.ZERO) { total, value -> total + BigInteger(value) }) }
  }
 }
 @Test fun businessBoundary() { assertEquals("2026-09-30", Money.businessDate("2026-09-30T19:59:59Z")); assertEquals("2026-10-01", Money.businessDate("2026-09-30T20:00:00Z")) }
}
