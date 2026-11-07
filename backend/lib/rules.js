/**
 * rules.js — the fleet rules in one place (same numbers as the proposal's status table).
 * Every value can be overridden in .env.
 */
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

const IDLE_MIN          = num(process.env.IDLE_MIN, 5);      // minutes outside a work zone before a stop is "idle"
const LOAD_MAX_MIN      = num(process.env.LOAD_MAX_MIN, 10); // minutes at pit/dump before it counts as "queueing"
const OFFLINE_MIN       = num(process.env.OFFLINE_MIN, 10);  // no GPS for this long = offline
const MIN_SATS          = num(process.env.MIN_SATS, 8);      // fewer satellites = weak fix
const IDLE_BURN_L_PER_H = num(process.env.IDLE_BURN_L_PER_H, 8); // assumed litres/hour while the engine idles — confirm with the mine

// Stop detection
const STOP_MIN_S    = num(process.env.STOP_MIN_S, 60);     // shorter pauses are not stops
const STOP_RADIUS_M = num(process.env.STOP_RADIUS_M, 30);  // GPS drift inside this radius is ignored

// Shifts (default: two 12-hour shifts starting 06:00 and 18:00, India time)
const SHIFT_START_HOUR    = num(process.env.SHIFT_START_HOUR, 6);
const SHIFT_HOURS         = num(process.env.SHIFT_HOURS, 12);
const SHIFT_TZ_OFFSET_MIN = num(process.env.SHIFT_TZ_OFFSET_MIN, 330);

/** Zone-aware status for a stop. */
function statusAt(zone, minutes) {
  if (zone === 'workshop') return 'maintenance';
  if (zone === 'parking')  return 'parked';
  if (zone === 'pit' || zone === 'dump') return minutes <= LOAD_MAX_MIN ? 'loading_dumping' : 'queueing';
  return minutes >= IDLE_MIN ? 'idle' : 'short_stop';
}

/** Which shift a time belongs to → { key, label }. */
function shiftOf(date) {
  const ms = new Date(date).getTime();
  const local = ms + SHIFT_TZ_OFFSET_MIN * 60000 - SHIFT_START_HOUR * 3600000;
  const idx = Math.floor(local / (SHIFT_HOURS * 3600000));
  const startLocal = idx * SHIFT_HOURS * 3600000 + SHIFT_START_HOUR * 3600000;
  const d = new Date(startLocal);              // UTC getters now read local clock time
  const p = n => String(n).padStart(2, '0');
  return { key: idx, label: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:00` };
}

module.exports = {
  num, IDLE_MIN, LOAD_MAX_MIN, OFFLINE_MIN, MIN_SATS, IDLE_BURN_L_PER_H,
  STOP_MIN_S, STOP_RADIUS_M, SHIFT_HOURS, statusAt, shiftOf,
};
