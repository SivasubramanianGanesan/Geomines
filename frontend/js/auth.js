/** auth.js — login, logout and page guard. The token comes from POST /api/login and lives in sessionStorage. */
const AUTH = {
  base: 'http://localhost:3001/api',          // keep the same as CONFIG.API_BASE in config.js
  token: () => sessionStorage.getItem('gm_token'),
  user:  () => sessionStorage.getItem('gm_user'),
  async login(username, password) {
    const r = await fetch(this.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Login failed');
    sessionStorage.setItem('gm_token', d.token);
    sessionStorage.setItem('gm_user', d.user);
  },
  logout() { sessionStorage.clear(); (window.top || window).location.href = 'index.html'; },
  guard()  { if (!this.token()) { (window.top || window).location.href = 'index.html'; return false; } return true; },
};
