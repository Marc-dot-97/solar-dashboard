// =============================================================================
// Solar dashboard — browser side
// Uses the PrimeBridge Motion Kit (window.Motion) for every animation:
//   show/hide = opacity (+ one-axis move) · state change = scale · sequences for order
// =============================================================================
// Settings come from data- attributes on <body> (set by the server in views/index.ejs)
const refreshSeconds = Number(document.body.dataset.refreshSeconds) || 15;
const historyEnabled = document.body.dataset.historyEnabled === "true";
const siteId = document.body.dataset.siteId;
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- formatting ----------
function watts(w) {
  if (w === null || w === undefined) return "–";
  const abs = Math.abs(w);
  return abs >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
const fixed = (v, dp, unit) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(dp)} ${unit}`);
const timeOf = (d) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
const IDLE = 20; // W – below this a flow counts as idle

// ---------- signal icons (same drawings as views/partials/icon.ejs) ----------
const SIGNAL = {
  ok: `<circle cx="12" cy="12" r="9" fill="#7ED957"/><path d="M8 12 L11 15 L16 9" fill="none" stroke="#2E3236" stroke-width="2" stroke-linecap="square"/>`,
  info: `<circle cx="12" cy="12" r="9" fill="#9BC53D"/><path d="M12 11 V17 M12 7 V8.5" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
  warning: `<path d="M12 2 L22 12 L12 22 L2 12 Z" fill="#F5C842"/><path d="M12 7 V13 M12 16 V17.5" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
  error: `<path d="M12 3 L22 20.5 H2 Z" fill="#FF6B5B"/><path d="M12 9 V14 M12 16.5 V18" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
};
const LEVEL_NAME = { ok: "OK", info: "Information", warning: "Warning", error: "Critical" };
const signalIcon = (level) =>
  `<svg class="icon" viewBox="0 0 24 24" role="img" aria-label="${LEVEL_NAME[level]}">${SIGNAL[level]}</svg>`;
const closeIcon = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"/></svg>`;
const RANK = { ok: 0, info: 1, warning: 2, error: 3 };

// =============================================================================
// Energy flow (SVG) — drawn and animated by public/flow.js (shared with /side-by-side)
// =============================================================================
const flow = EnergyFlow.create(document.querySelector(".flow-svg"));
const renderFlow = (d) => flow.render(d);
async function pulse(el) { return EnergyFlow.pulse(el); }

