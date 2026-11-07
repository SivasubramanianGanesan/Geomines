/**
 * map.js — MapLibre GL JS initialisation and all spatial layer management
 *
 * Layers (bottom → top):
 *   satellite-base   → ESRI World Imagery raster tiles
 *   labels-overlay   → ESRI label overlay
 *   lease-boundary   → lease polygon outline
 *   zones-fill       → zone polygons
 *   zones-outline    → zone polygon borders
 *   haul-roads       → haul road LineStrings
 *   blast-radius     → blast event circles
 *   blast-points     → blast event centres
 *   stops-heat       → vehicle stop circles (sized by duration)
 *   tracks-line      → selected vehicle track trail
 *   vehicles-points  → live vehicle GPS fixes
 *   vehicles-labels  → speed label badges
 */

let map;
let popup;
let selectedVehicleId = null;
let trackHours = CONFIG.TRACK_HOURS;
let lastVehicleFeatures = [];

// Layer visibility state (toggled from side panel)
const layerVisibility = {
  'lease-boundary':  true,
  'zones':           true,
  'haul-roads':      true,
  'blast-events':    true,
  'vehicle-stops':   true,
  'track':           true,
  'vehicles':        true,
};

// ─── Initialise MapLibre ──────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'esri-satellite': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          attribution: 'Tiles © Esri — Source: Esri, Maxar, GeoEye, Earthstar Geographics',
          maxzoom: 19,
        },
        'esri-labels': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          maxzoom: 19,
        },
      },
      layers: [
        { id: 'satellite-base', type: 'raster', source: 'esri-satellite' },
        { id: 'labels-overlay', type: 'raster', source: 'esri-labels', paint: { 'raster-opacity': 0.85 } },
      ],
    },
    center: CONFIG.MAP.CENTER,
    zoom:   CONFIG.MAP.ZOOM,
    minZoom: CONFIG.MAP.MIN_ZOOM,
    maxZoom: CONFIG.MAP.MAX_ZOOM,
    pitch:  CONFIG.MAP.PITCH,
    bearing: 0,
    attributionControl: false,
  });

  // Built-in controls
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  // Reusable popup
  popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    maxWidth: '300px',
    offset: 12,
  });

  map.on('load', onMapLoad);
  map.on('mousemove', onMapMouseMove);
  map.on('click', onMapClick);
  map.on('moveend', () => {
    // hide coord readout while panning stops
  });
}

// ─── Map loaded — add all data sources & layers ───────────────────────────────
async function onMapLoad() {
  // 1. Add empty GeoJSON sources (data filled in async)
  const emptyColl = { type: 'FeatureCollection', features: [] };

  const sources = {
    'lease-boundary': emptyColl,
    'zones':          emptyColl,
    'haul-roads':     emptyColl,
    'blast-events':   emptyColl,
    'vehicle-stops':  emptyColl,
    'vehicles-live':  emptyColl,
    'track-line':     emptyColl,
  };
  for (const [id, data] of Object.entries(sources)) {
    map.addSource(id, { type: 'geojson', data });
  }

  // 2. Add layers (order matters — bottom to top)
  addZoneLayers();
  addLeaseBoundaryLayer();
  addHaulRoadsLayer();
  addBlastEventLayers();
  addVehicleStopsLayer();
  addTrackLayer();
  addVehicleLayers();

  // 3. Load static layers from API
  await Promise.all([
    loadLeaseBoundary(),
    loadZones(),
    loadHaulRoads(),
    loadBlastEvents(),
    loadVehicleStops(),
  ]);

  // Zones and roads are loaded now: make sure the map is not left at 0,0
  if (!map.getSource('lease-boundary')._data.features?.length) {
    fitToData([map.getSource('zones')._data, map.getSource('haul-roads')._data]);
  }

  // 4. Start live vehicle polling
  await loadVehiclesLatest();
  setInterval(loadVehiclesLatest, CONFIG.POLL.VEHICLES);

  showToast('success', 'Map ready', 'All layers loaded. Polling vehicles every 5s.');
}

