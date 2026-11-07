/**
 * config.js — Central configuration for the Mine Fleet GIS frontend
 */
const CONFIG = {
  // API base URL — change if your backend runs on a different port
  API_BASE: 'http://localhost:3001/api',

  // Which vehicle source to show: 'simulated', 'phone', 'telematics', or '' for all
  SOURCE: 'simulated',

  // Map settings
  MAP: {
    // Initial center (will be overridden by lease_boundary bbox on load)
    CENTER:  [0, 0],
    ZOOM:    14,
    MIN_ZOOM: 8,
    MAX_ZOOM: 22,
    PITCH:   30,   // slight 3D tilt
  },

  // Polling intervals (ms)
  POLL: {
    VEHICLES: 5000,   // live positions
    ALERTS:   15000,  // alert feed
    STATS:    10000,  // top stats bar
  },

  // Track history default window in hours
  TRACK_HOURS: 6,

  // Stale threshold: vehicle older than this (ms) is shown as grey
  STALE_MS: 2 * 60 * 1000,  // 2 minutes

  // Vehicle type → emoji icon
  VEHICLE_ICONS: {
    'haul_truck':   'truck',
    'truck':        'truck',
    'excavator':    'truck',
    'dozer':        'truck',
    'grader':       'truck',
    'water_cart':   'truck',
    'light_vehicle':'truck',
    'default':      'truck',
  },

  // Vehicle type → color (hex)
  VEHICLE_COLORS: {
    'haul_truck':   '#3b82f6',
    'truck':        '#3b82f6',
    'excavator':    '#ef4444',
    'dozer':        '#f97316',
    'grader':       '#3b82f6',
    'water_cart':   '#06b6d4',
    'light_vehicle':'#10b981',
    'default':      '#8b5cf6',
  },

  // Zone type → fill color (rgba)
  ZONE_COLORS: {
    'pit':         'rgba(239,68,68,0.20)',
    'dump':        'rgba(249,115,22,0.20)',
    'workshop':    'rgba(59,130,246,0.20)',
    'parking':     'rgba(139,92,246,0.20)',
    'restricted':  'rgba(220,38,38,0.25)',
    'safe':        'rgba(16,185,129,0.18)',
    'blasting':    'rgba(251,191,36,0.25)',
    'default':     'rgba(100,116,139,0.18)',
  },
  ZONE_BORDER_COLORS: {
    'pit':         '#ef4444',
    'dump':        '#f97316',
    'workshop':    '#3b82f6',
    'parking':     '#8b5cf6',
    'restricted':  '#dc2626',
    'safe':        '#10b981',
    'blasting':    '#fbbf24',
    'default':     '#64748b',
  },
};

// Helper: get vehicle icon
function vehicleIcon(type) {
  return ICON(CONFIG.VEHICLE_ICONS[type?.toLowerCase()] || CONFIG.VEHICLE_ICONS['default']);
}

// Helper: get vehicle color
function vehicleColor(type) {
  return CONFIG.VEHICLE_COLORS[type?.toLowerCase()] || CONFIG.VEHICLE_COLORS['default'];
}

// Zone-aware vehicle status (from the API): colour + label
const STATUS_COLORS = {
  moving:          '#10b981',
  loading_dumping: '#3b82f6',
  queueing:        '#f59e0b',
  maintenance:     '#a855f7',
  parked:          '#94a3b8',
  idle:            '#ef4444',
  short_stop:      '#eab308',
  offline:         '#475569',
};
const STATUS_LABELS = {
  moving: 'Moving', loading_dumping: 'Loading / dumping', queueing: 'Queueing',
  maintenance: 'Maintenance', parked: 'Parked', idle: 'Idle', short_stop: 'Short stop', offline: 'Offline',
};
function statusLabel(s) { return STATUS_LABELS[s] || s || 'Unknown'; }
function statusColor(s) { return STATUS_COLORS[s] || '#64748b'; }
// MapLibre expression: colour by the 'status' property
function statusColorExpr() {
  const e = ['match', ['get', 'status']];
  Object.entries(STATUS_COLORS).forEach(([k, v]) => e.push(k, v));
  e.push('#64748b');
  return e;
}

// Escape text before putting it into HTML (vehicle ids and alert text come from the API)
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// "Now" for relative times: the newest GPS time from the API when we have it
// (so replayed / simulated data does not look days old), otherwise the wall clock.
let dataClock = null;
function nowMs() { return dataClock ?? Date.now(); }

// Helper: format timestamp as relative "2 min ago"
function timeAgo(ts) {
  if (!ts) return '—';
  const diff = (nowMs() - new Date(ts)) / 1000;
  if (diff < 60)  return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Helper: format timestamp HH:MM:SS
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

// Helper: check if stale
function isStale(ts) {
  return (nowMs() - new Date(ts)) > CONFIG.STALE_MS;
}

// API fetch helper with error handling
const SOURCE_PATHS = ['/vehicles/latest', '/stats', '/alerts', '/vehicle_stops', '/kpis', '/time-range', '/trips', '/shift_summary', '/hotspots'];
function withSource(path) {
  if (!CONFIG.SOURCE || !SOURCE_PATHS.some(p => path.startsWith(p))) return path;
  return path + (path.includes('?') ? '&' : '?') + 'source=' + encodeURIComponent(CONFIG.SOURCE);
}

async function apiFetch(path, options = {}) {
  try {
    const token = sessionStorage.getItem('gm_token');
    const opts = { ...options, headers: { ...(options.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
    const res = await fetch(CONFIG.API_BASE + withSource(path), opts);
    if (res.status === 401) { AUTH.logout(); throw new Error('HTTP 401'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[API] Failed to fetch ${path}:`, err.message);
    return null;
  }
}
