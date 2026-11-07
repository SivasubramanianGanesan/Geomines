/**
 * replay.js — replay the simulated shift as moving trucks.
 * Needs js/replay-data.js (made by export_replay.py). Without it, nothing is added.
 */
(function () {
  const TRAIL_S = 300;          // length of the trail behind each truck (seconds)
  let D, playing = false, t = 0, speed = 60, last = 0, active = false;
  const el = {};

  function css() {
    const s = document.createElement('style');
    s.textContent = `
    #replayBar{position:absolute;left:60px;right:calc(var(--panel-w) + 50px);bottom:36px;z-index:85;
      display:none;align-items:center;gap:10px;padding:8px 12px;border-radius:12px;
      background:var(--surface-glass);border:1px solid var(--border-bright);color:var(--t1);font-size:12px;box-shadow:var(--shadow)}
    #replayBar.on{display:flex}
    #replayBar button,#replayBar select{background:var(--bg-card);color:var(--t1);
      border:1px solid var(--border-bright);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}
    #replayBar input[type=range]{flex:1;accent-color:var(--brand-red)}
    #replayClock{min-width:92px;text-align:right;font-variant-numeric:tabular-nums}
    #replayToggle.hidden{display:none}`;
    document.head.appendChild(s);
  }

  function ui() {
    const app = document.getElementById('app');
    const tg = document.createElement('button');
    tg.id = 'replayToggle'; tg.className = 'replay-btn'; tg.innerHTML = ICON('play') + ' Replay shift';
    const bar = document.createElement('div');
    bar.id = 'replayBar';
    bar.innerHTML = `
      <button id="rpPlay">${ICON('play')} Play</button>
      <input id="rpSlider" type="range" min="0" max="${D.duration}" step="1" value="0">
      <span id="replayClock">06:00:00</span>
      <select id="rpSpeed">
        <option value="30">30×</option><option value="60" selected>60×</option>
        <option value="120">120×</option><option value="300">300×</option>
      </select>
      <button id="rpExit">${ICON('x')} Live</button>`;
    const actions = document.querySelector('.top-actions');
    actions.insertBefore(tg, actions.firstChild); app.appendChild(bar);
    Object.assign(el, { tg, bar, play: bar.querySelector('#rpPlay'), slider: bar.querySelector('#rpSlider'),
      clock: bar.querySelector('#replayClock'), speed: bar.querySelector('#rpSpeed'), exit: bar.querySelector('#rpExit') });

    tg.onclick = enter;
    el.exit.onclick = leave;
    el.play.onclick = () => setPlaying(!playing);
    el.slider.oninput = () => { t = +el.slider.value; draw(); };
    el.speed.onchange = () => { speed = +el.speed.value; };
  }

  function layers() {
    const empty = { type: 'FeatureCollection', features: [] };
    map.addSource('replay-trails', { type: 'geojson', data: empty });
    map.addLayer({ id: 'replay-trails', type: 'line', source: 'replay-trails',
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': statusColorExpr(), 'line-width': 3, 'line-opacity': 0.6 } });
  }

  const trucks = new TruckSet();

  // index of the last point with time <= t
  function idxAt(pts, tt) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m][0] <= tt) lo = m; else hi = m - 1; }
    return lo;
  }

  function statusAt(tr, tt, spd) {
    for (const s of tr.stops) if (tt >= s[0] && tt <= s[1]) return s[2];
    return spd >= 2 ? 'moving' : 'short_stop';
  }

  function draw() {
    const trails = [];
    for (const [vid, tr] of Object.entries(D.trucks)) {
      const p = tr.pts;
      if (!p.length || t < p[0][0]) continue;
      const i = idxAt(p, t), a = p[i], b = p[Math.min(i + 1, p.length - 1)];
      const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
      const lng = a[1] + (b[1] - a[1]) * f, lat = a[2] + (b[2] - a[2]) * f;
      const status = statusAt(tr, t, a[3]);
      // heading from the direction of travel; keep the last one while stopped
      const prev = trucks.heading(vid) ?? 0;
      let heading = prev;
      if (a[3] >= 2 && (b[1] !== a[1] || b[2] !== a[2])) {
        heading = Math.atan2((b[1] - a[1]) * Math.cos(a[2] * Math.PI / 180), b[2] - a[2]) * 180 / Math.PI;
      }
      trucks.place(vid, lng, lat, heading, status, a[3]);
      const j = idxAt(p, Math.max(0, t - TRAIL_S));
      const line = p.slice(j, i + 1).map(q => [q[1], q[2]]);
      line.push([lng, lat]);
      if (line.length > 1) trails.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line },
        properties: { status } });
    }
    map.getSource('replay-trails').setData({ type: 'FeatureCollection', features: trails });
    el.slider.value = t;
    const clock = new Date(new Date(D.start).getTime() + t * 1000);
    el.clock.textContent = clock.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' });
  }

  function frame(now) {
    if (!playing) return;
    t = Math.min(D.duration, t + ((now - last) / 1000) * speed);
    last = now;
    draw();
    if (t >= D.duration) { setPlaying(false); return; }
    requestAnimationFrame(frame);
  }

  function setPlaying(on) {
    playing = on;
    el.play.innerHTML = on ? ICON('pause') + ' Pause' : ICON('play') + ' Play';
    if (on) { if (t >= D.duration) t = 0; last = performance.now(); requestAnimationFrame(frame); }
  }

  function showLayers(on) {
    map.setLayoutProperty('replay-trails', 'visibility', on ? 'visible' : 'none');
    if (!on) trucks.clear();
    // hide the live trucks while the replay is running
    setLiveTrucks('replay', on);
  }

  function enter() {
    active = true; t = 0;
    el.tg.classList.add('hidden'); el.bar.classList.add('on');
    showLayers(true); draw();
    fitToData([map.getSource('haul-roads')._data, map.getSource('zones')._data]);
    setPlaying(true);
  }

  function leave() {
    active = false; setPlaying(false);
    el.bar.classList.remove('on'); el.tg.classList.remove('hidden');
    showLayers(false);
  }

  window.initReplay = function () {
    D = window.REPLAY_DATA;
    if (!D || !D.trucks) {
      // keep the button visible, so it is clear what is missing
      console.info('[Replay] replay-data.js not found');
      const b = document.createElement('button');
      b.id = 'replayToggle'; b.className = 'replay-btn'; b.innerHTML = ICON('play') + ' Replay shift';
      b.onclick = () => showToast('warning', 'Replay data not found', 'Put replay-data.js in the js folder. Make it with export_replay.py.');
      const actions = document.querySelector('.top-actions');
      actions.insertBefore(b, actions.firstChild);
      return;
    }
    css(); ui(); layers();
  };
})();
