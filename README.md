# Solar Dashboard – Pentagon Partners

One live page showing all the power in the Victron system (VRM installation **329491**). The VRM portal splits the numbers across several screens.

- **Solar**: total, plus each MPPT (Solar Charger 278 and 279), plus kWh made today
- **Battery**: state of charge, charging/discharging power, voltage, current, state
- **Grid**: total import/export, plus each phase (L1, L2, L3)
- **Consumption**: total house load, plus each phase, plus the inverter (VE.Bus) state
- **History**: a 24-hour chart, saved to MySQL every minute
- **All device values**: every value VRM reports, grouped by device

## How it works

```
Cerbo GX ──(every 1 min)──> VRM cloud ──(VRM API, every 60s)──> Node/Express server ──> MySQL
                                                                      │
                                                     browser <── /api/live (every 15s)
```

The server is the only thing that talks to VRM. Your VRM token stays on the server and is never sent to the browser.

## Project layout

| Path | What it does |
| --- | --- |
| `index.js` | Express server: polls VRM, saves to MySQL, serves the page and the `/api/*` routes |
| `src/vrm.js` | Calls the VRM API and turns the raw values into solar, battery, grid and load figures |
| `src/db.js` | MySQL connection pool, saves readings and reads history |
| `views/index.ejs` | The dashboard page |
| `public/app.js` | Browser script that refreshes the tiles and draws the chart |
| `public/styles.css` | Styling |
| `db/schema.sql` | Creates the database, table, view and app user |
| `.env.example` | Settings template. Copy it to `.env`, which Git never commits |

## Setup (Windows 11, VS Code)

1. **Get a VRM token.** At vrm.victronenergy.com, go to *Preferences → Integrations → Access tokens → Add*. Copy the token; it is only shown once.
2. **Create the database.** RDP into the DEV MySQL server and run `db/schema.sql` in MySQL Workbench. Then uncomment the `CREATE USER` / `GRANT` lines at the bottom, set a password, and run them too.
3. **Make the settings file.** In the VS Code terminal, in `C:\Dev\solar-dashboard`, run:
   ```powershell
   copy .env.example .env
   ```
   Then open `.env` and fill in `VRM_TOKEN`, `DB_HOST` and `DB_PASSWORD`.
4. **Install and run:**
   ```powershell
   npm install
   npm run dev
   ```
5. Open http://localhost:3000

## Useful URLs

- `/api/health`: whether VRM and MySQL are OK
- `/api/live`: the live JSON the page uses
- `/api/history?hours=24`: saved readings

## Notes

- Sign conventions: battery **+ charging / − discharging**; grid **+ importing / − exporting**.
- Times in MySQL are UTC. The `daily_summary` view converts them to SAST (UTC+2).
- If MySQL can't be reached, the live dashboard still works; it just stops saving history.
