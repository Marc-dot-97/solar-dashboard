// =============================================================================
// Side by side — every installation next to each other, plus combined totals.
// Diagrams come from public/flow.js; all motion uses the PrimeBridge Motion Kit.
// =============================================================================
const refreshSeconds = Number(document.body.dataset.refreshSeconds) || 15;
const $ = (id) => document.getElementById(id);
const { watts, fixed, pulse, IDLE } = EnergyFlow;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const timeOf = (d) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });

// ---------- signal icons (same drawings as views/partials/icon.ejs) ----------
const SIGNAL = {
  ok: `<circle cx="12" cy="12" r="9" fill="#7ED957"/><path d="M8 12 L11 15 L16 9" fill="none" stroke="#2E3236" stroke-width="2" stroke-linecap="square"/>`,
  info: `<circle cx="12" cy="12" r="9" fill="#9BC53D"/><path d="M12 11 V17 M12 7 V8.5" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
  warning: `<path d="M12 2 L22 12 L12 22 L2 12 Z" fill="#F5C842"/><path d="M12 7 V13 M12 16 V17.5" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
  error: `<path d="M12 3 L22 20.5 H2 Z" fill="#FF6B5B"/><path d="M12 9 V14 M12 16.5 V18" fill="none" stroke="#2E3236" stroke-width="2.2" stroke-linecap="square"/>`,
};
const LEVEL_NAME = { ok: "OK", info: "Information", warning: "Warning", error: "Critical" };
const RANK = { ok: 0, info: 1, warning: 2, error: 3 };
const signalIcon = (level) => `<svg class="icon" viewBox="0 0 24 24" role="img" aria-label="${LEVEL_NAME[level]}">${SIGNAL[level]}</svg>`;
const closeIcon = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"/></svg>`;

function setIcon(el, level) {
  if (el.dataset.level === level) return;
  el.dataset.level = level;
  el.innerHTML = signalIcon(level);
  if (el.offsetParent) pulse(el);
}

// =============================================================================
// Panels: one per installation
// =============================================================================
const panels = new Map(
  [...document.querySelectorAll(".site-panel")].map((el) => [
    Number(el.dataset.site),
    {
      el,
      k: (key) => el.querySelector(`[data-k="${key}"]`),
      flow: EnergyFlow.create(el.querySelector(".flow-svg")),
      prev: null,
      alertKey: null,
      alertIds: new Set(),
    },
  ])
);

function renderPanel(p, d) {
  const when = new Date(d.timestamp * 1000);
  const ageMin = (Date.now() - when.getTime()) / 60000;
  const level = d.stale || ageMin > 5 ? "warning" : "ok";
  setIcon(p.k("status-icon"), level);
  p.k("status-text").textContent = level === "ok" ? "Live" : "Delayed";
  p.k("status-time").textContent = `${level === "ok" ? "Updated" : "Last reading"} ${timeOf(when)}`;

  p.flow.render(d);

  const facts = [
    ["Solar today", fixed(d.solar.yieldTodayKwh, 1, "kWh")],
    ["Solar yesterday", fixed(d.solar.yieldYesterdayKwh, 1, "kWh")],
    ["Essential loads", watts(d.load.essential)],
    ["AC loads", watts(d.load.acLoads)],
    ["Battery", `${fixed(d.battery.voltage, 1, "V")} · ${fixed(d.battery.current, 1, "A")}`],
    ["Reserve (ESS)", fixed(d.battery.socLimit, 0, "%")],
  ];
  p.k("facts").innerHTML = facts.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");

  // Container alerts (everything for this site, connection problems included)
  const key = d.alerts.map((a) => a.id).join("|");
  if (key !== p.alertKey) {
    p.alertKey = key;
    const box = p.k("alerts");
    box.innerHTML = d.alerts
      .map((a) => `<div class="container-alert" data-motion="fade-down" data-motion-size="s">${signalIcon(a.level)}<p><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span></p></div>`)
      .join("");
    requestAnimationFrame(() => box.querySelectorAll("[data-motion]").forEach((el) => el.classList.add("is-in")));
  }
}

function renderWaiting(p, d) {
  setIcon(p.k("status-icon"), "warning");
  p.k("status-text").textContent = "Waiting";
  p.k("status-time").textContent = d.error ?? "";
}