// =============================================================================
// Cards
// =============================================================================
function list(id, rows) {
  $(`${id}-list`).innerHTML = rows
    .filter(Boolean)
    .map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`)
    .join("");
}
function phases(arr, count) {
  return arr.slice(0, count || 3).map((w, i) => (w === null ? null : [`L${i + 1}`, watts(w)]));
}

function renderCards(d) {
  document.querySelectorAll(".card-value .skeleton").forEach((el) => el.classList.remove("skeleton"));
  // Solar
  $("solar-big").textContent = watts(d.solar.total);
  $("solar-text").innerHTML = `Today <b>${fixed(d.solar.yieldTodayKwh, 1, "kWh")}</b> · Yesterday <b>${fixed(d.solar.yieldYesterdayKwh, 1, "kWh")}</b>`;
  list("solar", d.solar.chargers.map((c) => [`${c.name} · ${c.state ?? "–"}`, `${watts(c.power)} · ${fixed(c.pvVoltage, 0, "V")}`]));

  // Battery
  const bp = d.battery.power;
  $("battery-big").textContent = d.battery.soc === null ? "–" : `${Math.round(d.battery.soc)}%`;
  $("battery-text").innerHTML =
    bp === null ? "–" : bp > IDLE ? `Charging <b>${watts(bp)}</b>` : bp < -IDLE ? `Discharging <b>${watts(-bp)}</b>` : "Idle";
  list("battery", [
    ["Voltage", fixed(d.battery.voltage, 2, "V")],
    ["Current", fixed(d.battery.current, 1, "A")],
    ["Health", fixed(d.battery.health, 0, "%")],
    ["Temperature", fixed(d.battery.temperature, 1, "°C")],
    d.battery.socLimit !== null && ["Reserve (ESS)", fixed(d.battery.socLimit, 0, "%")],
  ]);

  // Grid
  const g = d.grid.total;
  $("grid-big").textContent = watts(g === null ? null : Math.abs(g));
  $("grid-text").innerHTML = g === null ? "–" : g > IDLE ? "<b>Importing</b> from the grid" : g < -IDLE ? "<b>Exporting</b> to the grid" : "Balanced";
  list("grid", [...phases(d.grid.phases, d.phaseCount), ["Status", d.grid.alarm ?? "–"]]);

  // Consumption (VRM splits AC loads and essential loads)
  $("load-big").textContent = watts(d.load.total);
  $("load-text").innerHTML = `Inverter <b>${esc(d.inverter.state ?? "–")}</b> · ${esc(d.inverter.systemState ?? "")}`;
  list("load", [
    ["Essential loads", watts(d.load.essential)],
    ["AC loads", watts(d.load.acLoads)],
    ...(d.phaseCount > 1 ? phases(d.load.phases, d.phaseCount) : []),
  ]);
}

// =============================================================================
// Alerts: global (full width), container (in a card), badge, drawer, toasts
// =============================================================================
const dismissed = new Set();   // warnings/info you closed; errors can't be dismissed
let activeAlerts = [];
const events = [];             // today's events, newest first

function cardFor(scope) {
  return { solar: "solar", battery: "battery", grid: "grid", load: "load" }[scope] ?? null;
}

function renderAlerts(alerts) {
  const prevIds = new Set(activeAlerts.map((a) => a.id));
  activeAlerts = alerts;

  // --- Global alerts: added with a slide down, removed with a fade (only changes animate)
  const wrap = $("globalAlerts");
  const globals = alerts.filter((a) => a.scope === "global" && !dismissed.has(a.id));
  const wanted = new Set(globals.map((a) => a.id));
  [...wrap.children].forEach((el) => {
    if (!wanted.has(el.dataset.id)) Motion.hide(el, { axis: "y", distance: -8, remove: true });
  });
  globals.forEach((a) => {
    if (wrap.querySelector(`[data-id="${a.id}"]`)) return;
    const el = document.createElement("div");
    el.className = "global-alert";
    el.dataset.id = a.id;
    el.setAttribute("role", a.level === "error" ? "alert" : "status");
    el.innerHTML = `${signalIcon(a.level)}<p class="alert-text"><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span></p>` +
      (a.level === "error" ? "" : `<button class="icon-btn alert-close" type="button" aria-label="Dismiss">${closeIcon}</button>`);
    el.querySelector(".alert-close")?.addEventListener("click", () => {
      dismissed.add(a.id);
      Motion.hide(el, { axis: "y", distance: -8, remove: true });
    });
    el.hidden = true;
    wrap.append(el);
    Motion.show(el, { axis: "y", distance: -12 });
  });

  // --- Container alerts + card signal badges
  ["solar", "battery", "grid", "load"].forEach((card) => {
    const mine = alerts.filter((a) => cardFor(a.scope) === card || (a.scope === "global" && card === "grid" && /grid/.test(a.id)));
    const box = $(`${card}-alerts`);
    const key = mine.map((a) => a.id).join("|");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = mine
        .filter((a) => a.scope !== "global")
        .map((a) => `<div class="container-alert" data-motion="fade-down" data-motion-size="s">${signalIcon(a.level)}<p><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span></p></div>`)
        .join("");
      requestAnimationFrame(() => box.querySelectorAll("[data-motion]").forEach((el) => el.classList.add("is-in")));
    }
    const worst = mine.reduce((w, a) => (RANK[a.level] > RANK[w] ? a.level : w), "ok");
    const sig = $(`${card}-signal`);
    if (sig.dataset.level !== worst) {
      sig.dataset.level = worst;
      sig.innerHTML = signalIcon(worst);
      pulse(sig);
    }
  });

  // --- Generic badge on the bell: count of things that need attention
  const count = alerts.filter((a) => a.level === "warning" || a.level === "error").length;
  const badge = $("alertBadge");
  const before = Number(badge.textContent) || 0;
  badge.textContent = count;
  badge.hidden = count === 0;
  $("alertsBtn").setAttribute("aria-label", count ? `Alerts and events, ${count} need your attention` : "Alerts and events");
  if (count > before) pulse(badge); // highlight: draws the eye when something new arrives

  // --- New alerts after the first reading also arrive as a toast and an event
  if (hadData) {
    alerts.filter((a) => !prevIds.has(a.id)).forEach((a) => {
      toast(a.level, a.title, a.message);
      logEvent(a.level, a.title, a.message);
    });
  } else {
    alerts.forEach((a) => logEvent(a.level, a.title, a.message));
  }
  renderDrawer();
}

// Toasts: lower right, time-sensitive, close button, hide themselves after 7 s
function toast(level, title, message) {
  const host = $("toasts");
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.innerHTML = `${signalIcon(level)}<p class="alert-text"><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ""}</p>` +
    `<button class="icon-btn alert-close" type="button" aria-label="Dismiss">${closeIcon}</button>`;
  el.hidden = true;
  host.append(el);
  Motion.show(el, { axis: "y", distance: 24 });
  let timer = setTimeout(close, 7000);
  el.addEventListener("mouseenter", () => clearTimeout(timer));          // keep it while you read it
  el.addEventListener("mouseleave", () => (timer = setTimeout(close, 3000)));
  el.querySelector("button").addEventListener("click", close);
  function close() {
    clearTimeout(timer);
    if (el.isConnected) Motion.hide(el, { axis: "x", distance: 40, remove: true });
  }
}

function logEvent(level, title, message) {
  events.unshift({ level, title, message, at: new Date() });
  events.length = Math.min(events.length, 40);
}

// Live events worth knowing about, detected between two readings
let prev = null;
function detectEvents(d) {
  if (!prev) return;
  const dir = (w, band = 50) => (w > band ? 1 : w < -band ? -1 : 0);
  const say = (level, title, message) => { toast(level, title, message); logEvent(level, title, message); };

  const b0 = dir(prev.battery.power), b1 = dir(d.battery.power);
  if (b0 !== b1) {
    if (b1 === 1) say("info", "Your battery is charging", `${watts(d.battery.power)} flowing in at ${Math.round(d.battery.soc)}%.`);
    if (b1 === -1) say("info", "Your battery is powering the building", `${watts(-d.battery.power)} flowing out at ${Math.round(d.battery.soc)}%.`);
  }
  const g0 = dir(prev.grid.total), g1 = dir(d.grid.total);
  if (g0 !== g1 && g1 === -1) say("ok", "You're exporting to the grid", `${watts(-d.grid.total)} goes back to the grid.`);
  if (g0 === -1 && g1 === 1) say("info", "You're drawing from the grid again", `${watts(d.grid.total)} coming in.`);

  const s0 = (prev.solar.total ?? 0) > 50, s1 = (d.solar.total ?? 0) > 50;
  if (!s0 && s1) say("ok", "Your panels are producing", `${watts(d.solar.total)} from the sun.`);
  if (s0 && !s1) say("info", "Solar has stopped", "The panels have gone quiet.");
}

// =============================================================================
// Drawer (superimposed layer, slides in horizontally)
// =============================================================================
function renderDrawer() {
  const items = activeAlerts.length
    ? activeAlerts.map((a) => `<li>${signalIcon(a.level)}<p><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span></p></li>`).join("")
    : `<li class="empty">${signalIcon("ok")} Everything runs as it should.</li>`;
  $("drawerAlerts").innerHTML = items;
  $("drawerEvents").innerHTML = events.length
    ? events.map((e) => `<li>${signalIcon(e.level)}<p><strong>${esc(e.title)}</strong>${e.message ? `<span>${esc(e.message)}</span>` : ""}</p><time>${timeOf(e.at)}</time></li>`).join("")
    : `<li class="empty">No events yet today.</li>`;
}

let lastFocus = null;
function openDrawer() {
  lastFocus = document.activeElement;
  renderDrawer();
  Motion.show($("scrim"), { distance: 0 });
  Motion.show($("drawer"), { axis: "x", distance: 80 });
  $("drawerClose").focus();
}
function closeDrawer() {
  Motion.hide($("drawer"), { axis: "x", distance: 80 });
  Motion.hide($("scrim"), { distance: 0 });
  lastFocus?.focus();
}
$("alertsBtn").addEventListener("click", openDrawer);
$("drawerClose").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("drawer").hidden) closeDrawer();
});

// =============================================================================
// Header status, refresh feedback and clock
// =============================================================================
function setStatus(level, label, detail) {
  // the header and the full-screen bar show the same live status
  [["statusIcon", "statusText", "statusTime"], ["stageStatusIcon", "stageStatusText", "stageStatusTime"]].forEach(([i, t, d]) => {
    const icon = $(i);
    if (icon.dataset.level !== level) {
      icon.dataset.level = level;
      icon.innerHTML = signalIcon(level);
      if (icon.offsetParent) pulse(icon); // only animate what you can see
    }
    $(t).textContent = label;
    $(d).textContent = detail;
  });
}

function restartRefreshLine() {
  ["refreshLine", "stageRefreshLine"].forEach((id) => {
    const line = $(id);
    line.classList.remove("is-running");
    void line.getBoundingClientRect(); // restart the CSS animation
    line.style.animationDuration = `${refreshSeconds}s`;
    line.classList.add("is-running");
  });
}

function tickClock() {
  const t = timeOf(new Date());
  $("clock").textContent = t;
  $("stageClock").textContent = t;
}
tickClock();
setInterval(tickClock, 15000);

// =============================================================================
// Full screen: the energy flow as a wall display.
// The same live elements go full screen, so they keep updating on every refresh.
// =============================================================================
const stage = $("stage");
const fsBtn = $("fsBtn");
const canNativeFs = Boolean(document.fullscreenEnabled && stage.requestFullscreen);
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed or not supported: the display may dim, nothing else changes */ }
}

function setFullscreenState(on) {
  stage.classList.toggle("is-fullscreen", on);
  document.body.style.overflow = on ? "hidden" : "";
  fsBtn.setAttribute("aria-pressed", String(on));
  fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Show the energy flow full screen");
  $("fsLabel").textContent = on ? "EXIT" : "FULL SCREEN";
  // toasts follow the energy flow, so live events stay visible on the wall display
  (on ? stage : document.body).append($("toasts"));
  keepAwake(on);
  if (on) {
    Motion.show(stage.querySelector(".stage-bar"), { axis: "y", distance: -12 });
    Motion.show(stage.querySelector(".flow"), { axis: "y", distance: 16, delay: 70 });
  }
  pulse(fsBtn);
}

async function toggleFullscreen() {
  const on = !stage.classList.contains("is-fullscreen");
  if (canNativeFs) {
    try {
      if (on) await stage.requestFullscreen({ navigationUI: "hide" });
      else if (document.fullscreenElement) await document.exitFullscreen();
      return; // fullscreenchange does the rest
    } catch { /* fall back to the in-page version below */ }
  }
  setFullscreenState(on); // e.g. iPhone Safari: fills the window instead
}

fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => setFullscreenState(document.fullscreenElement === stage));
document.addEventListener("keydown", (e) => {
  // Esc already leaves native full screen; this covers the in-page fallback
  if (e.key === "Escape" && stage.classList.contains("is-fullscreen") && !document.fullscreenElement) setFullscreenState(false);
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !/input|textarea/i.test(e.target.tagName)) toggleFullscreen();
});
document.addEventListener("visibilitychange", () => {
  // the browser drops the wake lock when the tab is hidden; take it back
  if (document.visibilityState === "visible" && stage.classList.contains("is-fullscreen")) keepAwake(true);
});
// =============================================================================
// Device values (opens with a fade-down, closes with a fade)
// =============================================================================
let latest = null;
function renderDevices() {
  if (!latest || $("devices").hidden) return;
  $("devices").innerHTML = latest.devices
    .map((dev) => `
      <div class="device">
        <h3>${esc(dev.device)}${dev.instance !== "" ? ` <small>[${esc(dev.instance)}]</small>` : ""}</h3>
        <table>${dev.values.map((v) => `<tr><td>${esc(v.description)}</td><td class="code">${esc(v.code)}</td><td>${esc(v.text)}</td></tr>`).join("")}</table>
      </div>`)
    .join("");
}
$("devicesBtn").addEventListener("click", async () => {
  const box = $("devices");
  const opening = box.hidden;
  $("devicesBtn").setAttribute("aria-expanded", String(opening));
  $("devicesBtnText").textContent = opening ? "HIDE" : "SHOW";
  if (opening) {
    box.hidden = false;
    renderDevices();
    box.hidden = true;
    await Motion.show(box, { axis: "y", distance: -8 });
  } else {
    await Motion.hide(box, { axis: "y", distance: -8 });
  }
});

// =============================================================================
// Main refresh loop
// =============================================================================
let firstRender = true;
let hadData = false;
let wasOffline = false;

async function refresh() {
  restartRefreshLine();
  let data;
  try {
    const res = await fetch(`/api/live?site=${siteId}`, { cache: "no-store" });
    data = await res.json();
  } catch {
    setStatus("error", "Offline", "The dashboard server isn't answering");
    if (!wasOffline) toast("error", "We lost the dashboard server", "Check that npm run dev is still running.");
    wasOffline = true;
    return;
  }
  if (!data.ok) {
    setStatus("warning", "Waiting", data.error ?? "Waiting for the first reading");
    return;
  }
  if (wasOffline) toast("ok", "Back online", "Live data is flowing again.");
  wasOffline = false;

  latest = data;
  const when = new Date(data.timestamp * 1000);
  const ageMin = (Date.now() - when.getTime()) / 60000;
  if (data.stale) setStatus("warning", "Delayed", `Last reading ${timeOf(when)}`);
  else if (ageMin > 5) setStatus("warning", "Delayed", `Last reading ${timeOf(when)}`);
  else setStatus("ok", "Live", `Updated ${timeOf(when)}`);
  $("lastReading").textContent = when.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });

  renderFlow(data);
  renderCards(data);
  detectEvents(data);
  renderAlerts(data.alerts ?? []);
  renderDevices();
  prev = data;
  hadData = true;

  if (firstRender) {
    firstRender = false;
    introduce();
  }
}

// =============================================================================
// First appearance: bottom to top, one clear order, once only (Show and hide)
// =============================================================================
function introduce() {
  const items = [...document.querySelectorAll("[data-reveal]")];
  Motion.sequence(items.map((el) => () => Motion.show(el, { axis: "y", distance: 16 })), { overlap: 0.4 });
  Motion.revealOnScroll("[data-scroll-reveal]");
}
// If no data arrives quickly, show the layout anyway (with its placeholder blocks)
setTimeout(() => { if (firstRender) { firstRender = false; introduce(); } }, 2500);

// =============================================================================
// Sparklines + 24 h chart (history from MySQL)
// =============================================================================
function sparkline(svgId, values, { min, max } = {}) {
  const svg = $(svgId);
  const pts = values.filter((v) => v !== null);
  if (pts.length < 2) { svg.innerHTML = ""; return; }
  const lo = min ?? Math.min(0, ...pts);
  const hi = max ?? Math.max(...pts, lo + 1);
  const W = 300, H = 56, pad = 3;
  const x = (i) => (i / (values.length - 1)) * W;
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
  let d = "", started = false;
  values.forEach((v, i) => {
    if (v === null) { started = false; return; }
    d += `${started ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    started = true;
  });
  const zero = lo < 0 ? `<line class="zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>` : "";
  const area = `${d} L${W} ${y(Math.max(lo, 0))} L0 ${y(Math.max(lo, 0))} Z`;
  svg.innerHTML = `${zero}<path class="area" d="${area}"/><path class="line" d="${d}"/>`;
}

