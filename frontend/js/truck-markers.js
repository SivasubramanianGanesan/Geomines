/**
 * truck-markers.js — truck icons on the map (used by the live view and by the replay).
 * TruckSet places one rotating truck icon per vehicle; updateLiveTrucks() feeds it the live positions.
 */
const TRUCK_SVG = `
  <svg viewBox="0 0 26 44" xmlns="http://www.w3.org/2000/svg">
    <rect x="0.5" y="10" width="3.5" height="9" rx="1" fill="#111"/>
    <rect x="22" y="10" width="3.5" height="9" rx="1" fill="#111"/>
    <rect x="0.5" y="30" width="3.5" height="10" rx="1" fill="#111"/>
    <rect x="22" y="30" width="3.5" height="10" rx="1" fill="#111"/>
    <rect x="4" y="16" width="18" height="26" rx="3" fill="currentColor" stroke="#0b0e14" stroke-width="1.5"/>
    <rect x="7" y="19" width="12" height="20" rx="2" fill="#000" opacity=".25"/>
    <rect x="5" y="2" width="16" height="13" rx="3.5" fill="currentColor" stroke="#0b0e14" stroke-width="1.5"/>
    <rect x="8" y="4.5" width="10" height="4.5" rx="1.2" fill="#0b0e14" opacity=".75"/>
  </svg>`;

(function () {
  const s = document.createElement('style');
  s.textContent = `
  .truck{position:relative;width:0;height:0;cursor:pointer}
  .truck-body{position:absolute;left:-13px;top:-22px;width:26px;height:44px;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.7));transition:transform .15s linear}
  .truck-body svg{width:100%;height:100%;display:block}
  .truck.sel .truck-body{filter:drop-shadow(0 0 3px #1e63d6) drop-shadow(0 0 6px #1e63d6)}
  .truck-label{position:absolute;left:50%;top:26px;transform:translateX(-50%);white-space:nowrap;
    text-align:center;font:700 10px/1.25 system-ui,sans-serif;color:var(--t1);
    background:var(--surface-glass);border:1px solid var(--c);border-radius:6px;padding:1px 6px;box-shadow:0 1px 4px rgba(15,40,90,.3)}
  .truck-label small{font-weight:500;color:var(--t2)}
  .truck.far .truck-label{display:none}
  .truck.moving .truck-body::after{content:"";position:absolute;inset:-6px;border-radius:50%;
    border:2px solid var(--c);opacity:0;animation:truckPulse 1.6s ease-out infinite}
  @keyframes truckPulse{0%{transform:scale(.7);opacity:.7}100%{transform:scale(1.5);opacity:0}}`;
  document.head.appendChild(s);
})();

class TruckSet {
  constructor() { this.items = {}; this.visible = true; this.zoomHooked = false; }

  heading(id) { return this.items[id]?.heading ?? null; }

  place(id, lng, lat, heading, status, spd, opts = {}) {
    if (!this.zoomHooked) {
      map.on('zoom', () => Object.values(this.items).forEach(m =>
        m.root.classList.toggle('far', map.getZoom() < 13)));
      this.zoomHooked = true;
    }
    let m = this.items[id];
    if (!m) {
      const root = document.createElement('div');
      root.className = 'truck';
      root.innerHTML = `<div class="truck-body" style="color:var(--c)">${TRUCK_SVG}</div><div class="truck-label"></div>`;
      m = this.items[id] = { root, body: root.firstElementChild, label: root.lastElementChild, heading: 0,
        marker: new maplibregl.Marker({ element: root, rotationAlignment: 'map', pitchAlignment: 'map' })
          .setLngLat([lng, lat]) };
      m.marker.addTo(map);
    }
    m.heading = heading;
    m.root.style.display = this.visible ? '' : 'none';
    m.root.style.setProperty('--c', statusColor(status));
    m.root.classList.toggle('moving', status === 'moving');
    m.root.classList.toggle('sel', !!opts.selected);
    m.root.classList.toggle('far', map.getZoom() < 13);
    m.root.onclick = ev => { ev.stopPropagation(); if (opts.onClick) opts.onClick(); };
    m.body.style.transform = `rotate(${heading}deg)`;
    m.label.innerHTML = `${esc(id)}<br><small>${Math.round(spd || 0)} km/h · ${statusLabel(status)}</small>`;
    m.marker.setLngLat([lng, lat]);
  }

  setVisible(v) {
    this.visible = v;
    Object.values(this.items).forEach(m => { m.root.style.display = v ? '' : 'none'; });
  }

  keepOnly(ids) {
    Object.keys(this.items).forEach(id => {
      if (!ids.has(id)) { this.items[id].marker.remove(); delete this.items[id]; }
    });
  }

  clear() {
    Object.values(this.items).forEach(m => m.marker.remove());
    this.items = {};
  }
}

// ---------- live view ----------
const liveTrucks = new TruckSet();
const livePrev = {};
const LIVE_FLAGS = { layer: true, replay: false };

function setLiveTrucks(flag, value) {
  LIVE_FLAGS[flag] = value;
  liveTrucks.setVisible(LIVE_FLAGS.layer && !LIVE_FLAGS.replay);
}

// direction of the last stretch where the truck was moving (from the replay data, if present)
function lastMovingHeading(id) {
  const pts = window.REPLAY_DATA?.trucks?.[id]?.pts;
  if (!pts) return 0;
  for (let i = pts.length - 2; i >= 0; i--) {
    if (pts[i][3] >= 2) {
      const a = pts[i], b = pts[i + 1];
      return Math.atan2((b[1] - a[1]) * Math.cos(a[2] * Math.PI / 180), b[2] - a[2]) * 180 / Math.PI;
    }
  }
  return 0;
}

function updateLiveTrucks(features) {
  const seen = new Set();
  (features || []).forEach(f => {
    const p = f.properties, id = p.vehicle_id, [lng, lat] = f.geometry.coordinates;
    let h = liveTrucks.heading(id);
    if (h === null) h = lastMovingHeading(id);
    const pr = livePrev[id];
    if (pr) {   // turn towards the direction the truck moved since the last update
      const dx = (lng - pr[0]) * Math.cos(lat * Math.PI / 180) * 111320, dy = (lat - pr[1]) * 110574;
      if (Math.hypot(dx, dy) > 2) h = Math.atan2(dx, dy) * 180 / Math.PI;
    }
    livePrev[id] = [lng, lat];
    seen.add(id);
    liveTrucks.place(id, lng, lat, h, p.status, p.speed_kmph, {
      selected: id === selectedVehicleId,
      onClick: () => onVehicleClick({ features: [f] }),
    });
  });
  liveTrucks.keepOnly(seen);
}
