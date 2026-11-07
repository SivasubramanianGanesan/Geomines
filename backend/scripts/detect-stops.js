/** node scripts/detect-stops.js [--full]   rebuild vehicle_stops from vehicle_tracks (--full = all history) */
require('dotenv').config();
const { Pool } = require('pg');
const { detectStops } = require('../lib/stops');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
detectStops(pool, { fullRebuild: process.argv.includes('--full') })
  .then(r => { console.log(r); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