// ─── Layer definitions ────────────────────────────────────────────────────────

function addLeaseBoundaryLayer() {
  map.addLayer({
    id: 'lease-boundary-fill',
    type: 'fill',
    source: 'lease-boundary',
    paint: {
      'fill-color': 'rgba(239,68,68,0.04)',
    },
  });
  map.addLayer({
    id: 'lease-boundary-line',
    type: 'line',
    source: 'lease-boundary',
    paint: {
      'line-color': '#ef4444',
      'line-width': 2.5,
      'line-dasharray': [5, 3],
    },
  });
}

function addZoneLayers() {
  // Fill — color driven by zone_type property
  map.addLayer({
    id: 'zones-fill',
    type: 'fill',
    source: 'zones',
    paint: {
      'fill-color': [
        'match', ['get', 'zone_type'],
        'pit',        'rgba(239,68,68,0.22)',
        'dump',       'rgba(249,115,22,0.22)',
        'workshop',   'rgba(59,130,246,0.22)',
        'parking',    'rgba(139,92,246,0.22)',
        'restricted', 'rgba(220,38,38,0.28)',
        'safe',       'rgba(16,185,129,0.18)',
        'blasting',   'rgba(251,191,36,0.28)',
        /* default */ 'rgba(100,116,139,0.18)',
      ],
      'fill-opacity': 0.9,
    },
  });
  // Outline
  map.addLayer({
    id: 'zones-outline',
    type: 'line',
    source: 'zones',
    paint: {
      'line-color': [
        'match', ['get', 'zone_type'],
        'pit',        '#ef4444',
        'dump',       '#f97316',
        'workshop',   '#3b82f6',
        'parking',    '#8b5cf6',
        'restricted', '#dc2626',
        'safe',       '#10b981',
        'blasting',   '#fbbf24',
        '#64748b',
      ],
      'line-width': 1.5,
    },
  });
  // Zone labels
  map.addLayer({
    id: 'zones-labels',
    type: 'symbol',
    source: 'zones',
    layout: {
      'text-field': ['concat', ['upcase', ['get', 'zone_type']], '\n', ['get', 'name']],
      'text-font':  ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size':  11,
      'text-anchor': 'center',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#e2e8f0',
      'text-halo-color': 'rgba(0,0,0,0.6)',
      'text-halo-width': 1.5,
    },
    minzoom: 12,
  });
}

