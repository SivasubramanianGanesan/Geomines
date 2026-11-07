/**
 * analytics.js — fleet analytics built on vehicle_stops + vehicle_tracks + haul_roads.
 *
 *  trips      pit → dump hauls, with haul time, return time, cycle time and route efficiency
 *  shifts     trips / cycle time / losses per vehicle per shift
 *  hotspots   places where idling and queueing keep happening
 *
 * Definitions (written down so they can be defended):
 *  - A VISIT is an unbroken run of stops in the same pit or dump zone (a queue + the loading is one visit).
 *  - A HAUL is leaving a pit visit and arriving at the next dump visit. A RETURN is the opposite.
 *  - CYCLE TIME is pit arrival → next pit arrival (needs a dump visit in between).
 *  - ROUTE EFFICIENCY = planned distance ÷ driven distance, capped at 1.0.
 *    Planned distance is measured along the nearest haul road between the two stops;
 *    it is left empty (not guessed) when a stop is more than 150 m from any haul road.
 */
const { shiftOf, IDLE_BURN_L_PER_H } = require('./rules');

const ANCHOR = `(SELECT COALESCE(MAX(ts), NOW()) FROM vehicle_tracks)`;
const round = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Collapse a vehicle's pit/dump stops into visits. */
function toVisits(stops) {
  const visits = [];
  for (const s of stops) {
    const last = visits[visits.length - 1];
    if (last && last.vehicle_id === s.vehicle_id && last.zone === s.zone_type) {
      last.end = s.end_ts; last.lastStop = s.id; last.stopMin += parseFloat(s.minutes) || 0;
    } else {
      visits.push({ vehicle_id: s.vehicle_id, zone: s.zone_type, start: s.start_ts, end: s.end_ts,
                    firstStop: s.id, lastStop: s.id, stopMin: parseFloat(s.minutes) || 0 });
    }
  }
  return visits;
}

/** Measure each leg: driven distance (from GPS) and planned distance (along the haul road). */
async function measureLegs(pool, legs) {
  if (!legs.length) return [];
  const { rows } = await pool.query(`
    WITH l AS (
      SELECT * FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::timestamptz[], $5::timestamptz[])
        AS x(vid, a, b, t0, t1)
    ), roads AS (
      SELECT (ST_Dump(ST_LineMerge(geom))).geom AS g FROM haul_roads
      WHERE GeometryType(geom) IN ('LINESTRING', 'MULTILINESTRING')
    )
    SELECT l.a, l.b,
      (SELECT ST_Length(ST_MakeLine(t.geom ORDER BY t.ts)::geography)
         FROM vehicle_tracks t
        WHERE t.vehicle_id = l.vid AND t.good_fix AND t.ts BETWEEN l.t0 AND l.t1) AS driven_m,
      (SELECT CASE WHEN ST_Distance(r.g::geography, sa.geom::geography) < 150
                    AND ST_Distance(r.g::geography, sb.geom::geography) < 150
                   THEN ST_Length(r.g::geography) * ABS(ST_LineLocatePoint(r.g, sb.geom) - ST_LineLocatePoint(r.g, sa.geom))
              END
         FROM roads r ORDER BY r.g <-> sa.geom LIMIT 1) AS planned_m
    FROM l
    JOIN vehicle_stops sa ON sa.id = l.a
    JOIN vehicle_stops sb ON sb.id = l.b`,
    [legs.map(l => l.vid), legs.map(l => l.a), legs.map(l => l.b), legs.map(l => l.t0), legs.map(l => l.t1)]);
  return rows;
}

/** Trips for a time window (hours back from the newest GPS time). */
async function getTrips(pool, { hours = 24, source = null, vehicleId = null } = {}) {
  const { rows: stops } = await pool.query(`
    SELECT s.id, s.vehicle_id, s.start_ts, s.end_ts, s.minutes, s.zone_type
    FROM vehicle_stops s JOIN vehicles v USING (vehicle_id)
    WHERE s.zone_type IN ('pit', 'dump')
      AND s.start_ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
      AND ($2::text IS NULL OR v.source = $2)
      AND ($3::text IS NULL OR s.vehicle_id = $3)
    ORDER BY s.vehicle_id, s.start_ts`, [hours, source, vehicleId]);

  const visits = toVisits(stops);
  const legs = [];
  for (let i = 0; i + 1 < visits.length; i++) {
    const a = visits[i], b = visits[i + 1];
    if (a.vehicle_id !== b.vehicle_id || a.zone === b.zone) continue;
    legs.push({ vid: a.vehicle_id, a: a.lastStop, b: b.firstStop, t0: a.end, t1: b.start,
                type: a.zone === 'pit' ? 'haul' : 'return', i });
  }
  const measured = await measureLegs(pool, legs);
  const byKey = new Map(measured.map(m => [`${m.a}:${m.b}`, m]));
  for (const l of legs) {
    const m = byKey.get(`${l.a}:${l.b}`) || {};
    l.driven_m = m.driven_m !== null && m.driven_m !== undefined ? parseFloat(m.driven_m) : null;
    l.planned_m = m.planned_m !== null && m.planned_m !== undefined ? parseFloat(m.planned_m) : null;
    l.minutes = (new Date(l.t1) - new Date(l.t0)) / 60000;
  }
  const legAt = new Map(legs.map(l => [l.i, l]));

  const trips = [];
  for (let i = 0; i < visits.length; i++) {
    const pit = visits[i];
    const haul = legAt.get(i);
    if (pit.zone !== 'pit' || !haul || haul.type !== 'haul') continue;
    const dump = visits[i + 1];
    const ret = legAt.get(i + 1);                                     // dump → next pit
    const nextPit = ret ? visits[i + 2] : null;

    const driven = (haul.driven_m || 0) + (ret?.driven_m || 0);
    const planned = haul.planned_m !== null && (!ret || ret.planned_m !== null)
      ? haul.planned_m + (ret?.planned_m || 0) : null;
    const efficiency = planned !== null && driven > 50 ? Math.min(1, planned / driven) : null;

    trips.push({
      vehicle_id: pit.vehicle_id,
      shift: shiftOf(pit.start).label,
      pit_arrive: pit.start,
      load_min: round(pit.stopMin),                                   // time spent in the pit zone (incl. queue)
      dump_arrive: dump.start,
      dump_min: round(dump.stopMin),
      haul_min: round(haul.minutes),
      return_min: ret ? round(ret.minutes) : null,
      cycle_min: nextPit ? round((new Date(nextPit.start) - new Date(pit.start)) / 60000) : null, // null = cycle not finished
      haul_km: round((haul.driven_m || 0) / 1000, 2),                 // one way, pit → dump
      round_trip_planned_km: planned !== null ? round(planned / 1000, 2) : null,
      round_trip_driven_km: round(driven / 1000, 2),
      route_efficiency: round(efficiency, 2),
    });
  }
  return trips;
}

