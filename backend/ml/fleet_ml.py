#!/usr/bin/env python3
"""
fleet_ml.py — two machine-learning checks for the fleet module (run it after a shift, or on a schedule).

  1. SLOW TRIPS     Random Forest learns how long a pit -> dump haul normally takes (given distance,
                    truck and hour of day). A trip is flagged when it took much longer than expected.
  2. UNUSUAL STOPS  Isolation Forest looks at all stops (duration, zone, hour) and flags the ones that
                    do not look like the rest AND are long for their zone.

Both are only trained when there is enough data (MIN_TRIPS / MIN_STOPS) — with less, the script says so
and does nothing, instead of guessing. Flags are saved to ml_flags and also written to the alerts table,
so they show up in the dashboard's Alerts tab where a supervisor can review them.

Reads trips/stops from the API (same definitions as the dashboard; it signs in with APP_USER / APP_PASSWORD),
writes flags to the database.

  pip install -r ml/requirements.txt
  python ml/fleet_ml.py              # analyse the last 24 h of data
  python ml/fleet_ml.py --hours 72 --dry-run
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestRegressor
from sklearn.model_selection import KFold, cross_val_predict

try:                                  # read ../.env so APP_USER, DATABASE_URL etc. do not need exporting
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except ImportError:
    pass

API_URL = os.environ.get("API_URL", "http://localhost:3001/api")
DATABASE_URL = os.environ.get("DATABASE_URL")
TZ_OFFSET_H = float(os.environ.get("SHIFT_TZ_OFFSET_MIN", 330)) / 60
MIN_TRIPS = int(os.environ.get("ML_MIN_TRIPS", 30))
MIN_STOPS = int(os.environ.get("ML_MIN_STOPS", 50))
SLOW_SIGMA = float(os.environ.get("ML_SLOW_SIGMA", 3.0))     # flag when this many robust std-devs slower than expected
SLOW_MIN_EXTRA_MIN = float(os.environ.get("ML_SLOW_MIN_EXTRA_MIN", 3.0))  # ...and at least this many minutes slower
CONTAMINATION = float(os.environ.get("ML_CONTAMINATION", 0.05))
SEED = 42


_token = None


def login_token():
    """The API needs a login. Uses API_TOKEN if set, otherwise signs in with APP_USER / APP_PASSWORD."""
    global _token
    if _token:
        return _token
    if os.environ.get("API_TOKEN"):
        _token = os.environ["API_TOKEN"]
        return _token
    user, pw = os.environ.get("APP_USER"), os.environ.get("APP_PASSWORD")
    if not user or not pw:
        sys.exit("The API needs a login: set APP_USER and APP_PASSWORD (same as in .env), or API_TOKEN.")
    req = urllib.request.Request(f"{API_URL}/login", data=json.dumps({"username": user, "password": pw}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            _token = json.load(r)["token"]
    except urllib.error.HTTPError as e:
        sys.exit(f"Login failed ({e.code}): check APP_USER / APP_PASSWORD")
    return _token


def get_json(path):
    req = urllib.request.Request(f"{API_URL}{path}", headers={"Authorization": f"Bearer {login_token()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def local_hour(series):
    t = pd.to_datetime(series, utc=True)
    return ((t.dt.hour + t.dt.minute / 60 + TZ_OFFSET_H) % 24).astype(float)


# ── 1. slow trips ────────────────────────────────────────────────────────────
def slow_trips(hours):
    trips = pd.DataFrame(get_json(f"/trips?hours={hours}"))
    if len(trips) < MIN_TRIPS:
        print(f"[slow trips] only {len(trips)} trips in the last {hours} h (need {MIN_TRIPS}) — not trained.")
        return []
    trips = trips.dropna(subset=["haul_min", "haul_km"]).reset_index(drop=True)
    trips["hour"] = local_hour(trips["pit_arrive"])
    trips["truck"] = trips["vehicle_id"].astype("category").cat.codes
    X = trips[["haul_km", "hour", "truck"]].to_numpy()
    y = trips["haul_min"].to_numpy()

    model = RandomForestRegressor(n_estimators=200, min_samples_leaf=3, random_state=SEED)
    # predictions for each trip come from models that never saw that trip (5-fold), so a slow trip
    # cannot "teach" the model that slow is normal
    expected = cross_val_predict(model, X, y, cv=KFold(5, shuffle=True, random_state=SEED))
    resid = y - expected
    mad = np.median(np.abs(resid - np.median(resid)))
    spread = max(1.4826 * mad, 0.5)                      # robust std-dev, never below 30 s
    trips["expected_min"] = expected
    trips["extra_min"] = resid
    trips["score"] = resid / spread
    bad = trips[(trips["score"] >= SLOW_SIGMA) & (trips["extra_min"] >= SLOW_MIN_EXTRA_MIN)]
    print(f"[slow trips] {len(trips)} trips, typical error ±{spread:.1f} min, {len(bad)} flagged.")
    flags = []
    for _, r in bad.iterrows():
        flags.append({
            "kind": "slow_trip", "vehicle_id": r["vehicle_id"], "ts": r["pit_arrive"], "score": float(r["score"]),
            "geom_from": ("dump", r["dump_arrive"]),
            "detail": {"haul_min": float(r["haul_min"]), "expected_min": round(float(r["expected_min"]), 1),
                       "extra_min": round(float(r["extra_min"]), 1), "haul_km": float(r["haul_km"])},
            "message": f"{r['vehicle_id']} haul took {r['haul_min']:.1f} min, about {r['extra_min']:.1f} min "
                       f"longer than expected ({r['expected_min']:.1f} min)",
        })
    return flags


# ── 2. unusual stops ─────────────────────────────────────────────────────────
def unusual_stops(hours):
    fc = get_json(f"/vehicle_stops?hours={hours}")
    rows = []
    for f in fc["features"]:
        p = f["properties"]
        c = (f.get("geometry") or {}).get("coordinates") or [None, None]
        rows.append({**p, "lon": c[0], "lat": c[1]})
    stops = pd.DataFrame(rows)
    if len(stops) < MIN_STOPS:
        print(f"[unusual stops] only {len(stops)} stops in the last {hours} h (need {MIN_STOPS}) — not trained.")
        return []
    stops["zone"] = stops["zone_type"].fillna("outside")
    stops["hour"] = local_hour(stops["start_ts"])
    stops["minutes"] = stops["minutes"].astype(float)
    X = pd.get_dummies(stops["zone"]).astype(float)
    X["log_min"] = np.log1p(stops["minutes"])
    X["hour_sin"] = np.sin(2 * np.pi * stops["hour"] / 24)
    X["hour_cos"] = np.cos(2 * np.pi * stops["hour"] / 24)

    iso = IsolationForest(n_estimators=300, contamination=CONTAMINATION, random_state=SEED).fit(X)
    stops["anomaly"] = -iso.score_samples(X)             # higher = stranger
    stops["odd"] = iso.predict(X) == -1
    median_by_zone = stops.groupby("zone")["minutes"].transform("median")
    # only stops that are odd AND clearly longer than usual for their zone (a very short stop is not a problem)
    # parking and workshop stops are planned, so they are never flagged
    bad = stops[stops["odd"] & (stops["minutes"] > 1.5 * median_by_zone) & ~stops["zone"].isin(["parking", "workshop"])]
    print(f"[unusual stops] {len(stops)} stops, {int(stops['odd'].sum())} odd, {len(bad)} flagged as unusually long.")
    flags = []
    for _, r in bad.iterrows():
        flags.append({
            "kind": "unusual_stop", "vehicle_id": r["vehicle_id"], "ts": r["start_ts"], "score": float(r["anomaly"]),
            "geom_xy": (r["lon"], r["lat"]),
            "detail": {"minutes": round(float(r["minutes"]), 1), "zone": r["zone"],
                       "zone_median_min": round(float(median_by_zone[_]), 1)},
            "message": f"{r['vehicle_id']} stopped {r['minutes']:.1f} min "
                       f"({'outside work zones' if r['zone'] == 'outside' else 'at the ' + r['zone']}), "
                       f"unusual vs the typical {median_by_zone[_]:.1f} min",
        })
    return flags


# ── save ─────────────────────────────────────────────────────────────────────
def save(flags):
    import psycopg2
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is not set")
    conn = psycopg2.connect(DATABASE_URL)
    new = 0
    with conn, conn.cursor() as cur:
        for f in flags:
            xy = f.get("geom_xy")
            if not xy and f.get("geom_from"):
                cur.execute("SELECT ST_X(geom), ST_Y(geom) FROM vehicle_stops WHERE vehicle_id = %s AND start_ts = %s",
                            (f["vehicle_id"], f["geom_from"][1]))
                row = cur.fetchone()
                xy = row if row else None
            pt = "ST_SetSRID(ST_MakePoint(%s, %s), 4326)" if xy else "NULL"
            params = [f["kind"], f["vehicle_id"], f["ts"], f["score"], json.dumps(f["detail"])] + (list(xy) if xy else [])
            cur.execute(f"""INSERT INTO ml_flags (kind, vehicle_id, ts, score, detail, geom)
                            VALUES (%s, %s, %s, %s, %s, {pt}) ON CONFLICT (kind, vehicle_id, ts) DO NOTHING RETURNING id""", params)
            if cur.fetchone():
                new += 1
                aparams = [f["kind"], f["message"], f["ts"]] + (list(xy) if xy else [])
                cur.execute(f"""INSERT INTO alerts (alert_type, message, ts, status, geom)
                                VALUES (%s, %s, %s, 'new', {pt})""", aparams)
    conn.close()
    print(f"saved {new} new flag(s) ({len(flags) - new} already known).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, default=24, help="how far back to look (from the newest GPS time)")
    ap.add_argument("--dry-run", action="store_true", help="show what would be flagged, save nothing")
    a = ap.parse_args()
    flags = slow_trips(a.hours) + unusual_stops(a.hours)
    for f in flags:
        print("  -", f["message"])
    if flags and not a.dry_run:
        save(flags)


if __name__ == "__main__":
    main()
