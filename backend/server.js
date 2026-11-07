/**
 * Mine Fleet GIS — Express/PostGIS API Server (patched)
 * Serves spatial tables as GeoJSON for the MapLibre frontend.
 *
 * Changes from the original:
 *  - Time windows are anchored to the newest GPS time in the database (not NOW()),
 *    so simulated / replayed data shows up.
 *  - /api/vehicles/latest returns vehicle_type and a zone-aware status
 *    (moving, loading_dumping, queueing, maintenance, parked, idle, short_stop, offline),
 *    and accepts ?at=ISO_TIME for replay and ?source=simulated|phone|telematics.
 *  - /api/alerts is built from idle / queueing stops (plus any rows in the alerts table).
 *  - /api/stats counts real alerts and statuses.
 *  - New: /api/kpis, /api/time-range, POST /api/gps (live ingestion).
 *  - /api/lease_boundary falls back to the extent of zones + haul roads when no lease exists.
 *  - Hours are clamped, errors are hidden in production.
 *
 * Fleet-management additions:
 *  - Stops are built automatically from GPS (lib/stops.js) every STOP_DETECT_INTERVAL_S seconds.
 *  - /api/trips, /api/shift_summary, /api/hotspots (lib/analytics.js); /api/kpis now has cycle time,
 *    route efficiency and time loss.
 *  - Alert review: POST /api/alerts/review marks an alert follow_up / not_relevant / field_check.
 *  - Optional GPS_API_KEY protects POST /api/gps.
 *  - Login: POST /api/login gives a 12-hour token; every other route needs it (except /health and /gps).
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const { OFFLINE_MIN, MIN_SATS, IDLE_BURN_L_PER_H, num, statusAt } = require('./lib/rules');
const { detectStops } = require('./lib/stops');
const { getTrips, getShiftSummary, getHotspots } = require('./lib/analytics');

const app  = express();
const PORT = process.env.PORT || 3001;

// Rules (IDLE_MIN, LOAD_MAX_MIN, OFFLINE_MIN, MIN_SATS, ...) live in lib/rules.js and can be set in .env

// ─── Database pool ───────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('[DB] ❌ Cannot connect to PostgreSQL:', err.message);
    console.error('     Check your DATABASE_URL in .env');
  } else {
    console.log('[DB] ✅ Connected to PostgreSQL at', res.rows[0].now);
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// ─── Login: one account from .env, signed 12-hour token ───────────────────────
const crypto = require('crypto');
const APP_USER     = process.env.APP_USER     || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';
const APP_SECRET   = process.env.APP_SECRET   || crypto.randomBytes(32).toString('hex');
const sign   = body => crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
if (!process.env.APP_PASSWORD) console.warn('[Auth] APP_PASSWORD not set in .env, using the demo password');

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!safeEq(username || '', APP_USER) | !safeEq(password || '', APP_PASSWORD))
    return res.status(401).json({ error: 'Wrong username or password' });
  const body = Buffer.from(JSON.stringify({ u: APP_USER, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  res.json({ token: body + '.' + sign(body), user: APP_USER });
});

// every other /api route needs a valid token (health check and the device endpoint stay open)
app.use('/api', (req, res, next) => {
  if (['/health', '/login', '/gps'].includes(req.path)) return next();
  const [body, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  try {
    if (body && sig && safeEq(sig, sign(body)) && JSON.parse(Buffer.from(body, 'base64url')).exp > Date.now()) return next();
  } catch (e) { /* fall through */ }
  res.status(401).json({ error: 'Login required' });
});
if (process.env.NODE_ENV !== 'production') app.set('json spaces', 2);
if (process.env.NODE_ENV !== 'production') app.set('json spaces', 2);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toFeatureCollection(rows) {
  return {
    type: 'FeatureCollection',
    features: rows.map(row => {
      const { geometry, ...props } = row;
      return {
        type: 'Feature',
        geometry: typeof geometry === 'string' ? JSON.parse(geometry) : geometry,
        properties: props,
      };
    }),
  };
}

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Newest GPS time in the DB. Windows are measured back from here, so replayed data works. */
const ANCHOR = `(SELECT COALESCE(MAX(ts), NOW()) FROM vehicle_tracks)`;

