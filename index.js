import "dotenv/config";
import express from "express";
import { fetchSnapshot } from "./src/vrm.js";
import * as db from "./src/db.js";

const app = express();
const port = Number(process.env.PORT) || 3000;
const pollSeconds = Math.max(30, Number(process.env.POLL_SECONDS) || 60);
const browserRefreshSeconds = Math.max(5, Number(process.env.BROWSER_REFRESH_SECONDS) || 15);
const siteId = Number(process.env.VRM_SITE_ID);

let latest = null;
let lastError = null;
let lastSavedTimestamp = null;

// Ask VRM for the newest values; save to MySQL only when VRM has a new reading.
async function poll() {
  try {
    latest = await fetchSnapshot();
    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error(`VRM: ${err.message}`);
    return;
  }
  if (db.isActive() && latest.timestamp !== lastSavedTimestamp) {
    try {
      await db.saveReading(latest);
      lastSavedTimestamp = latest.timestamp;
    } catch (err) {
      console.error(`MySQL save failed: ${err.message}`);
    }
  }
}

app.set("view engine", "ejs");
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.render("index.ejs", {
    siteName: process.env.SITE_NAME || "Optimum Financial Services Group",
    siteAddress: process.env.SITE_ADDRESS || "Route 21 Corporate Park, 56 Regency Dr, Irene, Pretoria, 0157",
    siteAddressShort: process.env.SITE_ADDRESS_SHORT || "Route 21 Corporate Park, Irene",
    vrmUrl: `https://vrm.victronenergy.com/installation/${siteId}/dashboard`,
    siteId,
    refreshSeconds: browserRefreshSeconds,
    historyEnabled: db.isActive(),
  });
});

// Live numbers for the browser (served from memory, never hits VRM directly)
app.get("/api/live", (req, res) => {
  if (!latest) {
    return res.status(503).json({ ok: false, error: lastError || "Waiting for the first reading from VRM..." });
  }
  // Connection alerts sit on top of the system alerts from VRM
  const alerts = [...latest.alerts];
  const ageMinutes = (Date.now() / 1000 - latest.timestamp) / 60;
  if (lastError) {
    alerts.unshift({
      id: "vrm-unreachable", level: "warning", scope: "global", title: "VRM is out of reach",
      message: "You're seeing the last reading we received. We keep trying and update the moment VRM answers.",
    });
  } else if (ageMinutes > 5) {
    alerts.unshift({
      id: "cerbo-quiet", level: "warning", scope: "global", title: "Your system has gone quiet",
      message: `The Cerbo GX last reported ${Math.round(ageMinutes)} minutes ago. Check its internet connection.`,
    });
  }
  res.json({ ok: true, stale: Boolean(lastError), lastError, ...latest, alerts });
});

// History for the chart
app.get("/api/history", async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  try {
    res.json({ ok: true, rows: await db.history(siteId, hours) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    vrm: lastError ? `error: ${lastError}` : latest ? "ok" : "waiting",
    lastReading: latest ? new Date(latest.timestamp * 1000).toISOString() : null,
    mysql: db.isActive() ? "connected" : "off",
  });
});

await db.init();
await poll();
setInterval(poll, pollSeconds * 1000);

app.listen(port, () => {
  console.log(`Solar dashboard running on http://localhost:${port}  (VRM poll every ${pollSeconds}s)`);
});
