/**
 * fleet-kpis.js — the "Shifts" tab: fleet totals, trips per shift, cycle time, route efficiency,
 * time/fuel lost, and idle/queue hotspots (also drawn on the map while the tab is open).
 *
 * Needs the backend endpoints /kpis, /shift_summary and /hotspots.
 */
let kpiHours = 12;
let kpiTimer = null;

const fmt = (v, d = 1, unit = '') => (v === null || v === undefined ? '—' : (Math.round(v * 10 ** d) / 10 ** d) + unit);
const pct = v => (v === null || v === undefined ? '—' : Math.round(v * 100) + '%');

function effClass(v) {            // route efficiency colouring: low = a detour
  if (v === null || v === undefined) return '';
  return v >= 0.9 ? 'good' : v >= 0.75 ? 'warn' : 'bad';
}

async function loadKpis() {
  const [kpis, shifts, hot] = await Promise.all([
    apiFetch(`/kpis?hours=${kpiHours}`),
    apiFetch(`/shift_summary?hours=${kpiHours}`),
    apiFetch(`/hotspots?hours=${kpiHours}`),
  ]);
  const el = document.getElementById('kpiBody');
  if (!el) return;
  if (!kpis || !shifts) {
    el.innerHTML = `<div class="empty-state"><div class="e-icon">${ICON('alert')}</div>Backend not reachable.<br>Start the API (npm start) and check CONFIG.API_BASE.</div>`;
    return;
  }
  el.innerHTML = renderTotals(kpis) + renderShifts(shifts) + renderHotspots(hot?.features || []) + renderNotes();
  if (map && map.getSource('hotspots')) map.getSource('hotspots').setData(hot || { type: 'FeatureCollection', features: [] });
}

function renderTotals(kpis) {
  const trips = kpis.reduce((s, r) => s + (r.trips || 0), 0);
  const withCycle = kpis.filter(r => r.avg_cycle_min !== null && r.trips);
  const cycleW = withCycle.reduce((s, r) => s + r.trips, 0);
  const cycle = cycleW ? withCycle.reduce((s, r) => s + r.avg_cycle_min * r.trips, 0) / cycleW : null;
  const effs = kpis.map(r => r.avg_route_efficiency).filter(v => v !== null);
  const eff = effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : null;
  const lost = kpis.reduce((s, r) => s + (r.time_loss_min || 0), 0);
  const fuel = kpis.reduce((s, r) => s + (r.fuel_loss_l || 0), 0);
  const tile = (label, value, sub, cls = '') =>
    `<div class="kpi-tile ${cls}"><div class="kpi-val">${value}</div><div class="kpi-label">${label}</div><div class="kpi-sub">${sub}</div></div>`;
  return `<div class="kpi-grid">
      ${tile('Trips', trips, 'pit → dump hauls')}
      ${tile('Avg cycle', fmt(cycle, 1, ' min'), 'pit → next pit')}
      ${tile('Route efficiency', pct(eff), 'planned ÷ driven', effClass(eff))}
      ${tile('Time lost', fmt(lost, 0, ' min'), `≈ ${fmt(fuel, 1, ' L')} fuel (est.)`, lost > 0 ? 'warn' : '')}
    </div>`;
}