/** Hours from a query string, clamped to a sensible range. */
function clampHours(value, fallback) {
  const h = parseFloat(value);
  return Math.min(Math.max(Number.isFinite(h) && h > 0 ? h : fallback, 0.05), 720);
}

/** ?source=simulated (or phone / telematics). Empty = all sources. */
const sourceOf = req => (String(req.query.source || '').trim() || null);

/** Every vehicle's last good fix at a time, with a zone-aware status. */
async function vehiclesAt(at, source) {
  const atTs = (await pool.query(`SELECT COALESCE($1::timestamptz, ${ANCHOR}) AS at`, [at || null])).rows[0].at;

  const last = await pool.query(`
    SELECT DISTINCT ON (t.vehicle_id)
      t.vehicle_id, v.vehicle_type, v.source,
      t.ts, t.speed_kmph, t.sats, t.good_fix, t.moving,
      ST_AsGeoJSON(t.geom)::json AS geometry
    FROM vehicle_tracks t
    JOIN vehicles v USING (vehicle_id)
    WHERE t.good_fix = true AND t.ts <= $1 AND ($2::text IS NULL OR v.source = $2)
    ORDER BY t.vehicle_id, t.ts DESC
  `, [atTs, source]);

  const open = await pool.query(`
    SELECT DISTINCT ON (s.vehicle_id)
      s.vehicle_id, s.zone_type,
      EXTRACT(EPOCH FROM ($1::timestamptz - s.start_ts)) / 60 AS so_far
    FROM vehicle_stops s
    JOIN vehicles v USING (vehicle_id)
    WHERE s.start_ts <= $1 AND s.end_ts >= $1 AND ($2::text IS NULL OR v.source = $2)
    ORDER BY s.vehicle_id, s.start_ts DESC
  `, [atTs, source]);
  const openByVehicle = Object.fromEntries(open.rows.map(r => [r.vehicle_id, r]));

  const rows = last.rows.map(r => {
    const gapMin = (new Date(atTs) - new Date(r.ts)) / 60000;
    const stop = openByVehicle[r.vehicle_id];
    let status, stopMinutes = null;
    if (gapMin > OFFLINE_MIN) {
      status = 'offline';
    } else if (stop) {
      stopMinutes = Math.round(parseFloat(stop.so_far) * 10) / 10;
      status = statusAt(stop.zone_type, parseFloat(stop.so_far));
    } else {
      status = r.moving ? 'moving' : 'short_stop';
    }
    return { ...r, status, stop_minutes: stopMinutes };
  });
  return { at: atTs, rows };
}

/** Alerts = idle / queueing stops + rows in the alerts table (e.g. ML flags), with the supervisor's review.
 *  Each alert has a stable alert_key, so a review survives stops being rebuilt. */
const DECISIONS = ['follow_up', 'not_relevant', 'field_check'];

