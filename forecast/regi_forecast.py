import argparse
import hashlib
import json
import math
import os
from datetime import date, datetime, timedelta, timezone

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg


def recommendation(demand, safety_stock, on_hand, outstanding, minimum=1, multiple=1):
    if any(not math.isfinite(float(value)) for value in [demand, safety_stock, on_hand, outstanding]):
        raise ValueError("Non-finite inventory input")
    if minimum < 1 or multiple < 1 or outstanding < 0 or safety_stock < 0 or demand < 0:
        raise ValueError("Invalid order policy")
    needed = max(0, math.ceil(demand + safety_stock - on_hand - outstanding))
    return 0 if needed == 0 else math.ceil(max(minimum, needed) / multiple) * multiple


def features(history):
    frame = pd.DataFrame({"quantity": history.astype(float)})
    frame["weekday"] = frame.index.dayofweek
    frame["lag1"] = frame.quantity.shift(1)
    frame["lag7"] = frame.quantity.shift(7)
    frame["mean7"] = frame.quantity.shift(1).rolling(7).mean()
    frame["trend"] = np.arange(len(frame))
    return frame.dropna()


def weekday_predict(training, days):
    means = training.groupby(training.index.dayofweek).mean()
    return np.array([float(means.get(day.dayofweek, training.mean())) for day in days])


def fit_forecast(history, days, base_stock=0):
    history = history.sort_index()
    if history.index.has_duplicates or history.isna().any() or (history < 0).any():
        raise ValueError("Only complete, unique nonnegative business days may be trained")
    if len(history) < 56 or any((history.index[index] - history.index[index - 1]).days != 1 for index in range(1, len(history))):
        return {"method": "base-stock", "predictions": [0.0] * len(days), "base_stock": base_stock, "reason": "insufficient-complete-history"}
    if (days[0] - history.index[-1]).days > 2 or days[0] <= history.index[-1]:
        return {"method": "base-stock", "predictions": [0.0] * len(days), "base_stock": base_stock, "reason": "stale-complete-history"}
    training, validation = history.iloc[:-14], history.iloc[-14:]
    frame = features(training)
    columns = ["weekday", "lag1", "lag7", "mean7", "trend"]
    model = lgb.LGBMRegressor(n_estimators=80, num_leaves=7, learning_rate=0.05, min_child_samples=7, verbosity=-1, random_state=7391, n_jobs=1)
    model.fit(frame[columns], frame.quantity)
    extended = training.copy()
    predicted = []
    for day in validation.index:
        extended.loc[day] = 0.0
        value = max(0.0, float(model.predict(features(extended)[columns].tail(1))[0]))
        extended.loc[day] = value
        predicted.append(value)
    baseline = weekday_predict(training, validation.index)
    model_error = float(np.mean(np.abs(validation.values - predicted)))
    baseline_error = float(np.mean(np.abs(validation.values - baseline)))
    if model_error >= baseline_error:
        return {"method": "base-stock", "predictions": [0.0] * len(days), "base_stock": base_stock, "reason": "model-not-better-than-weekday", "model_mae": model_error, "baseline_mae": baseline_error}
    full = features(history)
    model.fit(full[columns], full.quantity)
    extended = history.copy()
    predictions = []
    for day in pd.date_range(history.index[-1] + timedelta(days=1), days[-1]):
        extended.loc[day] = 0.0
        value = max(0.0, float(model.predict(features(extended)[columns].tail(1))[0]))
        extended.loc[day] = value
        if day in days:
            predictions.append(value)
    return {"method": "lightgbm", "predictions": predictions, "model_mae": model_error, "baseline_mae": baseline_error}


def run(tenant_id, store_id):
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('regi.tenant',%s,true),set_config('regi.stores',%s,true),set_config('regi.all_stores','false',true)", (tenant_id, store_id))
            cursor.execute("SELECT id FROM stores WHERE id=%s", (store_id,))
            if cursor.fetchone() is None:
                raise ValueError("Store outside tenant scope")
            cursor.execute("SELECT body->>'day' FROM documents WHERE kind='day-close' AND status='confirmed' AND store_id=%s ORDER BY body->>'day'", (store_id,))
            complete_days = [pd.Timestamp(entry[0]) for entry in cursor.fetchall()]
            cursor.execute("SELECT id FROM products WHERE active AND stock_managed")
            products = [entry[0] for entry in cursor.fetchall()]
            cursor.execute("SELECT body FROM documents WHERE kind='sale' AND store_id=%s", (store_id,))
            sales = cursor.fetchall()
            totals = {}
            for (sale,) in sales:
                for line in sale["lines"]:
                    key = (line["productId"], sale["businessDate"])
                    totals[key] = totals.get(key, 0) + line["quantity"]
            generated = datetime.now(timezone.utc)
            next_day = (generated + timedelta(hours=4)).date() + timedelta(days=1)
            days = pd.date_range(next_day, periods=7)
            for product in products:
                history = pd.Series([totals.get((str(product), day.strftime("%Y-%m-%d")), 0) for day in complete_days], index=pd.DatetimeIndex(complete_days), dtype=float)
                result = fit_forecast(history, days)
                version = hashlib.sha256(json.dumps({"tenant": tenant_id, "product": str(product), "history": history.tolist(), "method": result["method"]}).encode()).hexdigest()[:16]
                for day, quantity in zip(days, result["predictions"]):
                    cursor.execute("INSERT INTO forecasts VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,store_id,product_id,day) DO UPDATE SET quantity=excluded.quantity,method=excluded.method,model_version=excluded.model_version,trained_from=excluded.trained_from,trained_to=excluded.trained_to,generated_at=excluded.generated_at", (tenant_id, store_id, product, day.date(), quantity, result["method"], version, complete_days[0].date() if complete_days else None, complete_days[-1].date() if complete_days else None, generated))
            return {"products": len(products), "complete_days": len(complete_days), "generated_at": generated.isoformat()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--store", required=True)
    arguments = parser.parse_args()
    print(json.dumps(run(arguments.tenant, arguments.store)))
