// Talks to the Victron VRM API and turns the raw "diagnostics" list
// (one row per value, per device) into one tidy snapshot for the dashboard.

const BASE_URL = "https://vrmapi.victronenergy.com/v2";

export async function fetchSnapshot(siteId) {
  const token = process.env.VRM_TOKEN;
  if (!siteId || !token) {
    throw new Error("VRM_TOKEN and a site id (VRM_SITES or VRM_SITE_ID) must be set in your .env file");
  }

  const response = await fetch(`${BASE_URL}/installations/${siteId}/diagnostics?count=1000`, {
    headers: { "X-Authorization": `Token ${token}` }, // "Token", not "Bearer", single space
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VRM API returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const body = await response.json();
  if (!body.success) {
    throw new Error(`VRM API error: ${JSON.stringify(body).slice(0, 200)}`);
  }

  return buildSnapshot(body.records || [], Number(siteId));
}

// ---------- parsing helpers ----------

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function groupByDevice(records) {
  const map = new Map();
  for (const r of records) {
    const name = r.Device || r.device || "Unknown";
    const instance = r.instance ?? "";
    const key = `${name}|${instance}`;
    if (!map.has(key)) map.set(key, { device: name, instance, values: [] });
    map.get(key).values.push({
      code: r.code ?? "",
      description: r.description ?? "",
      value: toNumber(r.rawValue),
      text: r.formattedValue ?? (r.rawValue != null ? String(r.rawValue) : ""),
      timestamp: toNumber(r.timestamp),
    });
  }
  return [...map.values()].sort((a, b) =>
    a.device.localeCompare(b.device) || String(a.instance).localeCompare(String(b.instance))
  );
}

// Find a value on a device by VRM attribute code first, then by description text.
function findValue(device, { codes = [], desc } = {}) {
  if (!device) return null;
  for (const code of codes) {
    const hit = device.values.find((v) => v.code === code);
    if (hit) return hit;
  }
  if (desc) {
    const hit = device.values.find((v) => desc.test(v.description));
    if (hit) return hit;
  }
  return null;
}

const num = (device, opts) => findValue(device, opts)?.value ?? null;
const txt = (device, opts) => findValue(device, opts)?.text ?? null;

function sum(values) {
  const present = values.filter((v) => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

// ---------- snapshot ----------

// Hour of day in South Africa, used to decide whether "no solar" is worth a warning
function sastHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", hour: "numeric", hourCycle: "h23" }).format(date)
  );
}

const fmtKwh = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(1)} kWh`);

export function buildSnapshot(records, siteId) {
  const devices = groupByDevice(records);
  const find = (re) => devices.find((d) => re.test(d.device));
  const findAll = (re) => devices.filter((d) => re.test(d.device));
  // a value that may live on any instance of a device type (e.g. Grid alarm sits on System overview [276])
  const anyTxt = (re, opts) => findAll(re).map((d) => txt(d, opts)).find((v) => v !== null) ?? null;

  const system = find(/system overview/i);
  const gateway = find(/gateway/i);
  const batteryMonitor = find(/battery monitor/i);
  const veBus = find(/ve\.?bus/i);
  const gridMeter = find(/grid meter/i);
  const chargers = findAll(/solar charger/i);

  // Solar: one entry per MPPT (your 278 and 279). PVP = power from the panels.
  const solarChargers = chargers.map((c) => ({
    name: `MPPT ${c.instance}`,
    instance: c.instance,
    power: num(c, { codes: ["PVP"], desc: /^pv power/i }) ?? num(c, { codes: ["ScW"] }),
    pvVoltage: num(c, { codes: ["PVV"], desc: /^pv voltage/i }),
    yieldTodayKwh: num(c, { codes: ["YT"], desc: /yield today/i }),
    yieldYesterdayKwh: num(c, { codes: ["YY"], desc: /yield yesterday/i }),
    state: txt(c, { codes: ["ScS"], desc: /charge state|^state$/i }),
    offReason: txt(c, { codes: ["ScOR"], desc: /off reason/i }),
    error: txt(c, { codes: ["ScERR"], desc: /error code/i }),
  }));

  const pvFromSystem = num(system, { codes: ["Pdc"], desc: /pv.*dc.?coupled/i });
  const solarTotal = pvFromSystem ?? sum(solarChargers.map((c) => c.power));
  const yieldToday = sum(solarChargers.map((c) => c.yieldTodayKwh));
  const yieldYesterday = sum(solarChargers.map((c) => c.yieldYesterdayKwh));

  // Grid per phase: system overview (g1..g3), fall back to the grid meter
  const gridPhases = [1, 2, 3].map(
    (p) =>
      num(system, { codes: [`g${p}`], desc: new RegExp(`^grid l${p}$`, "i") }) ??
      num(gridMeter, { codes: [`g${p}p`], desc: new RegExp(`grid l${p} - power`, "i") })
  );

  // Loads, split the way VRM shows them:
  //   AC loads        = on the inverter's AC input side (i1..i3) – no backup
  //   Essential loads = on the inverter's AC output (o1..o3)     – backed up by the battery
  //   Total           = a1..a3
  const acLoadPhases = [1, 2, 3].map((p) => num(system, { codes: [`i${p}`], desc: new RegExp(`consumption on input l${p}`, "i") }));
  const essentialPhases = [1, 2, 3].map((p) => num(system, { codes: [`o${p}`], desc: new RegExp(`consumption on output l${p}`, "i") }));
  const loadPhases = [1, 2, 3].map(
    (p, i) =>
      num(system, { codes: [`a${p}`], desc: new RegExp(`^ac consumption l${p}`, "i") }) ??
      sum([acLoadPhases[i], essentialPhases[i]])
  );

  // Number of phases the inverter system is wired for (yours is 1)
  const phaseCount = num(veBus, { codes: ["PC"], desc: /phase count/i }) ?? 3;

  const battery = {
    soc:
      num(system, { codes: ["bs"], desc: /battery soc|state of charge/i }) ??
      num(batteryMonitor, { codes: ["SOC"], desc: /state of charge/i }),
    power:
      num(system, { codes: ["bp"], desc: /battery power/i }) ??
      num(batteryMonitor, { codes: ["P"], desc: /^power$|battery power/i }),
    voltage:
      num(system, { codes: ["bv"], desc: /battery voltage/i }) ??
      num(batteryMonitor, { codes: ["V"], desc: /^voltage$/i }),
    current:
      num(system, { codes: ["bc"], desc: /battery current/i }) ??
      num(batteryMonitor, { codes: ["I"], desc: /^current$/i }),
    state: txt(system, { codes: ["bst"], desc: /battery state/i }),
    health: num(batteryMonitor, { codes: ["SOH"], desc: /state of health/i }),
    temperature: num(batteryMonitor, { codes: ["BT"], desc: /battery temperature/i }),
    // ESS keeps the battery above this level so you have backup when the grid fails
    socLimit:
      num(gateway, { codes: ["ssl"], desc: /active soc limit/i }) ??
      num(gateway, { codes: ["H4ms"], desc: /minimum soc/i }),
    lowSocHold: txt(system, { codes: ["ssls"], desc: /low soc; discharge disabled/i }) === "On",
  };

  const inverter = {
    state: txt(veBus, { codes: ["S"], desc: /^state$|ve\.?bus state/i }),
    systemState: txt(system, { codes: ["ss"], desc: /system state/i }),
    error: txt(veBus, { codes: ["ERR"], desc: /ve\.?bus error/i }),
    acInput: txt(system, { codes: ["AIS"], desc: /^ac-input$/i }),
  };

  const gridAlarm = anyTxt(/system overview/i, { codes: ["Agl"], desc: /grid alarm/i });

  const timestamps = records.map((r) => toNumber(r.timestamp)).filter((t) => t !== null);
  const timestamp = timestamps.length ? Math.max(...timestamps) : Math.floor(Date.now() / 1000);

  const snapshot = {
    siteId,
    timestamp, // unix seconds of the newest value VRM has
    fetchedAt: new Date().toISOString(),
    phaseCount,
    solar: { total: solarTotal, yieldTodayKwh: yieldToday, yieldYesterdayKwh: yieldYesterday, chargers: solarChargers },
    battery,
    grid: { total: sum(gridPhases), phases: gridPhases, alarm: gridAlarm },
    load: {
      total: sum(loadPhases),
      phases: loadPhases,
      acLoads: sum(acLoadPhases),
      essential: sum(essentialPhases),
    },
    inverter,
    devices, // everything, so nothing is ever hidden
  };
  snapshot.alerts = buildAlerts(snapshot, batteryMonitor);
  return snapshot;
}

// ---------- alerts ----------
// level: "ok" | "info" | "warning" | "error"   scope: "global" | "solar" | "battery" | "grid" | "load"
// Copy follows the PrimeBridge voice: active, clear, addressed to "you", no exaggeration.
function buildAlerts(s, batteryMonitor) {
  const alerts = [];
  const add = (id, level, scope, title, message) => alerts.push({ id, level, scope, title, message });

  // Grid lost
  if (s.grid.alarm && !/ok/i.test(s.grid.alarm)) {
    add("grid-alarm", "error", "global", "Grid lost",
      "Your system is running on battery. Essential loads stay powered while the battery lasts.");
  }

  // Inverter / VE.Bus error
  if (s.inverter.error && !/no error/i.test(s.inverter.error)) {
    add("vebus-error", "error", "global", "Inverter reports an error",
      `VE.Bus says: ${s.inverter.error}. Check the inverter or call your installer.`);
  }

  // Battery alarms from the BMS (any "... alarm" value that isn't "No alarm")
  for (const v of batteryMonitor?.values ?? []) {
    if (/alarm|internal failure/i.test(v.description) && v.value && v.value !== 0 && !/no alarm|ok/i.test(v.text)) {
      add(`battery-${v.code}`, v.value >= 2 ? "error" : "warning", "battery", v.description, `Your battery reports: ${v.text}.`);
    }
  }

  // Solar charger errors
  for (const c of s.solar.chargers) {
    if (c.error && !/no error/i.test(c.error)) {
      add(`mppt-${c.instance}-error`, "warning", "solar", `${c.name} reports an error`, `${c.error}.`);
    }
  }

  // No solar during daylight
  const hour = sastHour();
  const allDark = s.solar.chargers.length > 0 && s.solar.chargers.every((c) => !c.power && !c.pvVoltage);
  if (hour >= 8 && hour < 16 && allDark) {
    add("no-solar", "warning", "solar", "Your panels aren't producing",
      `Both MPPTs report no input from the panels. Check the PV isolators and breakers. Yesterday they delivered ${fmtKwh(s.solar.yieldYesterdayKwh)}.`);
  }

  // ESS is holding the battery at its reserve
  if (s.battery.lowSocHold && s.battery.socLimit !== null) {
    add("soc-hold", "info", "battery", "Battery reserve protected",
      `ESS holds your battery at ${Math.round(s.battery.socLimit)}% so you have backup when the grid fails. The grid covers your loads for now.`);
  }

  return alerts;
}
