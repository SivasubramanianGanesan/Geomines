/**
 * panels.js — Side panel, vehicle list, alerts, layer toggles, stats bar
 */

// ─── Clock & stats polling ────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('liveTime');
  const tick = () => {
    if (!el) return;
    // Simulated / replayed data is older than the wall clock: show the data time, so nobody expects live movement
    if (typeof dataClock === 'number' && Date.now() - dataClock > 120000) {
      el.textContent = 'Simulated data · ' + new Date(dataClock).toLocaleString('en-GB',
        { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
      el.title = 'The newest GPS point is from this time. Use Replay shift to see the trucks move.';
    } else {
      el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
      el.title = '';
    }
  };
  tick();
  setInterval(tick, 1000);
}

async function loadStats() {
  const stats = await apiFetch('/stats');
  if (!stats) return;
  document.getElementById('stat-moving').textContent  = stats.moving;
  document.getElementById('stat-stopped').textContent = stats.stopped;
  document.getElementById('stat-total').textContent   = stats.totalVehicles;
  document.getElementById('stat-avgspd').textContent  = stats.avgSpeed + ' km/h';
  document.getElementById('stat-alerts').textContent  = stats.activeAlerts;
  // Alert badge
  const badge = document.getElementById('alertBadge');
  if (badge) badge.textContent = stats.activeAlerts || '';
  if (badge) badge.style.display = stats.activeAlerts > 0 ? 'inline-flex' : 'none';
}

// ─── Vehicle list ─────────────────────────────────────────────────────────────
let allVehicleFeatures = [];

function updateVehicleList(features) {
  allVehicleFeatures = features || [];
  renderVehicleList(document.getElementById('vehicleSearch')?.value || '');
}

function renderVehicleList(filter = '') {
  const el = document.getElementById('vehicleList');
  if (!el) return;
  const lc = filter.toLowerCase();

  const filtered = allVehicleFeatures.filter(f => {
    const p = f.properties;
    return !lc ||
      (p.vehicle_id||'').toLowerCase().includes(lc) ||
      (p.vehicle_type||'').toLowerCase().includes(lc);
  });

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="e-icon">${ICON('truck')}</div>No vehicles found</div>`;
    return;
  }

  el.innerHTML = filtered.map(f => {
    const p    = f.properties;
    const icon = vehicleIcon(p.vehicle_type);
    const color= vehicleColor(p.vehicle_type);
    const stale = p.status === 'offline';
    const sColor = statusColor(p.status);
    const statusClass = stale ? 'stale' : p.moving ? 'moving' : 'stopped';
    const speedClass  = p.moving ? 'moving' : 'stopped';

    return `
      <div class="vehicle-item ${selectedVehicleId === p.vehicle_id ? 'selected':''}"
           id="vi-${esc(p.vehicle_id)}"
           onclick="onVehicleListClick('${esc(p.vehicle_id)}', ${f.geometry.coordinates[0]}, ${f.geometry.coordinates[1]})">
        <div class="status-dot ${statusClass}" style="background:${sColor}"></div>
        <div class="v-icon-wrap" style="background:${color}22">
          <span>${icon}</span>
          <div class="v-moving-ring ${p.moving && !stale ? 'active':''}"></div>
        </div>
        <div class="v-info">
          <div class="v-id">${esc(p.vehicle_id)}</div>
          <div class="v-type"><span style="color:${sColor}">${statusLabel(p.status)}</span>${p.stop_minutes != null ? ' · ' + p.stop_minutes + ' min' : ''}</div>
        </div>
        <div class="v-meta">
          <div class="v-speed ${speedClass}">${(p.speed_kmph||0).toFixed(0)} <small>km/h</small></div>
          <div class="v-ts">${timeAgo(p.ts)}</div>
        </div>
      </div>`;
  }).join('');
}

function onVehicleListClick(vehicleId, lng, lat) {
  selectedVehicleId = vehicleId;
  renderVehicleList(document.getElementById('vehicleSearch')?.value || '');
  map.flyTo({ center: [lng, lat], zoom: 16, duration: 1000, pitch: 45 });
  loadVehicleTrack(vehicleId, trackHours);
  // Repaint selection ring
  map.setPaintProperty('vehicles-circle', 'circle-stroke-color', [
    'case',
    ['==', ['get', 'vehicle_id'], vehicleId], '#ffffff',
    'rgba(0,0,0,0.5)',
  ]);
  map.setPaintProperty('vehicles-circle', 'circle-stroke-width', [
    'case',
    ['==', ['get', 'vehicle_id'], vehicleId], 3,
    1.5,
  ]);
}

function highlightVehicleInList(vehicleId) {
  document.querySelectorAll('.vehicle-item').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById(`vi-${vehicleId}`);
  if (el) { el.classList.add('selected'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

// ─── Alerts panel ─────────────────────────────────────────────────────────────
async function loadAlerts() {
  const data = await apiFetch('/alerts?hours=48');
  if (!data) return;
  renderAlerts(data.features || []);
}

const REVIEW_LABELS = { follow_up: 'Follow up', not_relevant: 'Not relevant', field_check: 'Field check' };

function renderAlerts(features) {
  const el = document.getElementById('alertList');
  if (!el) return;

  if (!features.length) {
    el.innerHTML = `<div class="empty-state"><div class="e-icon">${ICON('check')}</div>No recent alerts</div>`;
    return;
  }

  const typeConfig = {
    'geofence':     { icon:ICON('alert'), cls:'danger' },
    'speed':        { icon:ICON('zap'), cls:'warning' },
    'low_fuel':     { icon:ICON('alert'), cls:'warning' },
    'maintenance':  { icon:ICON('wrench'), cls:'warning' },
    'blast':        { icon:ICON('alert'), cls:'danger' },
    'idle':         { icon:ICON('clock'), cls:'warning' },
    'queueing':     { icon:ICON('clock'), cls:'warning' },
    'slow_trip':    { icon:ICON('route'), cls:'warning' },   // machine-learning flag
    'unusual_stop': { icon:ICON('alert'), cls:'warning' },   // machine-learning flag
    'default':      { icon:ICON('bell'), cls:'info' },
  };

  el.innerHTML = features.map(f => {
    const p  = f.properties;
    const cfg= typeConfig[p.alert_type?.toLowerCase()] || typeConfig.default;
    const isActive = ['active', 'new'].includes(p.status);
    const key = esc(p.alert_key || '');
    const ml = ['slow_trip', 'unusual_stop'].includes(p.alert_type);
    const title = (p.alert_type || 'Alert').replace('_', ' ');

    // supervisor review: three buttons while open, a chip (with undo) once reviewed
    const review = !key ? '' : isActive
      ? `<div class="alert-review">
           ${Object.entries(REVIEW_LABELS).map(([d, l]) =>
              `<button class="rv-btn rv-${d}" data-key="${key}" data-decision="${d}">${l}</button>`).join('')}
         </div>`
      : `<div class="alert-review">
           <span class="rv-chip rv-${esc(p.status)}">${esc(REVIEW_LABELS[p.status] || p.status)}</span>
           ${p.reviewed_at ? `<span class="rv-when">${timeAgo(p.reviewed_at)}</span>` : ''}
           <button class="rv-undo" data-key="${key}" data-decision="undo">Undo</button>
         </div>`;

    return `
      <div class="alert-item ${isActive ? 'active-alert':''}"
           onclick="flyToAlert(${f.geometry?.coordinates?.[0] ?? 'null'}, ${f.geometry?.coordinates?.[1] ?? 'null'})">
        <div class="alert-icon-wrap ${cfg.cls}">${cfg.icon}</div>
        <div class="alert-body">
          <div class="alert-title">${esc(title)}${ml ? ' <span class="ml-tag">ML</span>' : ''}</div>
          <div class="alert-msg">${esc(p.message || '—')}</div>
          <div class="alert-time">${timeAgo(p.ts)}</div>
          ${review}
        </div>
      </div>`;
  }).join('');
}

/** Send a supervisor's decision for one alert, then refresh the list and the alert count. */
async function reviewAlert(key, decision) {
  const res = decision === 'undo'
    ? await apiFetch(`/alerts/review?alert_key=${encodeURIComponent(key)}`, { method: 'DELETE' })
    : await apiFetch('/alerts/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_key: key, decision, reviewed_by: 'supervisor' }),
      });
  if (!res) { showToast('warning', 'Review not saved', 'Could not reach the server.'); return; }
  loadAlerts(); loadStats();
}

function flyToAlert(lng, lat) {
  if (Number.isFinite(lng) && Number.isFinite(lat)) map.flyTo({ center: [lng, lat], zoom: 16, duration: 1000 });
}

// ─── Layer toggle panel ───────────────────────────────────────────────────────
const LAYERS = [
  { id:'lease-boundary', label:'Lease Boundary',  color:'#ef4444' },
  { id:'zones',          label:'Zones',            color:'#ef4444' },
  { id:'haul-roads',     label:'Haul Roads',       color:'#fcd34d' },
  { id:'blast-events',   label:'Blast Events',     color:'#ef4444' },
  { id:'vehicle-stops',  label:'Vehicle Stops',    color:'#3b82f6' },
  { id:'track',          label:'Track Trail',      color:'#a78bfa' },
  { id:'vehicles',       label:'Live Vehicles',    color:'#10b981' },
];

function renderLayerToggles() {
  const el = document.getElementById('layerToggles');
  if (!el) return;
  el.innerHTML = `
    <div class="layer-section">
      <div class="layer-section-title">Map Layers</div>
      ${LAYERS.map(l => `
        <div class="layer-row">
          <div class="layer-swatch" style="background:${l.color}"></div>
          <div class="layer-name">${l.label}</div>
          <div class="layer-toggle on" id="toggle-${l.id}"
               onclick="onLayerToggle('${l.id}', this)"></div>
        </div>`).join('')}
    </div>
    <div class="layer-section">
      <div class="layer-section-title">Base Map</div>
      <div class="layer-row">
        <div class="layer-swatch" style="background:#475569;border-radius:50%"></div>
        <div class="layer-name">Labels overlay</div>
        <div class="layer-toggle on" id="toggle-labels"
             onclick="onLabelToggle(this)"></div>
      </div>
    </div>
    <div class="layer-section">
      <div class="layer-section-title">Vehicle status</div>
      ${Object.keys(STATUS_COLORS).map(k => `
        <div class="layer-row">
          <div class="layer-swatch" style="background:${STATUS_COLORS[k]};border-radius:50%"></div>
          <div class="layer-name">${statusLabel(k)}</div>
        </div>`).join('')}
    </div>`;
}

function onLayerToggle(layerId, btn) {
  const isOn = btn.classList.toggle('on');
  setLayerVisibility(layerId, isOn);
}

function onLabelToggle(btn) {
  const isOn = btn.classList.toggle('on');
  if (map.getLayer('labels-overlay')) {
    map.setLayoutProperty('labels-overlay', 'visibility', isOn ? 'visible' : 'none');
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(`tab-${tabId}`).classList.add('active');
}

// ─── Panel collapse ───────────────────────────────────────────────────────────
function togglePanel() {
  const panel = document.getElementById('panel');
  panel.classList.toggle('collapsed');
  document.getElementById('panelToggle').innerHTML =
    ICON(panel.classList.contains('collapsed') ? 'chevron-left' : 'chevron-right');
}

// ─── Map tool buttons ─────────────────────────────────────────────────────────
function setupMapTools() {
  document.getElementById('btnZoomMine').addEventListener('click', zoomToMine);
  document.getElementById('btn3D').addEventListener('click', () => {
    const p = map.getPitch();
    const btn = document.getElementById('btn3D');
    if (p > 0) {
      map.easeTo({ pitch: 0, bearing: 0 });
      btn.classList.remove('active');
    } else {
      map.easeTo({ pitch: 55 });
      btn.classList.add('active');
    }
  });
  document.getElementById('btnNorth').addEventListener('click', () => {
    map.easeTo({ bearing: 0, duration: 500 });
  });
}

// ─── Time window buttons ──────────────────────────────────────────────────────
function setupTimeButtons() {
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setTrackHours(parseFloat(btn.dataset.hours));
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initPanels() {
  startClock();
  renderLayerToggles();
  setupMapTools();
  setupTimeButtons();

  // Load alerts and start polling
  loadAlerts();
  setInterval(loadAlerts, CONFIG.POLL.ALERTS);

  // Stats polling
  loadStats();
  setInterval(loadStats, CONFIG.POLL.STATS);

  // Alert review buttons (one listener for the whole list)
  document.getElementById('alertList')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-decision]');
    if (!btn) return;
    e.stopPropagation();
    reviewAlert(btn.dataset.key, btn.dataset.decision);
  });

  // Search box
  const search = document.getElementById('vehicleSearch');
  if (search) search.addEventListener('input', e => renderVehicleList(e.target.value));
}

// Toast (defined here so it's available globally)
function showToast(type, title, msg) {
  const zone = document.getElementById('toastZone');
  if (!zone) return;
  const icons = { info:ICON('info'), warning:ICON('alert'), danger:ICON('alert'), success:ICON('check') };
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.innerHTML = `
    <div class="t-icon">${icons[type]||ICON('info')}</div>
    <div>
      <div class="t-title">${title}</div>
      <div class="t-msg">${msg}</div>
      <div class="t-bar"></div>
    </div>`;
  zone.appendChild(div);
  setTimeout(() => {
    div.classList.add('removing');
    setTimeout(() => div.remove(), 300);
  }, 4300);
}