// =============================================================================
// Combined totals
// =============================================================================
function sumOf(list, pick) {
  const vals = list.map(pick).filter((v) => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}
function setTotal(key, value, sub) {
  const el = $(`total-${key}`);
  const changed = el.textContent !== value;
  el.textContent = value;
  $(`total-${key}-sub`).innerHTML = sub;
  if (changed && hadData) pulse(el.closest(".total"));
}
function renderTotals(list) {
  const solar = sumOf(list, (d) => d.solar.total);
  const today = sumOf(list, (d) => d.solar.yieldTodayKwh);
  const grid = sumOf(list, (d) => d.grid.total);
  const load = sumOf(list, (d) => d.load.total);
  const bp = sumOf(list, (d) => d.battery.power);
  const socs = list.map((d) => d.battery.soc).filter((v) => v !== null);
  const soc = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;

  setTotal("solar", watts(solar), `Today <b>${fixed(today, 1, "kWh")}</b>`);
  setTotal("battery", soc === null ? "–" : `${Math.round(soc)}%`,
    bp === null ? "–" : bp > IDLE ? `Charging <b>${watts(bp)}</b>` : bp < -IDLE ? `Discharging <b>${watts(-bp)}</b>` : "Idle");
  setTotal("grid", watts(grid === null ? null : Math.abs(grid)),
    grid === null ? "–" : grid > IDLE ? "<b>Importing</b>" : grid < -IDLE ? "<b>Exporting</b>" : "Balanced");
  setTotal("load", watts(load), list.map((d) => `${esc(d.label)} <b>${watts(d.load.total)}</b>`).join(" · "));
  document.querySelectorAll(".total-value .skeleton").forEach((el) => el.classList.remove("skeleton"));
}

// =============================================================================
// Notifications: global alerts (critical ones), toasts for live events
// =============================================================================
function renderGlobal(list) {
  const wrap = $("globalAlerts");
  const globals = list.flatMap((d) => d.alerts.filter((a) => a.level === "error").map((a) => ({ ...a, id: `${d.siteId}-${a.id}`, title: `${d.label}: ${a.title}` })));
  const wanted = new Set(globals.map((a) => a.id));
  [...wrap.children].forEach((el) => { if (!wanted.has(el.dataset.id)) Motion.hide(el, { axis: "y", distance: -8, remove: true }); });
  globals.forEach((a) => {
    if (wrap.querySelector(`[data-id="${a.id}"]`)) return;
    const el = document.createElement("div");
    el.className = "global-alert";
    el.dataset.id = a.id;
    el.setAttribute("role", "alert");
    el.innerHTML = `${signalIcon(a.level)}<p class="alert-text"><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span></p>`;
    el.hidden = true;
    wrap.append(el);
    Motion.show(el, { axis: "y", distance: -12 });
  });
}

function toast(level, title, message) {
  const host = $("toasts");
  // a wall display keeps the diagrams clear: fewer, shorter pop-ups in full screen
  const wall = stage.classList.contains("is-fullscreen");
  while (host.children.length >= (wall ? 2 : 4)) host.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.innerHTML = `${signalIcon(level)}<p class="alert-text"><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ""}</p>` +
    `<button class="icon-btn alert-close" type="button" aria-label="Dismiss">${closeIcon}</button>`;
  el.hidden = true;
  host.append(el);
  Motion.show(el, { axis: "y", distance: 24 });
  let timer = setTimeout(close, wall ? 5000 : 7000);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => (timer = setTimeout(close, 3000)));
  el.querySelector("button").addEventListener("click", close);
  function close() {
    clearTimeout(timer);
    if (el.isConnected) Motion.hide(el, { axis: "x", distance: 40, remove: true });
  }
}

// Events per site between two readings, named after the site
function detectEvents(p, d) {
  const prev = p.prev;
  // new alerts for this site
  const ids = new Set(d.alerts.map((a) => a.id));
  if (prev) d.alerts.filter((a) => !p.alertIds.has(a.id)).forEach((a) => toast(a.level, `${d.label}: ${a.title}`, a.message));
  p.alertIds = ids;
  if (!prev) return;

  const dir = (w, band = 50) => (w > band ? 1 : w < -band ? -1 : 0);
  const b0 = dir(prev.battery.power), b1 = dir(d.battery.power);
  if (b0 !== b1 && b1 === 1) toast("info", `${d.label}: battery charging`, `${watts(d.battery.power)} flowing in at ${Math.round(d.battery.soc)}%.`);
  if (b0 !== b1 && b1 === -1) toast("info", `${d.label}: battery powering the building`, `${watts(-d.battery.power)} flowing out at ${Math.round(d.battery.soc)}%.`);
  const g0 = dir(prev.grid.total), g1 = dir(d.grid.total);
  if (g0 !== g1 && g1 === -1) toast("ok", `${d.label}: exporting to the grid`, `${watts(-d.grid.total)} goes back to the grid.`);
  const s0 = (prev.solar.total ?? 0) > 50, s1 = (d.solar.total ?? 0) > 50;
  if (!s0 && s1) toast("ok", `${d.label}: panels producing`, `${watts(d.solar.total)} from the sun.`);
  if (s0 && !s1) toast("info", `${d.label}: solar has stopped`, "The panels have gone quiet.");
}