async function getAlerts(hours, source) {
  const derived = await pool.query(`
    SELECT s.id, s.vehicle_id, s.start_ts AS ts, EXTRACT(EPOCH FROM s.start_ts)::bigint AS epoch,
           s.status AS alert_type, s.zone_type, ROUND(s.minutes::numeric, 1) AS minutes,
           ST_AsGeoJSON(s.geom)::json AS geometry
    FROM vehicle_stops s
    JOIN vehicles v USING (vehicle_id)
    WHERE s.status IN ('idle', 'queueing')
      AND s.start_ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
      AND ($2::text IS NULL OR v.source = $2)
    ORDER BY s.start_ts DESC
    LIMIT 100
  `, [hours, source]);

  const fromStops = derived.rows.map(r => ({
    id: `stop:${r.vehicle_id}:${r.epoch}`,
    alert_key: `stop:${r.vehicle_id}:${r.epoch}`,
    ts: r.ts,
    alert_type: r.alert_type,
    status: 'new',
    message: r.alert_type === 'idle'
      ? `${r.vehicle_id} idle for ${r.minutes} min outside any work zone`
      : `${r.vehicle_id} queueing for ${r.minutes} min at the ${r.zone_type}`,
    vehicle_id: r.vehicle_id,
    geometry: r.geometry,
  }));

  const stored = await pool.query(`
    SELECT id, ts, alert_type, message, status, ST_AsGeoJSON(geom)::json AS geometry
    FROM alerts
    WHERE ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
    ORDER BY ts DESC LIMIT 100
  `, [hours]);
  const fromTable = stored.rows.map(r => ({ ...r, id: `alert:${r.id}`, alert_key: `alert:${r.id}` }));

  const all = [...fromStops, ...fromTable]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 100);

  const reviews = all.length
    ? (await pool.query(`SELECT * FROM alert_reviews WHERE alert_key = ANY($1::text[])`, [all.map(a => a.alert_key)])).rows
    : [];
  const byKey = Object.fromEntries(reviews.map(r => [r.alert_key, r]));
  return all.map(a => {
    const r = byKey[a.alert_key];
    return r ? { ...a, status: r.decision, review_note: r.note, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at } : a;
  });
}

const isOpenAlert = a => ['new', 'active'].includes(a.status);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Vehicles registry ─────────────────────────────────────────────────────────
app.get('/api/vehicles', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT vehicle_id, vehicle_type, source FROM vehicles ORDER BY vehicle_id`
  );
  res.json(rows);
}));

// ── Latest GPS fix per vehicle + status  (?at=ISO for replay, ?source=...) ────
app.get('/api/vehicles/latest', asyncRoute(async (req, res) => {
  const { at, rows } = await vehiclesAt(req.query.at, sourceOf(req));
  res.json({ ...toFeatureCollection(rows), at });
}));

// ── First / last GPS time (for a replay slider) ───────────────────────────────
app.get('/api/time-range', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT MIN(t.ts) AS start, MAX(t.ts) AS "end"
    FROM vehicle_tracks t JOIN vehicles v USING (vehicle_id)
    WHERE ($1::text IS NULL OR v.source = $1)`, [sourceOf(req)]);
  res.json(rows[0]);
}));

// ── Fleet summary stats ───────────────────────────────────────────────────────
app.get('/api/stats', asyncRoute(async (req, res) => {
  const source = sourceOf(req);
  const [{ at, rows }, alerts, vehicleCount] = await Promise.all([
    vehiclesAt(req.query.at, source),
    getAlerts(48, source),
    pool.query(`SELECT COUNT(*) FROM vehicles WHERE ($1::text IS NULL OR source = $1)`, [source]),
  ]);
  const byStatus = {};
  rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  const live = rows.filter(r => r.status !== 'offline');
  const avg = live.length ? live.reduce((s, r) => s + (r.speed_kmph || 0), 0) / live.length : 0;
  res.json({
    moving:        byStatus.moving || 0,
    stopped:       live.length - (byStatus.moving || 0),
    offline:       byStatus.offline || 0,
    totalWithFix:  rows.length,
    totalVehicles: parseInt(vehicleCount.rows[0].count),
    avgSpeed:      Math.round(avg * 10) / 10,
    activeAlerts:  alerts.filter(isOpenAlert).length,   // reviewed alerts no longer count
    byStatus,
    lastUpdate:    rows.length ? rows.map(r => r.ts).sort().pop() : null,
    at,
  });
}));

