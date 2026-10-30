# Solar Dashboard – Optimum Financial Services Group

Route 21 Corporate Park, 56 Regency Dr, Irene, Pretoria, 0157 · two VRM installations:

| VRM id | Name in VRM | Detail page |
| --- | --- | --- |
| 329491 | Pentagon Partners 15QU, 18x545, 3x4.8PT | `/?site=329491` |
| 327307 | Westside Tradings 15QU, 18x545, 3x4.8PT | `/?site=327307` |

**Side by side:** `/side-by-side` shows both live energy flows next to each other, with combined totals, alerts per site and a full-screen wall-display mode.

Set the installations in `.env`:

```
VRM_SITES=329491=Pentagon Partners;327307=Westside Tradings
```

One live page showing all the power in the Victron system (VRM installation **329491**). The VRM portal splits the numbers across several screens.

- **Solar**: total, plus each MPPT (Solar Charger 278 and 279), plus kWh made today
- **Battery**: state of charge, charging/discharging power, voltage, current, state
- **Grid**: total import/export, plus each phase (L1, L2, L3)
- **Consumption**: total building load, plus each phase, plus the inverter (VE.Bus) state
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

## Design (PrimeBridge brand + Motion Kit)

- Brand tokens, logo partials (`views/partials/brand-*.ejs`) and the favicon come from `C:\Dev\prime-login`. Don't edit the logo; take updates from there.
- `public/motion/motion.css` and `motion.js` are the **PrimeBridge Motion Kit**, copied as-is from prime-login. Every animation uses `Motion.*`.
- **Energy flow** (`views/index.ejs` + `views/partials/flow-node.ejs`): the dashes move along horizontal/vertical wires only, the speed follows the power, and idle wires fade out. A node gives a short scale pulse when its value changes noticeably. Phones get a compact 2 × 2 layout (`LAYOUTS` in `public/app.js`).
- **Notifications**:
  - Global alerts are full width in brand grey. Errors stay until they're solved; warnings can be dismissed.
  - Container alerts sit inside a card.
  - Toasts appear lower right and hide after 7 seconds.
  - The bell carries a red generic badge with a count.
  - Signal badges use a shape plus a colour: circle = OK/info, rhombus = warning, triangle = critical.
- **Alert rules** live in `buildAlerts()` in `src/vrm.js`. The connection alerts are in `/api/live` in `index.js`.
- **Reduce motion** is respected: nothing moves, but every state change still shows.
- **Full screen**: the button on the energy flow puts it full screen for a wall display. It keeps updating live, keeps the screen awake, and Esc exits.

## Useful URLs

- `/api/health`: whether VRM (per site) and MySQL are OK
- `/api/live?site=327307`: the live JSON for one site
- `/api/live/all`: every site at once (used by the side-by-side page)
- `/api/history?site=327307&hours=24`: saved readings for one site

## Notes

- Sign conventions: battery **+ charging / − discharging**; grid **+ importing / − exporting**.
- Times in MySQL are UTC. The `daily_summary` view converts them to SAST (UTC+2).
- If MySQL can't be reached, the live dashboard still works; it just stops saving history.