function renderShifts(rows) {
  if (!rows.length) return `<div class="kpi-section">Per shift</div><div class="kpi-empty">No trips or stops in this window.</div>`;
  const byShift = {};
  rows.forEach(r => { (byShift[r.shift] ||= []).push(r); });
  return `<div class="kpi-section">Per shift</div>` + Object.entries(byShift).map(([shift, list]) => {
    const body = list.map(r => `
      <tr>
        <td class="kpi-v">${esc(r.vehicle_id)}</td>
        <td>${r.trips}</td>
        <td>${fmt(r.avg_cycle_min, 1)}</td>
        <td class="${effClass(r.avg_route_efficiency)}">${pct(r.avg_route_efficiency)}</td>
        <td class="${r.time_loss_min > 0 ? 'warn' : ''}">${fmt(r.time_loss_min, 0)}</td>
      </tr>`).join('');
    return `<div class="kpi-shift-head">Shift starting ${esc(shift)}</div>
      <table class="kpi-table"><thead><tr><th>Truck</th><th>Trips</th><th>Cycle<br>min</th><th>Route<br>eff.</th><th>Lost<br>min</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }).join('');
}

function renderHotspots(features) {
  if (!features.length) return `<div class="kpi-section">Idle &amp; queue hotspots</div><div class="kpi-empty">No repeated idling or queueing.</div>`;
  return `<div class="kpi-section">Idle &amp; queue hotspots</div>` + features.map(f => {
    const p = f.properties, c = f.geometry?.coordinates || [];
    return `<div class="hot-item" data-lng="${c[0]}" data-lat="${c[1]}">
      <div class="hot-rank">${p.rank}</div>
      <div class="hot-main">
        <div class="hot-title">${esc(p.place || 'Unknown place')}</div>
        <div class="hot-sub">${esc(p.main_status)} · ${p.stops} stop${p.stops > 1 ? 's' : ''} · ${p.vehicles} truck${p.vehicles > 1 ? 's' : ''}</div>
      </div>
      <div class="hot-min">${fmt(p.total_min, 0)}<span>min</span></div>
    </div>`;
  }).join('');
}

function renderNotes() {
  return `<div class="kpi-notes">
    <b>Cycle</b> = arriving at the pit to arriving at the pit again. <b>Route efficiency</b> = planned distance along the haul road ÷ distance driven (100% = direct).
    <b>Time lost</b> = idle + queueing. Fuel is an estimate from an assumed idle burn rate.</div>`;
}

function initFleetKpis() {
  // time-window buttons
  document.querySelectorAll('#kpiTime .time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#kpiTime .time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      kpiHours = parseFloat(btn.dataset.hours);
      loadKpis();
    });
  });
  // click a hotspot → fly there
  document.getElementById('kpiBody')?.addEventListener('click', e => {
    const item = e.target.closest('.hot-item');
    if (item) flyToAlert(parseFloat(item.dataset.lng), parseFloat(item.dataset.lat));
  });

  // hotspot circles on the map (only visible while the Shifts tab is open)
  const addLayer = () => {
    if (map.getSource('hotspots')) return;
    map.addSource('hotspots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'hotspots-circle', type: 'circle', source: 'hotspots',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#d62839', 'circle-opacity': 0.22,
        'circle-radius': ['interpolate', ['linear'], ['get', 'total_min'], 5, 14, 30, 28, 120, 46],
        'circle-stroke-color': '#d62839', 'circle-stroke-width': 2,
      },
    });
    map.on('click', 'hotspots-circle', ev => {
      const p = ev.features[0].properties;
      new maplibregl.Popup({ closeButton: true }).setLngLat(ev.lngLat)
        .setHTML(`<div style="padding:12px 14px;font-size:12px"><b>#${p.rank} ${esc(p.place)}</b><br>
          ${esc(p.main_status)} · ${p.total_min} min over ${p.stops} stop(s)<br>≈ ${p.fuel_loss_l} L fuel (est.)</div>`).addTo(map);
    });
  };
  if (map.loaded()) addLayer(); else map.on('load', addLayer);

  // refresh + show the layer when the tab opens, hide it when leaving
  const baseSwitch = window.switchTab;
  window.switchTab = function (id) {
    baseSwitch(id);
    const on = id === 'shifts';
    if (map.getLayer('hotspots-circle')) map.setLayoutProperty('hotspots-circle', 'visibility', on ? 'visible' : 'none');
    clearInterval(kpiTimer);
    if (on) { loadKpis(); kpiTimer = setInterval(loadKpis, 30000); }
  };
}
