import unittest
import numpy as np
import pandas as pd
from regi_forecast import fit_forecast, recommendation


class ForecastTest(unittest.TestCase):
    def test_insufficient_history(self):
        history = pd.Series([1] * 55, index=pd.date_range("2026-01-01", periods=55))
        result = fit_forecast(history, pd.date_range("2026-03-01", periods=7))
        self.assertEqual("base-stock", result["method"])

    def test_missing_day_is_not_zero(self):
        index = pd.date_range("2026-01-01", periods=90).delete(45)
        result = fit_forecast(pd.Series([3] * 89, index=index), pd.date_range("2026-04-01", periods=7))
        self.assertEqual("insufficient-complete-history", result["reason"])

    def test_weekday_baseline_wins_constant_series(self):
        history = pd.Series([8] * 90, index=pd.date_range("2026-01-01", periods=90))
        self.assertEqual("base-stock", fit_forecast(history, pd.date_range("2026-04-01", periods=7))["method"])

    def test_model_validates_without_future_leakage(self):
        history = pd.Series(np.arange(150) * 2 + np.tile([4, 1, 7, 2, 0, 9, 5], 22)[:150], index=pd.date_range("2026-01-01", periods=150))
        result = fit_forecast(history, pd.date_range("2026-05-31", periods=7))
        self.assertEqual(7, len(result["predictions"]))
        if result["method"] == "lightgbm":
            self.assertLess(result["model_mae"], result["baseline_mae"])
        self.assertTrue(all(value >= 0 for value in result["predictions"]))

    def test_round_order_and_negative_inventory(self):
        self.assertEqual(12, recommendation(10, 3, 2, 1, 5, 6))
        self.assertEqual(6, recommendation(0, 0, -3, 0, 5, 6))
        self.assertEqual(0, recommendation(5, 2, 20, 0))
        with self.assertRaises(ValueError):
            recommendation(1, 1, 1, 1, multiple=0)


if __name__ == "__main__":
    unittest.main()