// ── KPIs per vehicle  (?hours=N limits the window; default = everything) ──────
app.get('/api/kpis', asyncRoute(async (req, res) => {
  const source = sourceOf(req);
  const hours = req.query.hours ? clampHours(req.query.hours, 24) : 24 * 365;
  const { rows } = await pool.query(`
    SELECT v.vehicle_id,
      COALESCE(SUM(s.minutes) FILTER (WHERE s.status = 'idle'), 0)        AS idle_min,
      COALESCE(SUM(s.minutes) FILTER (WHERE s.status = 'queueing'), 0)    AS queue_min,
      COALESCE(SUM(s.minutes) FILTER (WHERE s.status = 'maintenance'), 0) AS maintenance_min,
      COUNT(*) FILTER (WHERE s.zone_type = 'dump')                        AS dump_visits
    FROM vehicles v
    LEFT JOIN vehicle_stops s ON s.vehicle_id = v.vehicle_id
                              AND s.start_ts > ${ANCHOR} - ($2::float8 * INTERVAL '1 hour')
    WHERE ($1::text IS NULL OR v.source = $1)
    GROUP BY v.vehicle_id ORDER BY v.vehicle_id`, [source, hours]);
  const dist = await pool.query(`
    SELECT vehicle_id, SUM(d) / 1000 AS km FROM (
      SELECT t.vehicle_id, t.moving, ST_Distance(t.geom::geography, t.prev::geography) AS d
      FROM (SELECT t.*, LAG(t.geom) OVER (PARTITION BY t.vehicle_id ORDER BY t.ts) AS prev
            FROM vehicle_tracks t JOIN vehicles v USING (vehicle_id)
            WHERE ($1::text IS NULL OR v.source = $1)
              AND t.ts > ${ANCHOR} - ($2::float8 * INTERVAL '1 hour')) t
    ) x WHERE moving GROUP BY vehicle_id`, [source, hours]);
  const km = Object.fromEntries(dist.rows.map(r => [r.vehicle_id, parseFloat(r.km) || 0]));

  const trips = await getTrips(pool, { hours, source });
  const perVehicle = {};
  trips.forEach(t => { (perVehicle[t.vehicle_id] ||= []).push(t); });
  const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null);

  res.json(rows.map(r => {
    const idle = parseFloat(r.idle_min), queue = parseFloat(r.queue_min);
    const t = perVehicle[r.vehicle_id] || [];
    return {
      vehicle_id: r.vehicle_id,
      // completed pit → dump hauls; falls back to counting dump visits when no pit zone exists
      trips: t.length || parseInt(r.dump_visits),
      avg_cycle_min: avg(t.map(x => x.cycle_min).filter(x => x !== null)),
      avg_route_efficiency: avg(t.map(x => x.route_efficiency).filter(x => x !== null)),
      distance_km: Math.round((km[r.vehicle_id] || 0) * 10) / 10,
      idle_min: Math.round(idle * 10) / 10,
      queue_min: Math.round(queue * 10) / 10,
      maintenance_min: Math.round(parseFloat(r.maintenance_min) * 10) / 10,
      time_loss_min: Math.round((idle + queue) * 10) / 10,                     // idle + queueing
      fuel_loss_l: Math.round((idle + queue) / 60 * IDLE_BURN_L_PER_H * 10) / 10, // estimate: engine runs while waiting
    };
  }));
}));

// ── Trips: pit → dump hauls with cycle time and route efficiency ──────────────
app.get('/api/trips', asyncRoute(async (req, res) => {
  res.json(await getTrips(pool, {
    hours: clampHours(req.query.hours, 24), source: sourceOf(req), vehicleId: req.query.vehicle_id || null }));
}));

// ── Per-shift summary: trips, cycle time, idle / queue time, fuel loss ────────
app.get('/api/shift_summary', asyncRoute(async (req, res) => {
  res.json(await getShiftSummary(pool, { hours: clampHours(req.query.hours, 24), source: sourceOf(req) }));
}));

// ── Hotspots: where idling and queueing keep happening (GeoJSON points) ───────
app.get('/api/hotspots', asyncRoute(async (req, res) => {
  const rows = await getHotspots(pool, {
    hours: clampHours(req.query.hours, 24), source: sourceOf(req),
    minMinutes: Math.max(parseFloat(req.query.min_minutes) || 5, 0) });
  res.json(toFeatureCollection(rows));
}));

