# GeoMines AI

Open-pit mine monitoring with GIS. A login page leads to a home page of modules; the **Fleet Management**
module is built and working, the others are placeholders for now.

| Module | Status |
|---|---|
| Fleet Management | Built: live map, status and alerts, shift replay, trips and cycle time, route efficiency, hotspots, alert review, ML checks |
| Volume Analysis | Placeholder ("Coming soon") |
| Tab 3, Tab 4 | Reserved |

```
backend/    Node.js + Express API on PostgreSQL/PostGIS (login, stop detection, analytics, ML script)
frontend/   Plain HTML/JS dashboard (MapLibre): login → home → fleet
```

## Run it

You need Node.js, PostgreSQL with PostGIS, and (optional, for ML) Python 3.9+.

```bash
# 1. database
createdb minefleet
psql minefleet -f backend/schema.sql

# 2. backend
cd backend
cp .env.example .env        # set DATABASE_URL, APP_USER, APP_PASSWORD, APP_SECRET
npm install
npm run seed:demo           # optional: loads the simulated shift + demo zones and road
npm start                   # http://localhost:3001

# 3. frontend (second terminal)
cd frontend
python3 -m http.server 8000 # open http://localhost:8000 and sign in

# 4. optional: machine-learning checks
cd backend
pip install -r ml/requirements.txt
npm run ml
```

Sign in with the `APP_USER` / `APP_PASSWORD` from `backend/.env`. **Never commit `.env`** — it is in `.gitignore`.
If `APP_PASSWORD` is not set the server falls back to a demo password, so always set it.

## Fleet module

- **Stops** are built from GPS automatically (every 20 s): not moving, within 30 m, for 60 s or more. Each stop is
  matched to a pit / dump / workshop / parking zone and given a status (loading, queueing, idle, maintenance, parked).
- **Alerts**: idle and queueing stops, plus ML flags. A supervisor can mark each one *Follow up*, *Not relevant* or
  *Field check* (undo available). Reviewed alerts stop counting as open.
- **Shifts tab** (live from the database): trips, average cycle time, route efficiency, time and fuel lost per truck
  per shift, and idle/queue hotspots on the map. The older **Shift summary** button reads the static replay file.
- **Trips**: pit visit → dump visit. **Cycle** = pit arrival → next pit arrival.
  **Route efficiency** = planned distance along the haul road ÷ distance driven (100% = direct).
- **ML** (`backend/ml/fleet_ml.py`): Random Forest flags slow hauls, Isolation Forest flags unusually long stops.
  Needs 30+ trips / 50+ stops; with less it says so and does nothing.

### API (all need the login token except `/health`, `/login` and `POST /gps`)

`POST /api/login` · `GET /api/vehicles/latest` · `/stats` · `/kpis` · `/trips` · `/shift_summary` · `/hotspots` ·
`/alerts` · `POST /alerts/review` · `/tracks/:id` · `/zones` · `/haul_roads` · `/vehicle_stops` · `POST /api/gps`
(devices; protect with `GPS_API_KEY`). All fleet rules and shift hours are set in `backend/.env.example`.

## Known limits

- One login account from `.env`; there are no user roles yet.
- Updates are polling every 5 s, not WebSocket.
- Fuel loss is an estimate from an assumed idle burn rate (`IDLE_BURN_L_PER_H`, default 8 L/h).
- The demo data is simulated; every truck drives the same road, so route efficiency is about 100%.
- The map needs internet for the basemap tiles, fonts and MapLibre.