let chart;
async function loadHistory() {
  if (!historyEnabled) return;
  let rows;
  try {
    const res = await fetch(`/api/history?site=${siteId}&hours=24`, { cache: "no-store" });
    ({ rows } = await res.json());
  } catch { return; }
  if (!rows) return;
  const series = (key) => rows.map((r) => (r[key] === null ? null : Number(r[key])));

  sparkline("solar-spark", series("pv_w"));
  sparkline("battery-spark", series("battery_soc"), { min: 0, max: 100 });
  sparkline("grid-spark", series("grid_w"));
  sparkline("load-spark", series("load_w"));

  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const c = (name) => css.getPropertyValue(name).trim();
  const labels = rows.map((r) => timeOf(new Date(r.recorded_at)));
  const datasets = [
    { label: "Solar", data: series("pv_w"), borderColor: c("--lime-bright") },
    { label: "Battery", data: series("battery_w"), borderColor: c("--lime-dark") },
    { label: "Grid", data: series("grid_w"), borderColor: c("--stone"), borderDash: [6, 4] },
    { label: "Consumption", data: series("load_w"), borderColor: c("--text-label") },
  ].map((ds) => ({ ...ds, pointRadius: 0, borderWidth: 2, tension: 0.2, spanGaps: true }));

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets.forEach((ds, i) => (ds.data = datasets[i].data));
    chart.update("none");
    return;
  }
  Chart.defaults.font.family = c("--font");
  Chart.defaults.color = c("--text-muted");
  chart = new Chart($("historyChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 380, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 12 }, grid: { color: c("--line-soft") } },
        y: { ticks: { callback: (v) => watts(v) }, grid: { color: c("--line-soft") } },
      },
      plugins: {
        legend: { labels: { color: c("--text"), boxWidth: 14, boxHeight: 2 } },
        tooltip: {
          backgroundColor: c("--charcoal-deep"), borderColor: c("--line"), borderWidth: 1, cornerRadius: 0,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${watts(ctx.parsed.y)}` },
        },
      },
    },
  });
}

refresh();
loadHistory();
setInterval(refresh, refreshSeconds * 1000);
setInterval(loadHistory, 60 * 1000);