// ── Vehicle track points (time window, anchored to newest data) ───────────────
app.get('/api/tracks/:vehicle_id', asyncRoute(async (req, res) => {
  const hours = clampHours(req.query.hours, parseFloat(process.env.TRACK_HOURS) || 6);
  const { rows } = await pool.query(`
    SELECT id, vehicle_id, ts, speed_kmph, moving, sats, good_fix,
           ST_AsGeoJSON(geom)::json AS geometry
    FROM vehicle_tracks
    WHERE vehicle_id = $1
      AND ts > ${ANCHOR} - ($2::float8 * INTERVAL '1 hour')
      AND good_fix = true
    ORDER BY ts ASC
    LIMIT 20000
  `, [req.params.vehicle_id, hours]);
  res.json(toFeatureCollection(rows));
}));

// ── Vehicle track as LineString ───────────────────────────────────────────────
app.get('/api/tracks/:vehicle_id/line', asyncRoute(async (req, res) => {
  const hours = clampHours(req.query.hours, parseFloat(process.env.TRACK_HOURS) || 6);
  const { rows } = await pool.query(`
    SELECT
      $1::text AS vehicle_id,
      MIN(ts) AS start_ts,
      MAX(ts) AS end_ts,
      COUNT(*) AS point_count,
      ROUND(AVG(speed_kmph)::numeric, 1) AS avg_speed,
      ST_AsGeoJSON(ST_MakeLine(geom ORDER BY ts))::json AS geometry
    FROM vehicle_tracks
    WHERE vehicle_id = $1
      AND ts > ${ANCHOR} - ($2::float8 * INTERVAL '1 hour')
      AND good_fix = true
  `, [req.params.vehicle_id, hours]);

  if (!rows[0].geometry) return res.json({ type: 'FeatureCollection', features: [] });
  res.json({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: rows[0].geometry,
      properties: {
        vehicle_id:  rows[0].vehicle_id,
        start_ts:    rows[0].start_ts,
        end_ts:      rows[0].end_ts,
        point_count: parseInt(rows[0].point_count),
        avg_speed:   parseFloat(rows[0].avg_speed),
      },
    }],
  });
}));

// ── All recent tracks (overview), capped ──────────────────────────────────────
app.get('/api/tracks', asyncRoute(async (req, res) => {
  const hours = clampHours(req.query.hours, 1);
  const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
  const { rows } = await pool.query(`
    SELECT t.id, t.vehicle_id, t.ts, t.speed_kmph, t.moving,
           ST_AsGeoJSON(t.geom)::json AS geometry
    FROM vehicle_tracks t JOIN vehicles v USING (vehicle_id)
    WHERE t.ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
      AND t.good_fix = true AND ($2::text IS NULL OR v.source = $2)
    ORDER BY t.ts DESC
    LIMIT $3
  `, [hours, sourceOf(req), limit]);
  res.json(toFeatureCollection(rows.reverse()));
}));

// ── Zones ─────────────────────────────────────────────────────────────────────
app.get('/api/zones', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, zone_type, ST_AsGeoJSON(geom)::json AS geometry FROM zones ORDER BY id`);
  res.json(toFeatureCollection(rows));
}));

// ── Haul roads ────────────────────────────────────────────────────────────────
app.get('/api/haul_roads', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, ST_AsGeoJSON(geom)::json AS geometry FROM haul_roads ORDER BY id`);
  res.json(toFeatureCollection(rows));
}));

