-- Mine Fleet GIS schema (PostgreSQL + PostGIS)
-- Reconstructed from the queries in server.js. Safe to run on an existing database:
-- every statement uses IF NOT EXISTS, so it only adds what is missing.
--   psql "$DATABASE_URL" -f schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Core fleet tables ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id   text PRIMARY KEY,
  vehicle_type text DEFAULT 'truck',
  source       text DEFAULT 'telematics'          -- simulated | phone | telematics
);

CREATE TABLE IF NOT EXISTS vehicle_tracks (
  id         bigserial PRIMARY KEY,
  vehicle_id text NOT NULL REFERENCES vehicles(vehicle_id),
  ts         timestamptz NOT NULL,
  speed_kmph real DEFAULT 0,
  sats       int,
  good_fix   boolean DEFAULT true,                -- false when satellites < 8
  moving     boolean DEFAULT false,               -- speed >= 2 km/h
  geom       geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicle_tracks_vts_idx ON vehicle_tracks (vehicle_id, ts);
CREATE INDEX IF NOT EXISTS vehicle_tracks_ts_idx  ON vehicle_tracks (ts);
CREATE INDEX IF NOT EXISTS vehicle_tracks_geom_idx ON vehicle_tracks USING gist (geom);

CREATE TABLE IF NOT EXISTS vehicle_stops (
  id         bigserial PRIMARY KEY,
  vehicle_id text NOT NULL REFERENCES vehicles(vehicle_id),
  start_ts   timestamptz NOT NULL,
  end_ts     timestamptz NOT NULL,
  minutes    real,
  label      text,
  zone_type  text,                                -- pit | dump | workshop | parking | NULL (outside)
  status     text,                                -- loading_dumping | queueing | idle | short_stop | maintenance | parked
  geom       geometry(Point, 4326)
);
CREATE INDEX IF NOT EXISTS vehicle_stops_vts_idx ON vehicle_stops (vehicle_id, start_ts);

-- ── Mine geometry ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zones (
  id        serial PRIMARY KEY,
  name      text,
  zone_type text,                                 -- pit | dump | workshop | parking
  geom      geometry(Geometry, 4326)
);
CREATE INDEX IF NOT EXISTS zones_geom_idx ON zones USING gist (geom);

CREATE TABLE IF NOT EXISTS haul_roads (
  id   serial PRIMARY KEY,
  name text,
  geom geometry(Geometry, 4326)                   -- LineString / MultiLineString
);
CREATE INDEX IF NOT EXISTS haul_roads_geom_idx ON haul_roads USING gist (geom);

CREATE TABLE IF NOT EXISTS lease_boundary (
  id       serial PRIMARY KEY,
  name     text,
  buffer_m real,
  geom     geometry(Geometry, 4326)
);

-- ── Events and other modules ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blast_events (
  id        serial PRIMARY KEY,
  ts        timestamptz,
  charge_kg real,
  geom      geometry(Point, 4326)
);

CREATE TABLE IF NOT EXISTS alerts (               -- machine-written alerts (e.g. from ml/fleet_ml.py)
  id         serial PRIMARY KEY,
  ts         timestamptz DEFAULT now(),
  alert_type text,
  message    text,
  status     text DEFAULT 'new',
  geom       geometry(Point, 4326)
);

CREATE TABLE IF NOT EXISTS water_levels   (id serial PRIMARY KEY, ts timestamptz DEFAULT now(), data jsonb);
CREATE TABLE IF NOT EXISTS dewatering_log (id serial PRIMARY KEY, ts timestamptz DEFAULT now(), data jsonb);
CREATE TABLE IF NOT EXISTS volume_changes (id serial PRIMARY KEY, ts timestamptz DEFAULT now(), data jsonb);

-- ── New: supervisor review of alerts (follow up / not relevant / field check) ─
-- alert_key is stable: 'stop:<vehicle>:<start epoch>' for derived alerts, 'alert:<id>' for stored ones.
CREATE TABLE IF NOT EXISTS alert_reviews (
  alert_key   text PRIMARY KEY,
  decision    text NOT NULL CHECK (decision IN ('follow_up', 'not_relevant', 'field_check')),
  note        text,
  reviewed_by text,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

-- ── New: results of the machine-learning checks (ml/fleet_ml.py) ─────────────
CREATE TABLE IF NOT EXISTS ml_flags (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,                       -- slow_trip | unusual_stop
  vehicle_id text,
  ts         timestamptz,
  score      real,
  detail     jsonb,
  geom       geometry(Point, 4326),
  UNIQUE (kind, vehicle_id, ts)
);