/** Trips per vehicle per shift, plus idle / queue time and a fuel-loss estimate. */
async function getShiftSummary(pool, { hours = 24, source = null } = {}) {
  const trips = await getTrips(pool, { hours, source });
  const { rows: losses } = await pool.query(`
    SELECT s.vehicle_id, s.start_ts, s.status, s.minutes
    FROM vehicle_stops s JOIN vehicles v USING (vehicle_id)
    WHERE s.status IN ('idle', 'queueing', 'maintenance')
      AND s.start_ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
      AND ($2::text IS NULL OR v.source = $2)`, [hours, source]);

  const out = new Map();
  const slot = (vehicle, shift) => {
    const k = `${shift}|${vehicle}`;
    if (!out.has(k)) out.set(k, { shift, vehicle_id: vehicle, trips: 0, cycles: [], effs: [],
                                  idle_min: 0, queue_min: 0, maintenance_min: 0 });
    return out.get(k);
  };
  for (const t of trips) {
    const r = slot(t.vehicle_id, t.shift);
    r.trips++;
    if (t.cycle_min !== null) r.cycles.push(t.cycle_min);
    if (t.route_efficiency !== null) r.effs.push(t.route_efficiency);
  }
  for (const l of losses) {
    const r = slot(l.vehicle_id, shiftOf(l.start_ts).label);
    r[`${l.status === 'queueing' ? 'queue' : l.status === 'idle' ? 'idle' : 'maintenance'}_min`] += parseFloat(l.minutes) || 0;
  }
  return [...out.values()]
    .map(r => ({
      shift: r.shift, vehicle_id: r.vehicle_id, trips: r.trips,
      avg_cycle_min: round(mean(r.cycles)),
      avg_route_efficiency: round(mean(r.effs), 2),
      idle_min: round(r.idle_min), queue_min: round(r.queue_min), maintenance_min: round(r.maintenance_min),
      time_loss_min: round(r.idle_min + r.queue_min),
      fuel_loss_l: round((r.idle_min + r.queue_min) / 60 * IDLE_BURN_L_PER_H),
    }))
    .sort((a, b) => (a.shift < b.shift ? 1 : a.shift > b.shift ? -1 : a.vehicle_id.localeCompare(b.vehicle_id)));
}

/** Places where idling / queueing repeats (DBSCAN on stop locations, ~55 m radius). */
async function getHotspots(pool, { hours = 24, source = null, minMinutes = 5 } = {}) {
  const { rows } = await pool.query(`
    WITH s AS (
      SELECT s.vehicle_id, s.status, s.minutes, s.zone_type, s.label, s.geom,
             ST_ClusterDBSCAN(s.geom, eps := 0.0005, minpoints := 1) OVER () AS cid
      FROM vehicle_stops s JOIN vehicles v USING (vehicle_id)
      WHERE s.status IN ('idle', 'queueing')
        AND s.minutes >= $3
        AND s.start_ts > ${ANCHOR} - ($1::float8 * INTERVAL '1 hour')
        AND ($2::text IS NULL OR v.source = $2)
    )
    SELECT cid, COUNT(*) AS stops, ROUND(SUM(minutes)::numeric, 1) AS total_min,
           ROUND(AVG(minutes)::numeric, 1) AS avg_min,
           COUNT(DISTINCT vehicle_id) AS vehicles,
           MODE() WITHIN GROUP (ORDER BY status) AS main_status,
           MODE() WITHIN GROUP (ORDER BY label) AS place,
           ST_AsGeoJSON(ST_Centroid(ST_Collect(geom)))::json AS geometry
    FROM s GROUP BY cid ORDER BY SUM(minutes) DESC LIMIT 20`, [hours, source, minMinutes]);
  return rows.map((r, i) => ({
    rank: i + 1, stops: parseInt(r.stops), vehicles: parseInt(r.vehicles),
    total_min: parseFloat(r.total_min), avg_min: parseFloat(r.avg_min),
    main_status: r.main_status, place: r.place,
    fuel_loss_l: round(parseFloat(r.total_min) / 60 * IDLE_BURN_L_PER_H),
    geometry: r.geometry,
  }));
}

module.exports = { getTrips, getShiftSummary, getHotspots, toVisits };
