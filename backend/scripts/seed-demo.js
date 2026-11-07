/**
 * seed-demo.js — loads the simulated shift (replay-data.js from the frontend) into PostGIS,
 * so the dashboard, stop detection, trips, hotspots and the ML checks have something to work on.
 *
 *   node scripts/seed-demo.js ../js/replay-data.js          # add data (skips what already exists)
 *   node scripts/seed-demo.js ../js/replay-data.js --reset  # wipe the simulated data first
 *
 * If the zones / haul_roads tables are empty it also builds demo zones (pit, dump, parking, workshop)
 * and one haul road from the simulated stops. Real zones and roads are never touched.
 */
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const file = process.argv[2];
const reset = process.argv.includes('--reset');
if (!file) { console.error('usage: node scripts/seed-demo.js <path/to/replay-data.js> [--reset]'); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
const startMs = new Date(data.start).getTime();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110574);

(async () => {
  if (reset) {
    await pool.query(`DELETE FROM ml_flags WHERE vehicle_id IN (SELECT vehicle_id FROM vehicles WHERE source = 'simulated')`);
    await pool.query(`DELETE FROM vehicle_stops  WHERE vehicle_id IN (SELECT vehicle_id FROM vehicles WHERE source = 'simulated')`);
    await pool.query(`DELETE FROM vehicle_tracks WHERE vehicle_id IN (SELECT vehicle_id FROM vehicles WHERE source = 'simulated')`);
    await pool.query(`DELETE FROM zones WHERE name LIKE 'DEMO %'`);
    await pool.query(`DELETE FROM haul_roads WHERE name LIKE 'DEMO %'`);
    await pool.query(`TRUNCATE alert_reviews`);
    console.log('simulated data wiped');
  }

  let points = 0;
  for (const [id, t] of Object.entries(data.trucks)) {
    await pool.query(`INSERT INTO vehicles (vehicle_id, vehicle_type, source) VALUES ($1, 'truck', 'simulated') ON CONFLICT DO NOTHING`, [id]);
    const have = await pool.query(`SELECT COUNT(*) FROM vehicle_tracks WHERE vehicle_id = $1`, [id]);
    if (parseInt(have.rows[0].count) > 0) { console.log(`${id}: already has tracks, skipped`); continue; }
    const p = t.pts;
    await pool.query(`
      INSERT INTO vehicle_tracks (vehicle_id, ts, speed_kmph, sats, good_fix, moving, geom)
      SELECT $1, x.ts, x.spd, 10, true, x.spd >= 2, ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326)
      FROM unnest($2::timestamptz[], $3::float8[], $4::float8[], $5::float8[]) AS x(ts, lon, lat, spd)`,
      [id, p.map(r => new Date(startMs + r[0] * 1000).toISOString()), p.map(r => r[1]), p.map(r => r[2]), p.map(r => r[3])]);
    points += p.length;
    console.log(`${id}: ${p.length} GPS points`);
  }

  // ── demo zones + haul road, only when the mine has none ──
  const zoneCount = parseInt((await pool.query(`SELECT COUNT(*) FROM zones`)).rows[0].count);
  if (zoneCount === 0) {
    const centres = { parked: [], maintenance: [], loading_dumping: [] };   // labels used by the simulated data
    for (const t of Object.values(data.trucks)) {
      for (const [a, , label] of t.stops) {
        if (!centres[label]) continue;
        const pt = t.pts.reduce((best, q) => (Math.abs(q[0] - a) < Math.abs(best[0] - a) ? q : best));
        centres[label].push({ at: a, c: [pt[1], pt[2]] });
      }
    }
    const cluster = list => {                      // group nearby stop centres, keep first-visit time
      const groups = [];
      for (const s of list) {
        const g = groups.find(g => distM(g.c, s.c) < 120);
        if (g) g.at = Math.min(g.at, s.at); else groups.push({ c: s.c, at: s.at });
      }
      return groups;
    };
    const load = cluster(centres.loading_dumping).sort((a, b) => a.at - b.at);  // first visited = pit
    const zones = [];
    if (load[0]) zones.push(['DEMO Pit', 'pit', load[0].c]);
    if (load[1]) zones.push(['DEMO Dump', 'dump', load[1].c]);
    cluster(centres.parked).slice(0, 1).forEach(g => zones.push(['DEMO Parking', 'parking', g.c]));
    cluster(centres.maintenance).slice(0, 1).forEach(g => zones.push(['DEMO Workshop', 'workshop', g.c]));
    for (const [name, type, c] of zones) {
      await pool.query(`INSERT INTO zones (name, zone_type, geom)
        VALUES ($1, $2, ST_Buffer(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 60)::geometry)`, [name, type, c[0], c[1]]);
    }
    // haul road = the path TRK-01 drove from its first pit stop to its next dump stop, simplified
    const t1 = Object.values(data.trucks)[0];
    const stopsByTime = t1.stops.filter(s => s[2] === 'loading_dumping');
    if (stopsByTime.length >= 2) {
      const [s0, s1] = [stopsByTime[0], stopsByTime[1]];
      const path = t1.pts.filter(q => q[0] >= s0[1] && q[0] <= s1[0]).map(q => [q[1], q[2]]);
      if (path.length > 3) {
        const wkt = 'LINESTRING(' + path.map(c => `${c[0]} ${c[1]}`).join(',') + ')';
        await pool.query(`INSERT INTO haul_roads (name, geom) VALUES ('DEMO Haul Road', ST_Simplify(ST_GeomFromText($1, 4326), 0.00003))`, [wkt]);
      }
    }
    console.log(`demo zones created: ${zones.map(z => z[1]).join(', ')} + haul road`);
  } else {
    console.log(`zones table already has ${zoneCount} rows — demo zones not created`);
  }

  console.log(`done. ${points} GPS points added. Now run stop detection (starts automatically with the server, or: node scripts/detect-stops.js)`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
