// Browser side: fetch /api/live on a timer and paint the tiles.
const { refreshSeconds, historyEnabled } = window.DASHBOARD;
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function watts(w) {
  if (w === null || w === undefined) return "–";
  const abs = Math.abs(w);
  return abs >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
const fixed = (v, dp, unit) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(dp)} ${unit}`);

// Only show the phases the system actually has (yours is single-phase)
function phaseList(el, phases, phaseCount, extra = "") {
  const rows = phases
    .slice(0, phaseCount || 3)
    .map((w, i) => (w === null ? "" : `<li><span>L${i + 1}</span><b>${watts(w)}</b></li>`))
    .join("");
  el.innerHTML = rows + extra;
}

function render(d) {
  // Solar
  $("solarTotal").textContent = watts(d.solar.total);
  $("solarYield").textContent = fixed(d.solar.yieldTodayKwh, 1, "kWh");
  $("solarSplit").innerHTML =
    d.solar.chargers
      .map((c) => `<li><span>${esc(c.name)}${c.state ? ` · ${esc(c.state)}` : ""}</span><b>${watts(c.power)}</b></li>`)
      .join("") + `<li><span>Yesterday</span><b>${fixed(d.solar.yieldYesterdayKwh, 1, "kWh")}</b></li>`;

  // Battery (+ charging, - discharging)
  const soc = d.battery.soc;
  $("batterySoc").textContent = soc === null ? "–" : `${Math.round(soc)}%`;
  $("socFill").style.width = `${Math.max(0, Math.min(100, soc ?? 0))}%`;
  $("socFill").className = soc !== null && soc < 30 ? "low" : "";
  const bp = d.battery.power;
  $("batteryFlow").textContent =
    bp === null ? "–" : bp > 20 ? `Charging ${watts(bp)}` : bp < -20 ? `Discharging ${watts(-bp)}` : "Idle";
  $("batteryV").textContent = fixed(d.battery.voltage, 2, "V");
  $("batteryA").textContent = fixed(d.battery.current, 1, "A");
  $("batteryState").textContent = d.battery.state ?? "–";
  $("batteryHealth").textContent = fixed(d.battery.health, 0, "%");
  $("batteryTemp").textContent = fixed(d.battery.temperature, 1, "°C");

  // Grid (+ import, - export)
  const g = d.grid.total;
  $("gridTotal").textContent = watts(g === null ? null : Math.abs(g));
  $("gridFlow").textContent = g === null ? "–" : g > 20 ? "Importing" : g < -20 ? "Exporting" : "Balanced";
  phaseList($("gridSplit"), d.grid.phases, d.phaseCount);

  // Consumption
  $("loadTotal").textContent = watts(d.load.total);
  $("inverterState").textContent = d.inverter.state ?? "–";
  phaseList(
    $("loadSplit"),
    d.load.phases,
    d.phaseCount,
    `<li><span>System</span><b>${esc(d.inverter.systemState ?? "–")}</b></li>`
  );

  // Raw device table
  $("devices").innerHTML = d.devices
    .map(
      (dev) => `
      <div class="device">
        <h3>${esc(dev.device)}${dev.instance !== "" ? ` <small>[${esc(dev.instance)}]</small>` : ""}</h3>
        <table>${dev.values
          .map((v) => `<tr><td>${esc(v.description)}</td><td class="code">${esc(v.code)}</td><td>${esc(v.text)}</td></tr>`)
          .join("")}</table>
      </div>`
    )
    .join("");

  const when = new Date(d.timestamp * 1000);
  $("lastReading").textContent = when.toLocaleString("en-ZA");
  const ageMin = (Date.now() - when.getTime()) / 60000;
  setStatus(d.stale || ageMin > 5 ? "warn" : "ok", d.stale ? "VRM error – showing last data" : `Live · ${when.toLocaleTimeString("en-ZA")}`);
  showBanner(d.stale ? d.lastError : null);
}

function setStatus(kind, text) {
  $("status").className = `status ${kind}`;
  $("statusText").textContent = text;
}
function showBanner(msg) {
  $("banner").textContent = msg || "";
  $("banner").classList.toggle("hidden", !msg);
}

async function refresh() {
  try {
    const res = await fetch("/api/live");
    const data = await res.json();
    if (!data.ok) {
      setStatus("warn", "Waiting for data");
      showBanner(data.error);
      return;
    }
    render(data);
  } catch {
    setStatus("error", "Server not reachable");
  }
}

// ---- history chart ----
let chart;
async function loadHistory() {
  if (!historyEnabled || !window.Chart) return;
  const res = await fetch("/api/history?hours=24");
  const { ok, rows } = await res.json();
  if (!ok) return;
  const labels = rows.map((r) =>
    new Date(r.recorded_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
  );
  const series = (key) => rows.map((r) => (r[key] === null ? null : Number(r[key])));
  const datasets = [
    { label: "Solar", data: series("pv_w"), borderColor: "#f5b301" },
    { label: "Consumption", data: series("load_w"), borderColor: "#4aa3ff" },
    { label: "Grid", data: series("grid_w"), borderColor: "#c8c8c8" },
    { label: "Battery", data: series("battery_w"), borderColor: "#3ecf8e" },
  ].map((ds) => ({ ...ds, pointRadius: 0, borderWidth: 2, tension: 0.25 }));

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets.forEach((ds, i) => (ds.data = datasets[i].data));
    chart.update("none");
    return;
  }
  chart = new Chart($("historyChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#9aa4b2", maxTicksLimit: 12 }, grid: { color: "#2a2f37" } },
        y: { ticks: { color: "#9aa4b2", callback: (v) => watts(v) }, grid: { color: "#2a2f37" } },
      },
      plugins: {
        legend: { labels: { color: "#e6e9ee" } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${watts(c.parsed.y)}` } },
      },
    },
  });
}

refresh();
loadHistory();
setInterval(refresh, refreshSeconds * 1000);
setInterval(loadHistory, 60 * 1000);
