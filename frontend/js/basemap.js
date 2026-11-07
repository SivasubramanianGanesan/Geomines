/** basemap.js — switch the base layer: Satellite / Streets / Terrain / Dark. Needs the map to be loaded. */
(function () {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const BASES = [
    { id: 'satellite', label: 'Satellite', layer: 'satellite-base' },
    { id: 'streets', label: 'Streets', max: 16, attr: 'Tiles © Esri',
      tiles: [ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}'] },
    { id: 'terrain', label: 'Terrain', max: 16, attr: 'Tiles © Esri',
      tiles: [ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}'] },
    { id: 'dark', label: 'Dark', max: 19, attr: '© OpenStreetMap contributors © CARTO',
      tiles: ['a', 'b', 'c'].map(s => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`) },
  ];

  function css() {
    const s = document.createElement('style');
    s.textContent = `
    #basemapPicker{position:absolute;top:60px;left:60px;z-index:80;display:flex;gap:4px;padding:4px;
      background:var(--surface-glass);border:1px solid var(--border-bright);border-radius:10px;box-shadow:var(--shadow-sm)}
    #basemapPicker button{background:none;border:0;color:var(--t2);font-size:12px;padding:6px 10px;
      border-radius:7px;cursor:pointer}
    #basemapPicker button:hover{color:var(--t1);background:rgba(255,255,255,.08)}
    #basemapPicker button.on{background:var(--accent);color:#fff}`;
    document.head.appendChild(s);
  }

  function select(id) {
    BASES.forEach(b => map.setLayoutProperty(b.layer || 'base-' + b.id, 'visibility', b.id === id ? 'visible' : 'none'));
    // the place-name overlay only belongs on the satellite image
    const lab = document.getElementById('toggle-labels');
    const labelsOn = !lab || lab.classList.contains('on');
    map.setLayoutProperty('labels-overlay', 'visibility', id === 'satellite' && labelsOn ? 'visible' : 'none');
    document.querySelectorAll('#basemapPicker button').forEach(btn => btn.classList.toggle('on', btn.dataset.id === id));
  }

  window.initBasemap = function () {
    BASES.forEach(b => {
      if (!b.tiles) return;
      map.addSource('base-' + b.id, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.max, attribution: b.attr });
      // inserted just under the label overlay, so all data layers stay on top
      map.addLayer({ id: 'base-' + b.id, type: 'raster', source: 'base-' + b.id, layout: { visibility: 'none' } }, 'labels-overlay');
    });
    css();
    const box = document.createElement('div');
    box.id = 'basemapPicker';
    box.innerHTML = BASES.map(b => `<button data-id="${b.id}">${b.label}</button>`).join('');
    box.onclick = e => { const id = e.target.dataset?.id; if (id) select(id); };
    document.getElementById('app').appendChild(box);
    select('satellite');
  };
})();