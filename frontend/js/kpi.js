/**
 * kpi.js — "Shift summary" button + panel: trips, cycle time, idle and queue time per truck.
 * Reads window.REPLAY_DATA.kpis (made by export_replay.py). Add: <script src="js/kpi.js"></script> after replay-data.js
 */
(function () {
    const COLORS = { moving: '#10b981', loading: '#3b82f6', queue: '#f59e0b', idle: '#ef4444', maint: '#8b5cf6', parked: '#94a3b8' };
    const LABELS = { moving: 'Moving', loading: 'Loading / dumping', queue: 'Queueing', idle: 'Idle', maint: 'Maintenance', parked: 'Parked' };
    const fmt = (v, u = '') => (v === null || v === undefined ? '—' : v + u);
    const min = m => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} m` : `${Math.round(m)} min`);

    function render(D) {
        const ids = Object.keys(D.kpis).sort(), K = D.kpis, n = ids.length || 1;
        const sum = k => ids.reduce((a, i) => a + (K[i][k] || 0), 0);
        const cyc = ids.map(i => K[i].cycle_min).filter(v => v !== null);
        const avgCycle = cyc.length ? (cyc.reduce((a, b) => a + b, 0) / cyc.length).toFixed(1) : null;
        const tile = (v, l, c) => `<div style="flex:1;min-width:130px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid ${c};border-radius:10px;padding:10px 14px">
      <div style="font-size:22px;font-weight:700">${v}</div><div style="font-size:12px;color:#64748b">${l}</div></div>`;
        const bar = k => ['moving', 'loading', 'queue', 'idle', 'maint', 'parked'].map(s =>
            `<div title="${LABELS[s]}: ${min(k[s])}" style="width:${(100 * k[s] / D.shift_min).toFixed(2)}%;background:${COLORS[s]}"></div>`).join('');
        const th = t => `<th style="text-align:right;padding:8px 10px;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">${t}</th>`;
        const td = (t, st = '') => `<td style="text-align:right;padding:9px 10px;border-bottom:1px solid #f1f5f9;${st}">${t}</td>`;
        const rows = ids.map(i => {
            const k = K[i];
            return `<tr><td style="padding:9px 10px;border-bottom:1px solid #f1f5f9;font-weight:700">${i}</td>
        ${td(k.trips)}${td(fmt(k.cycle_min, ' min'))}${td(k.dist_km + ' km')}${td(k.avg_kmph + ' km/h')}
        ${td(min(k.idle), k.idle >= 20 ? 'color:#dc2626;font-weight:700' : '')}
        ${td(min(k.queue), k.queue >= 20 ? 'color:#d97706;font-weight:700' : '')}
        ${td(k.productive_pct + '%')}
        <td style="padding:9px 10px;border-bottom:1px solid #f1f5f9;min-width:200px"><div style="display:flex;height:12px;border-radius:6px;overflow:hidden;background:#e2e8f0">${bar(k)}</div></td></tr>`;
        }).join('');
        const legend = Object.keys(COLORS).map(s =>
            `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><i style="width:10px;height:10px;border-radius:3px;background:${COLORS[s]}"></i>${LABELS[s]}</span>`).join('');
        return `
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">Shift summary</div>
        <div style="font-size:13px;color:#64748b">${n} trucks · ${(D.shift_min / 60).toFixed(0)}-hour shift · simulated data</div></div>
        <button id="kpiClose" style="border:0;background:#f1f5f9;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px">Close</button></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${tile(sum('trips'), 'Trips completed', '#3b82f6')}${tile(fmt(avgCycle, ' min'), 'Average cycle time', '#10b981')}
        ${tile(min(sum('idle')), 'Total idle time', '#ef4444')}${tile(min(sum('queue')), 'Total queue time', '#f59e0b')}
        ${tile((sum('productive_pct') / n).toFixed(0) + '%', 'Productive time', '#8b5cf6')}</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b;border-bottom:1px solid #e2e8f0">Truck</th>
        ${th('Trips')}${th('Avg cycle')}${th('Distance')}${th('Avg speed')}${th('Idle')}${th('Queue')}${th('Productive')}
        <th style="padding:8px 10px;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;text-align:left">How the shift was spent</th></tr>${rows}</table></div>
      <div style="margin-top:12px;font-size:12px;color:#475569">${legend}</div>
      <div style="margin-top:10px;font-size:11px;color:#94a3b8">Trip = one dump visit. Cycle time = pit visit to the next pit visit.
      Productive = moving + loading / dumping. Red idle = 20 min or more; amber queue = 20 min or more.</div>`;
    }

    function open() {
        const D = window.REPLAY_DATA;
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px';
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;color:#0f172a;border-radius:16px;padding:22px;max-width:1000px;width:100%;max-height:90vh;overflow:auto;font-family:system-ui,sans-serif';
        card.innerHTML = D && D.kpis ? render(D)
            : '<b>No KPI data yet.</b><p>Run <code>python export_replay.py</code> and copy the new <code>sim_output/replay-data.js</code> into the js folder.</p><button id="kpiClose">Close</button>';
        ov.appendChild(card); document.body.appendChild(ov);
        const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
        const esc = e => { if (e.key === 'Escape') close(); };
        ov.onclick = e => { if (e.target === ov) close(); };
        card.querySelector('#kpiClose').onclick = close;
        document.addEventListener('keydown', esc);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.createElement('button');
        btn.id = 'kpiBtn';
        btn.innerHTML = ICON('bar_chart') + ' Shift summary';
        btn.className = 'replay-btn';   // same look as the Replay shift button
        btn.onclick = open;
        const host = document.querySelector('.top-actions');
        if (host) host.insertBefore(btn, host.firstChild);
        else { btn.style.cssText += ';position:absolute;top:14px;right:200px;z-index:90'; document.getElementById('app')?.appendChild(btn); }
    });

    window.__kpiRender = render;   // for testing
})();
