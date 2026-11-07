/**
 * icons.js — Google Material Symbols (https://fonts.google.com/icons).
 * ICON('name') returns the icon markup; <i data-icon="name"></i> is filled by hydrateIcons().
 * Use any Material Symbols name directly, or one of the short names below.
 */
(function () {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block';
  document.head.appendChild(l);
  const s = document.createElement('style');
  s.textContent = `.ic{font-family:'Material Symbols Outlined';font-weight:400;font-style:normal;font-size:1.3em;line-height:1;
    letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;direction:ltr;width:1em;overflow:hidden;
    vertical-align:-.28em;flex:none;-webkit-font-smoothing:antialiased;font-feature-settings:'liga';
    font-variation-settings:'FILL' 0,'wght' 500,'GRAD' 0,'opsz' 24}`;
  document.head.appendChild(s);
})();

const ICON_MAP = {
  truck: 'local_shipping', bell: 'notifications', layers: 'layers', target: 'my_location', mountain: 'landscape',
  compass: 'explore', search: 'search', clock: 'schedule', wrench: 'build', alert: 'warning', zap: 'bolt',
  info: 'info', check: 'check_circle', pin: 'location_on', route: 'route', play: 'play_arrow', pause: 'pause',
  x: 'close', 'chevron-right': 'chevron_right', 'chevron-left': 'chevron_left',
};
function ICON(name) {
  return `<span class="ic" aria-hidden="true">${ICON_MAP[name] || name}</span>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = ICON(e.dataset.icon); });
}