// ── Lease boundary (falls back to the extent of zones + haul roads) ───────────
app.get('/api/lease_boundary', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, name, buffer_m,
      ST_AsGeoJSON(geom)::json AS geometry,
      ST_AsGeoJSON(ST_Centroid(geom))::json AS centroid,
      ST_XMin(ST_Envelope(geom)) AS bbox_west, ST_YMin(ST_Envelope(geom)) AS bbox_south,
      ST_XMax(ST_Envelope(geom)) AS bbox_east, ST_YMax(ST_Envelope(geom)) AS bbox_north
    FROM lease_boundary ORDER BY id`);

  let bbox = rows.length ? [rows[0].bbox_west, rows[0].bbox_south, rows[0].bbox_east, rows[0].bbox_north] : null;
  if (!bbox) {
    const ext = await pool.query(`
      SELECT ST_XMin(e::box3d) AS w, ST_YMin(e::box3d) AS s, ST_XMax(e::box3d) AS e, ST_YMax(e::box3d) AS n
      FROM (SELECT ST_Extent(geom) AS e FROM (
              SELECT geom FROM zones UNION ALL SELECT geom FROM haul_roads) g) x`);
    const r = ext.rows[0];
    if (r && r.w !== null) bbox = [r.w, r.s, r.e, r.n];
  }
  res.json({ ...toFeatureCollection(rows), bbox });
}));

// ── Alerts ────────────────────────────────────────────────────────────────────
app.get('/api/alerts', asyncRoute(async (req, res) => {
  const alerts = await getAlerts(clampHours(req.query.hours, 48), sourceOf(req));
  res.json(toFeatureCollection(alerts));
}));

// ── Review an alert: POST /api/alerts/review { alert_key, decision, note?, reviewed_by? } ──
//    decision = follow_up | not_relevant | field_check.   DELETE /api/alerts/review?alert_key=... undoes it.
app.post('/api/alerts/review', asyncRoute(async (req, res) => {
  const d = req.body || {};
  const key = String(d.alert_key || '').trim();
  if (!key || key.length > 120 || !DECISIONS.includes(d.decision)) {
    return res.status(400).json({ error: `need alert_key and decision (${DECISIONS.join(' | ')})` });
  }
  const note = d.note ? String(d.note).slice(0, 500) : null;
  const by = d.reviewed_by ? String(d.reviewed_by).slice(0, 60) : null;
  await pool.query(`
    INSERT INTO alert_reviews (alert_key, decision, note, reviewed_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (alert_key) DO UPDATE
      SET decision = EXCLUDED.decision, note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
    [key, d.decision, note, by]);
  if (key.startsWith('alert:')) {                       // keep the stored alert's own status in step
    await pool.query(`UPDATE alerts SET status = $2 WHERE id = $1`, [parseInt(key.slice(6)) || 0, d.decision]);
  }
  res.status(201).json({ ok: true, alert_key: key, decision: d.decision });
}));

app.delete('/api/alerts/review', asyncRoute(async (req, res) => {
  const key = String(req.query.alert_key || '').trim();
  if (!key) return res.status(400).json({ error: 'need alert_key' });
  await pool.query(`DELETE FROM alert_reviews WHERE alert_key = $1`, [key]);
  if (key.startsWith('alert:')) await pool.query(`UPDATE alerts SET status = 'new' WHERE id = $1`, [parseInt(key.slice(6)) || 0]);
  res.json({ ok: true, alert_key: key });
}));

