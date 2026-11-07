/**
 * stops.js — builds vehicle_stops from vehicle_tracks (the step the original zip was missing).
 *
 * A stop is a run of good GPS fixes where the truck is not moving and stays within STOP_RADIUS_M
 * of where it first stopped, for at least STOP_MIN_S seconds. Drift inside that radius is ignored,
 * a single noisy "moving" fix does not break a stop, and weak fixes (good_fix = false) are skipped.
 * Each stop is matched to a zone (pit / dump / workshop / parking) and given a status by statusAt().
 *
 * Incremental: only the newest stop of a vehicle (and anything after it) is rebuilt, so it is cheap
 * enough to run every few seconds while live points arrive.
 */
const { statusAt, OFFLINE_MIN, STOP_MIN_S, STOP_RADIUS_M } = require('./rules');

const CLOSE_AFTER_MOVING = 2; // consecutive moving fixes needed to end a stop

// newest GPS time already processed per vehicle, so a quiet tick costs one cheap query and no rebuilds
const processed = new Map();

function distM(aLon, aLat, bLon, bLat) {
  const k = Math.cos(aLat * Math.PI / 180);
  return Math.hypot((bLon - aLon) * 111320 * k, (bLat - aLat) * 110574);
}

/** Pure function: points sorted by time → stops. point = { ts (ms), moving, lon, lat } */
function findStops(points, opts = {}) {
  const minS = opts.minS ?? STOP_MIN_S;
  const radius = opts.radius ?? STOP_RADIUS_M;
  const gapMs = (opts.offlineMin ?? OFFLINE_MIN) * 60000;
  const stops = [];
  let cur = null, movingRun = 0;

  const close = () => {
    if (cur && (cur.last - cur.start) / 1000 >= minS) {
      stops.push({ start: cur.start, end: cur.last, lon: cur.sumLon / cur.n, lat: cur.sumLat / cur.n });
    }
    cur = null; movingRun = 0;
  };
  const open = p => ({ start: p.ts, last: p.ts, aLon: p.lon, aLat: p.lat, sumLon: p.lon, sumLat: p.lat, n: 1 });

  for (const p of points) {
    if (cur && p.ts - cur.last > gapMs) close();               // device went silent: end the stop
    if (!p.moving) {
      if (!cur) cur = open(p);
      else if (distM(cur.aLon, cur.aLat, p.lon, p.lat) <= radius) {
        cur.last = p.ts; cur.sumLon += p.lon; cur.sumLat += p.lat; cur.n++; movingRun = 0;
      } else { close(); cur = open(p); }                       // crept away: a new stop begins here
    } else if (cur && ++movingRun >= CLOSE_AFTER_MOVING) {
      close();
    }
  }
  close();
  return stops;
}

/** Rebuild stops for every vehicle that has GPS newer than its last stop. Returns a summary. */
async function detectStops(pool, { fullRebuild = false } = {}) {
  const vehicles = await pool.query(`
    SELECT v.vehicle_id,
      (SELECT MAX(ts)       FROM vehicle_tracks t WHERE t.vehicle_id = v.vehicle_id AND t.good_fix) AS last_fix,
      (SELECT MAX(start_ts) FROM vehicle_stops  s WHERE s.vehicle_id = v.vehicle_id) AS last_stop_start,
      (SELECT MAX(end_ts)   FROM vehicle_stops  s WHERE s.vehicle_id = v.vehicle_id) AS last_stop_end
    FROM vehicles v`);

  let rebuilt = 0, written = 0;
  for (const v of vehicles.rows) {
    if (!v.last_fix) continue;
    const lastFixMs = new Date(v.last_fix).getTime();
    if (!fullRebuild && processed.get(v.vehicle_id) === lastFixMs) continue;                      // nothing new since last run
    if (!fullRebuild && v.last_stop_end && lastFixMs <= new Date(v.last_stop_end).getTime()) {    // stop already up to date
      processed.set(v.vehicle_id, lastFixMs); continue;
    }
    const from = fullRebuild || !v.last_stop_start ? null : v.last_stop_start;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM vehicle_stops WHERE vehicle_id = $1 AND ($2::timestamptz IS NULL OR start_ts >= $2)`,
        [v.vehicle_id, from]);

      const pts = (await client.query(`
        SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ms, moving, ST_X(geom) AS lon, ST_Y(geom) AS lat
        FROM vehicle_tracks
        WHERE vehicle_id = $1 AND good_fix = true AND ($2::timestamptz IS NULL OR ts >= $2)
        ORDER BY ts`, [v.vehicle_id, from])).rows
        .map(r => ({ ts: parseFloat(r.ms), moving: r.moving, lon: r.lon, lat: r.lat }));

      const stops = findStops(pts);
      if (stops.length) {
        // match every stop to a zone in one query (workshop/parking win over pit/dump if zones overlap)
        const z = await client.query(`
          SELECT p.i, z.zone_type, z.name
          FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS p(lon, lat, i)
          LEFT JOIN LATERAL (
            SELECT zone_type, name FROM zones
            WHERE ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326))
            ORDER BY CASE zone_type WHEN 'workshop' THEN 1 WHEN 'parking' THEN 2 WHEN 'pit' THEN 3 WHEN 'dump' THEN 4 ELSE 5 END
            LIMIT 1) z ON true
          ORDER BY p.i`, [stops.map(s => s.lon), stops.map(s => s.lat)]);

        const rows = stops.map((s, i) => {
          const zone = z.rows[i]?.zone_type || null;
          const minutes = (s.end - s.start) / 60000;
          return {
            start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(),
            minutes, lon: s.lon, lat: s.lat, zone,
            label: z.rows[i]?.name || 'Outside work zones', status: statusAt(zone, minutes),
          };
        });
        await client.query(`
          INSERT INTO vehicle_stops (vehicle_id, start_ts, end_ts, minutes, label, zone_type, status, geom)
          SELECT $1, t.start_ts, t.end_ts, t.minutes, t.label, t.zone_type, t.status,
                 ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)
          FROM unnest($2::timestamptz[], $3::timestamptz[], $4::float8[], $5::text[], $6::text[], $7::text[], $8::float8[], $9::float8[])
            AS t(start_ts, end_ts, minutes, label, zone_type, status, lon, lat)`,
          [v.vehicle_id, rows.map(r => r.start), rows.map(r => r.end), rows.map(r => r.minutes),
           rows.map(r => r.label), rows.map(r => r.zone), rows.map(r => r.status),
           rows.map(r => r.lon), rows.map(r => r.lat)]);
        written += rows.length;
      }
      await client.query('COMMIT');
      processed.set(v.vehicle_id, lastFixMs);
      rebuilt++;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return { vehicles: vehicles.rows.length, rebuilt, stops_written: written };
}

module.exports = { findStops, detectStops };
