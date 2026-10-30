import "dotenv/config";
import express from "express";
import { fetchSnapshot } from "./src/vrm.js";
import * as db from "./src/db.js";

const app = express();
const port = Number(process.env.PORT) || 3000;
const pollSeconds = Math.max(30, Number(process.env.POLL_SECONDS) || 60);
const browserRefreshSeconds = Math.max(5, Number(process.env.BROWSER_REFRESH_SECONDS) || 15);

const siteName = process.env.SITE_NAME || "Optimum Financial Services Group";
const siteAddress = process.env.SITE_ADDRESS || "Route 21 Corporate Park, 56 Regency Dr, Irene, Pretoria, 0157";
const siteAddressShort = process.env.SITE_ADDRESS_SHORT || "Route 21 Corporate Park, Irene";

// ---------------------------------------------------------------------------
// Installations. VRM_SITES lists them as  id=Label;id=Label
//   VRM_SITES=329491=Pentagon Partners;327307=Westside Tradings
// The older single VRM_SITE_ID still works on its own.
// ---------------------------------------------------------------------------
function parseSites() {
  const raw = process.env.VRM_SITES?.trim();
  if (raw) {
    return raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [id, ...label] = part.split("=");
        return { id: Number(id.trim()), label: label.join("=").trim() || `Installation ${id.trim()}` };
      })
      .filter((s) => Number.isInteger(s.id) && s.id > 0);
  }
  const single = Number(process.env.VRM_SITE_ID);
  return single ? [{ id: single, label: process.env.SITE_LABEL || "Installation" }] : [];
}
const sites = parseSites();
if (!sites.length) {
  console.error("No installations configured. Set VRM_SITES (or VRM_SITE_ID) in .env");
  process.exit(1);
}
const siteById = new Map(sites.map((s) => [s.id, s]));
const vrmUrl = (id) => `https://vrm.victronenergy.com/installation/${id}/dashboard`;

// Per-site live state
const state = new Map(sites.map((s) => [s.id, { latest: null, lastError: null, lastSavedTimestamp: null }]));

// Ask VRM for one site's newest values; save to MySQL only when VRM has a new reading.
async function pollSite(site) {
  const st = state.get(site.id);
  try {
    st.latest = await fetchSnapshot(site.id);
    st.lastError = null;
  } catch (err) {
    st.lastError = err.message;
    console.error(`VRM ${site.label} (${site.id}): ${err.message}`);
    return;
  }
  if (db.isActive() && st.latest.timestamp !== st.lastSavedTimestamp) {
    try {
      await db.saveReading(st.latest);
      st.lastSavedTimestamp = st.latest.timestamp;
    } catch (err) {
      console.error(`MySQL save failed for ${site.label}: ${err.message}`);
    }
  }
}
// One after the other, so VRM never gets a burst of requests
async function pollAll() {
  for (const site of sites) await pollSite(site);
}

// Which site a request is about (?site=…), falling back to the first one
function pickSite(req) {
  return siteById.get(Number(req.query.site)) ?? sites[0];
}

// The live payload for one site, with connection alerts on top of the system alerts
function livePayload(site) {
  const { latest, lastError } = state.get(site.id);
  if (!latest) return { ok: false, siteId: site.id, label: site.label, error: lastError || "Waiting for the first reading from VRM..." };
  const alerts = [...latest.alerts];
  const ageMinutes = (Date.now() / 1000 - latest.timestamp) / 60;
  if (lastError) {
    alerts.unshift({
      id: "vrm-unreachable", level: "warning", scope: "global", title: "VRM is out of reach",
      message: "You're seeing the last reading we received. We keep trying and update the moment VRM answers.",
    });
  } else if (ageMinutes > 5) {
    alerts.unshift({
      id: "cerbo-quiet", level: "warning", scope: "global", title: `${site.label} has gone quiet`,
      message: `The Cerbo GX last reported ${Math.round(ageMinutes)} minutes ago. Check its internet connection.`,
    });
  }
  return { ok: true, label: site.label, vrmUrl: vrmUrl(site.id), stale: Boolean(lastError), lastError, ...latest, alerts };
}

app.disable("x-powered-by");
app.set("view engine", "ejs");
app.use(express.static("public"));

const common = () => ({ siteName, siteAddress, siteAddressShort, sites, refreshSeconds: browserRefreshSeconds, historyEnabled: db.isActive() });

// One installation in detail
app.get("/", (req, res) => {
  const site = pickSite(req);
  res.render("index.ejs", { ...common(), siteId: site.id, siteLabel: site.label, vrmUrl: vrmUrl(site.id) });
});

// Both installations next to each other
app.get("/side-by-side", (req, res) => {
  res.render("compare.ejs", { ...common(), vrmUrl });
});

app.get("/api/sites", (req, res) => {
  res.json(sites.map((s) => ({ ...s, vrmUrl: vrmUrl(s.id) })));
});

// Live numbers for the browser (served from memory, never hits VRM directly)
app.get("/api/live", (req, res) => {
  const payload = livePayload(pickSite(req));
  res.status(payload.ok ? 200 : 503).json(payload);
});

// Every site at once, for the side-by-side page
app.get("/api/live/all", (req, res) => {
  res.json({ ok: true, sites: sites.map(livePayload) });
});

// History for the charts
app.get("/api/history", async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  try {
    res.json({ ok: true, rows: await db.history(pickSite(req).id, hours) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    mysql: db.isActive() ? "connected" : "off",
    sites: sites.map((s) => {
      const { latest, lastError } = state.get(s.id);
      return {
        id: s.id,
        label: s.label,
        vrm: lastError ? `error: ${lastError}` : latest ? "ok" : "waiting",
        lastReading: latest ? new Date(latest.timestamp * 1000).toISOString() : null,
      };
    }),
  });
});

await db.init();
await pollAll();
setInterval(pollAll, pollSeconds * 1000);

// HOST=127.0.0.1 on the PROD server so only IIS (same machine) can reach the app. Unset = all interfaces (dev).
const listenArgs = process.env.HOST ? [port, process.env.HOST] : [port];
app.listen(...listenArgs, () => {
  console.log(`Solar dashboard running on http://localhost:${port}  (${sites.map((s) => s.label).join(" + ")}, VRM poll every ${pollSeconds}s)`);
  if (sites.length > 1) console.log(`Side by side:  http://localhost:${port}/side-by-side`);
});