function addHaulRoadsLayer() {
  // Road casing (outline)
  map.addLayer({
    id: 'haul-roads-casing',
    type: 'line',
    source: 'haul-roads',
    paint: {
      'line-color': '#78350f',
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 18, 20],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  // Road fill
  map.addLayer({
    id: 'haul-roads-fill',
    type: 'line',
    source: 'haul-roads',
    paint: {
      'line-color': '#fcd34d',
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 18, 12],
      'line-opacity': 0.85,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  // Direction arrows (symbols along line)
  map.addLayer({
    id: 'haul-roads-arrows',
    type: 'symbol',
    source: 'haul-roads',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 100,
      'text-field': '▶',
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 10,
      'text-keep-upright': false,
      'text-rotate': 0,
    },
    paint: {
      'text-color': '#92400e',
      'text-opacity': 0.8,
    },
    minzoom: 13,
  });
}

function addBlastEventLayers() {
  // Blast radius circle
  map.addLayer({
    id: 'blast-radius',
    type: 'circle',
    source: 'blast-events',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        12, ['interpolate', ['linear'], ['get', 'charge_kg'], 0, 8, 1000, 30],
        18, ['interpolate', ['linear'], ['get', 'charge_kg'], 0, 30, 1000, 100],
      ],
      'circle-color': 'rgba(239,68,68,0.15)',
      'circle-stroke-color': '#ef4444',
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.7,
    },
  });
  // Blast centre marker
  map.addLayer({
    id: 'blast-centre',
    type: 'circle',
    source: 'blast-events',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 18, 8],
      'circle-color': '#ef4444',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
}

function addVehicleStopsLayer() {
  map.addLayer({
    id: 'stops-circle',
    type: 'circle',
    source: 'vehicle-stops',
    filter: ['!=', ['get', 'status'], 'loading_dumping'],   // routine loading is not shown
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        12, ['interpolate', ['linear'], ['get', 'minutes'], 0, 4, 60, 12],
        18, ['interpolate', ['linear'], ['get', 'minutes'], 0, 10, 60, 30],
      ],
      'circle-color': statusColorExpr(),
      'circle-stroke-color': statusColorExpr(),
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.45,
    },
  });
  map.addLayer({
    id: 'stops-label',
    type: 'symbol',
    source: 'vehicle-stops',
    filter: ['!=', ['get', 'status'], 'loading_dumping'],
    layout: {
      'text-field': ['concat', ['get', 'vehicle_id'], '\n', ['to-string', ['round', ['get', 'minutes']]], 'm'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 9,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#93c5fd',
      'text-halo-color': 'rgba(0,0,0,0.7)',
      'text-halo-width': 1,
    },
    minzoom: 13,
  });
}

function addTrackLayer() {
  // Track line
  map.addLayer({
    id: 'track-line',
    type: 'line',
    source: 'track-line',
    paint: {
      'line-color': '#a78bfa',
      'line-width': 2,
      'line-opacity': 0.7,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  // Track direction arrows
  map.addLayer({
    id: 'track-arrows',
    type: 'symbol',
    source: 'track-line',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 80,
      'text-field': '▸',
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 12,
      'text-keep-upright': false,
    },
    paint: {
      'text-color': '#c4b5fd',
      'text-halo-color': 'rgba(0,0,0,0.5)',
      'text-halo-width': 1,
    },
  });
}

function addVehicleLayers() {
  // Vehicle circles (live positions)
  map.addLayer({
    id: 'vehicles-circle',
    type: 'circle',
    source: 'vehicles-live',
    layout: { visibility: 'none' },   // trucks are drawn as icon markers (truck-markers.js)
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 18, 14],
      'circle-color': statusColorExpr(),   // colour by zone-aware status
      'circle-stroke-color': [
        'case',
        ['==', ['get', 'vehicle_id'], selectedVehicleId || ''], '#fff',
        'rgba(0,0,0,0.5)',
      ],
      'circle-stroke-width': [
        'case',
        ['==', ['get', 'vehicle_id'], selectedVehicleId || ''], 3,
        1.5,
      ],
      'circle-opacity': [
        'interpolate', ['linear'], ['zoom'], 10, 0.9, 18, 1
      ],
    },
  });

  // Pulse ring for moving vehicles (outer glow)
  map.addLayer({
    id: 'vehicles-pulse',
    type: 'circle',
    source: 'vehicles-live',
    layout: { visibility: 'none' },
    filter: ['==', ['get', 'status'], 'moving'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 18, 22],
      'circle-color': 'rgba(16,185,129,0)',
      'circle-stroke-color': 'rgba(16,185,129,0.4)',
      'circle-stroke-width': 2,
      'circle-opacity': 0.6,
    },
  });

  // Vehicle ID + speed label
  map.addLayer({
    id: 'vehicles-label',
    type: 'symbol',
    source: 'vehicles-live',
    layout: {
      visibility: 'none',
      'text-field': ['concat',
        ['get', 'vehicle_id'], '\n',
        ['to-string', ['round', ['get', 'speed_kmph']]], ' km/h'
      ],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 10,
      'text-offset': [0, 1.8],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#f1f5f9',
      'text-halo-color': 'rgba(0,0,0,0.75)',
      'text-halo-width': 1.5,
    },
    minzoom: 12,
  });

  // Click handlers
  map.on('click', 'vehicles-circle', onVehicleClick);
  map.on('mouseenter', 'vehicles-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'vehicles-circle', () => { map.getCanvas().style.cursor = ''; });

  // Zone clicks
  map.on('click', 'zones-fill',    onZoneClick);
  map.on('click', 'blast-centre',  onBlastClick);
  map.on('click', 'stops-circle',  onStopClick);
  map.on('click', 'haul-roads-fill', onRoadClick);

  // Hover cursors
  ['zones-fill','blast-centre','stops-circle','haul-roads-fill'].forEach(id => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

// Fit the map to whatever data exists (used when there is no lease boundary,
// e.g. the simulated demo only creates zones and a haul road)
function fitToData(collections) {
  const b = new maplibregl.LngLatBounds();
  let any = false;
  const add = c => {
    if (Array.isArray(c) && typeof c[0] === 'number') { b.extend(c); any = true; }
    else if (Array.isArray(c)) c.forEach(add);
  };
  collections.forEach(fc => (fc?.features || []).forEach(f => add(f.geometry?.coordinates)));
  if (any) map.fitBounds(b, { padding: 80, duration: 1500, pitch: 30, maxZoom: 17 });
  return any;
}

async function loadLeaseBoundary() {
  const data = await apiFetch('/lease_boundary');
  if (!data) { fitToData([map.getSource('zones')._data, map.getSource('haul-roads')._data]); return; }
  map.getSource('lease-boundary').setData(data);
  // Auto-fit map to boundary
  if (data.bbox && data.bbox.length === 4) {
    map.fitBounds(
      [[data.bbox[0], data.bbox[1]], [data.bbox[2], data.bbox[3]]],
      { padding: 60, duration: 1500, pitch: 30 }
    );
  } else {
    fitToData([map.getSource('zones')._data, map.getSource('haul-roads')._data]);
  }
}

async function loadZones() {
  const data = await apiFetch('/zones');
  if (data) map.getSource('zones').setData(data);
}

async function loadHaulRoads() {
  const data = await apiFetch('/haul_roads');
  if (data) map.getSource('haul-roads').setData(data);
}

async function loadBlastEvents() {
  const data = await apiFetch('/blast_events');
  if (data) map.getSource('blast-events').setData(data);
}

async function loadVehicleStops() {
  const data = await apiFetch(`/vehicle_stops?hours=${trackHours}`);
  if (data) map.getSource('vehicle-stops').setData(data);
}

async function loadVehiclesLatest() {
  const data = await apiFetch('/vehicles/latest');
  if (!data) return;
  if (data.at) dataClock = new Date(data.at).getTime();
  lastVehicleFeatures = data.features;
  map.getSource('vehicles-live').setData(data);
  if (window.updateLiveTrucks) updateLiveTrucks(data.features);
  // Also update side panel vehicle list
  if (window.updateVehicleList) updateVehicleList(data.features);
}

// Clean up a track line: drop GPS jitter (points closer than minStep metres), then Douglas-Peucker
function simplifyCoords(coords, minStep = 12, eps = 4) {
  if (!coords || coords.length < 3) return coords;
  const k = Math.cos(coords[0][1] * Math.PI / 180) * 111320, ky = 110574;
  const xy = c => [c[0] * k, c[1] * ky];
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const a = xy(kept[kept.length - 1]), b = xy(coords[i]);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= minStep) kept.push(coords[i]);
  }
  kept.push(coords[coords.length - 1]);
  const P = kept.map(xy), keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = P[s], [x2, y2] = P[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    let dmax = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = len < 1e-6 ? Math.hypot(P[i][0] - x1, P[i][1] - y1)
                           : Math.abs(dy * P[i][0] - dx * P[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return kept.filter((_, i) => keep[i]);
}

async function loadVehicleTrack(vehicleId, hours) {
  hours = hours || trackHours;
  const data = await apiFetch(`/tracks/${encodeURIComponent(vehicleId)}/line?hours=${hours}`);
  if (data) {
    data.features.forEach(f => {
      if (f.geometry.type === 'LineString') f.geometry.coordinates = simplifyCoords(f.geometry.coordinates);
      else if (f.geometry.type === 'MultiLineString') f.geometry.coordinates = f.geometry.coordinates.map(l => simplifyCoords(l));
    });
    map.getSource('track-line').setData(data);
    if (data.features.length > 0) {
      showToast('info', 'Track loaded', `${data.features[0].properties.point_count} points, last ${hours}h`);
    }
  }
}

// ─── Map event handlers ───────────────────────────────────────────────────────

function onVehicleClick(e) {
  const f = e.features[0];
  const props = f.properties;
  const coords = f.geometry.coordinates;

  selectedVehicleId = props.vehicle_id;

  // Repaint to show selection ring
  map.setPaintProperty('vehicles-circle', 'circle-stroke-color', [
    'case',
    ['==', ['get', 'vehicle_id'], selectedVehicleId], '#ffffff',
    'rgba(0,0,0,0.5)',
  ]);
  map.setPaintProperty('vehicles-circle', 'circle-stroke-width', [
    'case',
    ['==', ['get', 'vehicle_id'], selectedVehicleId], 3,
    1.5,
  ]);

  const stale = props.status === 'offline';
  const icon  = vehicleIcon(props.vehicle_type);
  const color = vehicleColor(props.vehicle_type);

  popup.setLngLat(coords)
    .setHTML(`
      <div class="popup-header">
        <div class="popup-icon">${icon}</div>
        <div>
          <div class="popup-id">${esc(props.vehicle_id)}</div>
          <div class="popup-type">${esc(props.vehicle_type || 'Unknown type')}</div>
        </div>
      </div>
      <div class="popup-body">
        <div class="popup-row">
          <span class="pk">Status</span>
          <span class="pv" style="color:${statusColor(props.status)}">${statusLabel(props.status)}${props.stop_minutes != null && props.stop_minutes !== 'null' ? ' · ' + props.stop_minutes + ' min' : ''}</span>
        </div>
        <div class="popup-row">
          <span class="pk">Speed</span>
          <span class="pv">${(props.speed_kmph||0).toFixed(1)} km/h</span>
        </div>
        <div class="popup-row">
          <span class="pk">Satellites</span>
          <span class="pv">${props.sats || '—'}</span>
        </div>
        <div class="popup-row">
          <span class="pk">Last fix</span>
          <span class="pv ${stale?'stopped':''}">${timeAgo(props.ts)}</span>
        </div>
        <div class="popup-row">
          <span class="pk">Coordinates</span>
          <span class="pv" style="font-family:'JetBrains Mono',monospace;font-size:10px">
            ${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}
          </span>
        </div>
      </div>
      <div class="popup-actions">
        <button class="popup-btn popup-btn-primary" onclick="flyAndTrack('${esc(props.vehicle_id)}')">
          ${ICON('route')} Show Track
        </button>
        <button class="popup-btn popup-btn-secondary" onclick="centerOnVehicle(${coords[0]},${coords[1]})">
          ${ICON('pin')} Centre
        </button>
      </div>
    `)
    .addTo(map);

  // Highlight in vehicle list
  if (window.highlightVehicleInList) highlightVehicleInList(props.vehicle_id);
}

function onZoneClick(e) {
  const p = e.features[0].properties;
  const coords = e.lngLat;
  popup.setLngLat(coords)
    .setHTML(`
      <div class="popup-header">
        <div class="popup-icon">${ICON('layers')}</div>
        <div>
          <div class="popup-id">${p.name}</div>
          <div class="popup-type">Zone — ${p.zone_type}</div>
        </div>
      </div>
    `)
    .addTo(map);
}

function onBlastClick(e) {
  const p = e.features[0].properties;
  popup.setLngLat(e.lngLat)
    .setHTML(`
      <div class="popup-header">
        <div class="popup-icon">${ICON('alert')}</div>
        <div>
          <div class="popup-id">Blast Event #${p.id}</div>
          <div class="popup-type">${new Date(p.ts).toLocaleString()}</div>
        </div>
      </div>
      <div class="popup-body">
        <div class="popup-row"><span class="pk">Charge</span><span class="pv">${p.charge_kg?.toFixed(1)} kg</span></div>
      </div>
    `)
    .addTo(map);
}

function onStopClick(e) {
  const p = e.features[0].properties;
  popup.setLngLat(e.lngLat)
    .setHTML(`
      <div class="popup-header">
        <div class="popup-icon">${ICON('clock')}</div>
        <div>
          <div class="popup-id">${esc(p.vehicle_id)}</div>
          <div class="popup-type">Stop — ${esc(p.zone_type || p.label || 'Unknown')}</div>
        </div>
      </div>
      <div class="popup-body">
        <div class="popup-row"><span class="pk">Duration</span><span class="pv">${(p.minutes||0).toFixed(1)} min</span></div>
        <div class="popup-row"><span class="pk">Started</span><span class="pv">${timeAgo(p.start_ts)}</span></div>
        <div class="popup-row"><span class="pk">Status</span><span class="pv" style="color:${statusColor(p.status)}">${statusLabel(p.status)}</span></div>
      </div>
    `)
    .addTo(map);
}

function onRoadClick(e) {
  const p = e.features[0].properties;
  popup.setLngLat(e.lngLat)
    .setHTML(`
      <div class="popup-header">
        <div class="popup-icon">${ICON('route')}</div>
        <div>
          <div class="popup-id">${p.name}</div>
          <div class="popup-type">Haul Road</div>
        </div>
      </div>
    `)
    .addTo(map);
}

function onMapClick(e) {
  // If not clicking a feature, deselect vehicle
  const features = map.queryRenderedFeatures(e.point, {
    layers: ['vehicles-circle','zones-fill','blast-centre','stops-circle','haul-roads-fill']
  });
  if (features.length === 0) {
    popup.remove();
  }
}

function onMapMouseMove(e) {
  const el = document.getElementById('coordReadout');
  if (el) {
    el.textContent = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;
  }
}

// ─── Public API (called from panels.js or inline HTML) ───────────────────────

function flyAndTrack(vehicleId) {
  loadVehicleTrack(vehicleId, trackHours);
  if (window.highlightVehicleInList) highlightVehicleInList(vehicleId);
  // Find latest position and fly to it
  const feat = lastVehicleFeatures.find(f => f.properties.vehicle_id === vehicleId);
  if (feat) {
    map.flyTo({ center: feat.geometry.coordinates, zoom: 16, duration: 1200, pitch: 45 });
  }
}

function centerOnVehicle(lng, lat) {
  map.flyTo({ center: [lng, lat], zoom: 17, duration: 1000 });
}

function zoomToMine() {
  loadLeaseBoundary(); // re-fits
}

function setLayerVisibility(layerId, visible) {
  layerVisibility[layerId] = visible;
  if (layerId === 'vehicles') setLiveTrucks('layer', visible);
  const layerMap = {
    'lease-boundary': ['lease-boundary-fill', 'lease-boundary-line'],
    'zones':          ['zones-fill', 'zones-outline', 'zones-labels'],
    'haul-roads':     ['haul-roads-casing', 'haul-roads-fill', 'haul-roads-arrows'],
    'blast-events':   ['blast-radius', 'blast-centre'],
    'vehicle-stops':  ['stops-circle', 'stops-label'],
    'track':          ['track-line', 'track-arrows'],
    'vehicles':       [],   // truck icons are markers, see setLiveTrucks()
  };
  const ids = layerMap[layerId] || [];
  ids.forEach(id => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });
}

function setTrackHours(hours) {
  trackHours = hours;
  if (selectedVehicleId) loadVehicleTrack(selectedVehicleId, hours);
  loadVehicleStops();
}