// ── Blast events ──────────────────────────────────────────────────────────────
app.get('/api/blast_events', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, ts, charge_kg, ST_AsGeoJSON(geom)::json AS geometry
    FROM blast_events ORDER BY ts DESC LIMIT 200`);
  res.json(toFeatureCollection(rows));
}));

// ── Vehicle stops ─────────────────────────────────────────────────────────────
app.get('/api/vehicle_stops', asyncRoute(async (req, res) => {
  const hours = clampHours(req.query.hours, 24);
  const { rows } = await pool.query(`
    SELECT s.id, s.vehicle_id, s.start_ts, s.end_ts, s.minutes, s.label, s.zone_type, s.status,
           ST_AsGeoJSON(s.geom)::json AS geometry
    FROM vehicle_stops s JOIN vehicles v USING (vehicle_id)
    WHERE s.start_ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
      AND ($2::text IS NULL OR s.vehicle_id = $2)
      AND ($3::text IS NULL OR v.source = $3)
    ORDER BY s.start_ts DESC
    LIMIT 500
  `, [hours, req.query.vehicle_id || null, sourceOf(req)]);
  res.json(toFeatureCollection(rows));
}));

// ── Live ingestion: one GPS point from a device ───────────────────────────────
// POST /api/gps  { vehicle_id, lat, lon, ts?, speed_kmph?, sats? }
//   Set GPS_API_KEY in .env and devices must send it as the x-api-key header.
app.post('/api/gps', asyncRoute(async (req, res) => {
  if (process.env.GPS_API_KEY && req.get('x-api-key') !== process.env.GPS_API_KEY) {
    return res.status(401).json({ error: 'missing or wrong x-api-key' });
  }
  const d = req.body || {};
  const vehicleId = String(d.vehicle_id || '').trim();
  const lat = Number(d.lat), lon = Number(d.lon);
  const speed = d.speed_kmph === undefined ? 0 : Number(d.speed_kmph);
  const sats = d.sats === undefined || d.sats === null ? MIN_SATS : parseInt(d.sats);
  const ts = d.ts ? new Date(d.ts) : new Date();

  const bad = !vehicleId || vehicleId.length > 40 ||
    !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
    !Number.isFinite(speed) || speed < 0 || speed > 200 || !Number.isFinite(sats) || isNaN(ts.getTime());
  if (bad) {
    return res.status(400).json({ error: 'need vehicle_id, lat (-90..90), lon (-180..180); optional ts, speed_kmph (0..200), sats' });
  }
  await pool.query(
    `INSERT INTO vehicles (vehicle_id, vehicle_type, source) VALUES ($1, 'truck', 'telematics') ON CONFLICT DO NOTHING`,
    [vehicleId]);
  await pool.query(`
    INSERT INTO vehicle_tracks (vehicle_id, ts, speed_kmph, sats, good_fix, moving, geom)
    VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326))`,
    [vehicleId, ts, speed, sats, sats >= MIN_SATS, speed >= 2, lon, lat]);
  res.status(201).json({ ok: true });
}));

// ── Additional tables ─────────────────────────────────────────────────────────
app.get('/api/water_levels', asyncRoute(async (req, res) => {
  res.json((await pool.query(`SELECT * FROM water_levels ORDER BY id DESC LIMIT 100`)).rows);
}));
app.get('/api/dewatering_log', asyncRoute(async (req, res) => {
  res.json((await pool.query(`SELECT * FROM dewatering_log ORDER BY id DESC LIMIT 100`)).rows);
}));
app.get('/api/volume_changes', asyncRoute(async (req, res) => {
  res.json((await pool.query(`SELECT * FROM volume_changes ORDER BY id DESC LIMIT 100`)).rows);
}));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  const prod = process.env.NODE_ENV === 'production';
  res.status(500).json({
    error: prod ? 'Internal server error' : err.message,
    hint: !prod && err.code === 'ECONNREFUSED' ? 'Cannot reach PostgreSQL. Check DATABASE_URL in .env' : undefined,
  });
});

// ─── Automatic stop detection (turns GPS points into stops, statuses and alerts) ───
const STOP_EVERY_S = num(process.env.STOP_DETECT_INTERVAL_S, 20);   // 0 = off
let detecting = false;
async function runStopDetection() {
  if (detecting) return;
  detecting = true;
  try {
    const r = await detectStops(pool);
    if (r.rebuilt) console.log(`[stops] rebuilt ${r.rebuilt} vehicle(s), ${r.stops_written} stop(s)`);
  } catch (e) {
    console.error('[stops] detection failed:', e.message);
  } finally { detecting = false; }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚛 Mine Fleet GIS API running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
  if (STOP_EVERY_S > 0) {
    runStopDetection();
    setInterval(runStopDetection, STOP_EVERY_S * 1000);
    console.log(`   Stop detection every ${STOP_EVERY_S}s (set STOP_DETECT_INTERVAL_S=0 to switch off)\n`);
  }
});