// =============================================================================
// Header status, refresh feedback, clock
// =============================================================================
function setStatus(level, label, detail) {
  [["statusIcon", "statusText", "statusTime"], ["stageStatusIcon", "stageStatusText", "stageStatusTime"]].forEach(([i, t, d]) => {
    setIcon($(i), level);
    $(t).textContent = label;
    $(d).textContent = detail;
  });
}
function restartRefreshLine() {
  ["refreshLine", "stageRefreshLine"].forEach((id) => {
    const line = $(id);
    line.classList.remove("is-running");
    void line.getBoundingClientRect();
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
// Full screen: both systems as a wall display (keeps updating, keeps the screen awake)
// =============================================================================
const stage = $("stage");
const fsBtn = $("fsBtn");
const canNativeFs = Boolean(document.fullscreenEnabled && stage.requestFullscreen);
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or not allowed */ }
}
function setFullscreenState(on) {
  stage.classList.toggle("is-fullscreen", on);
  document.body.style.overflow = on ? "hidden" : "";
  fsBtn.setAttribute("aria-pressed", String(on));
  fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Show both systems full screen");
  $("fsLabel").textContent = on ? "EXIT" : "FULL SCREEN";
  (on ? stage : document.body).append($("toasts"));
  keepAwake(on);
  if (on) {
    Motion.show(stage.querySelector(".stage-bar"), { axis: "y", distance: -12 });
    Motion.sequence([...stage.querySelectorAll(".totals, .site-panel")].map((el) => () => Motion.show(el, { axis: "y", distance: 16 })), { overlap: 0.4 });
  }
  pulse(fsBtn);
}
async function toggleFullscreen() {
  const on = !stage.classList.contains("is-fullscreen");
  if (canNativeFs) {
    try {
      if (on) await stage.requestFullscreen({ navigationUI: "hide" });
      else if (document.fullscreenElement) await document.exitFullscreen();
      return;
    } catch { /* fall back below */ }
  }
  setFullscreenState(on);
}
fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => setFullscreenState(document.fullscreenElement === stage));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && stage.classList.contains("is-fullscreen") && !document.fullscreenElement) setFullscreenState(false);
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !/input|textarea/i.test(e.target.tagName)) toggleFullscreen();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stage.classList.contains("is-fullscreen")) keepAwake(true);
});

// =============================================================================
// Refresh loop
// =============================================================================
let hadData = false;
let introduced = false;
let wasOffline = false;

async function refresh() {
  restartRefreshLine();
  let data;
  try {
    const res = await fetch("/api/live/all", { cache: "no-store" });
    data = await res.json();
  } catch {
    setStatus("error", "Offline", "The dashboard server isn't answering");
    if (!wasOffline) toast("error", "We lost the dashboard server", "Check that npm run dev is still running.");
    wasOffline = true;
    return;
  }
  if (wasOffline) toast("ok", "Back online", "Live data is flowing again.");
  wasOffline = false;

  const ready = data.sites.filter((d) => d.ok);
  data.sites.forEach((d) => {
    const p = panels.get(d.siteId);
    if (!p) return;
    if (!d.ok) return renderWaiting(p, d);
    renderPanel(p, d);
    detectEvents(p, d);
    p.prev = d;
  });

  if (ready.length) {
    renderTotals(ready);
    renderGlobal(ready);
    const newest = new Date(Math.max(...ready.map((d) => d.timestamp)) * 1000);
    const anyLate = ready.length < data.sites.length || ready.some((d) => d.stale || Date.now() / 1000 - d.timestamp > 300);
    setStatus(anyLate ? "warning" : "ok", anyLate ? "Delayed" : "Live", `${ready.length} of ${data.sites.length} systems · ${timeOf(newest)}`);
    $("lastReading").textContent = newest.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
    hadData = true;
  } else {
    setStatus("warning", "Waiting", "Waiting for the first reading");
  }
  if (!introduced) introduce();
}

// First appearance: bottom to top, one clear order, once only
function introduce() {
  introduced = true;
  Motion.sequence([...document.querySelectorAll("[data-reveal]")].map((el) => () => Motion.show(el, { axis: "y", distance: 16 })), { overlap: 0.4 });
}
setTimeout(() => { if (!introduced) introduce(); }, 2500);

refresh();
setInterval(refresh, refreshSeconds * 1000);
