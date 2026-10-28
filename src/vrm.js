// Talks to the Victron VRM API and turns the raw "diagnostics" list
// (one row per value, per device) into one tidy snapshot for the dashboard.

const BASE_URL = "https://vrmapi.victronenergy.com/v2";

export async function fetchSnapshot() {
  const siteId = process.env.VRM_SITE_ID;
  const token = process.env.VRM_TOKEN;
  if (!siteId || !token) {
    throw new Error("VRM_SITE_ID and VRM_TOKEN must be set in your .env file");
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

export function buildSnapshot(records, siteId) {
  const devices = groupByDevice(records);
  const find = (re) => devices.find((d) => re.test(d.device));
  const findAll = (re) => devices.filter((d) => re.test(d.device));

  const system = find(/system overview/i);
  const batteryMonitor = find(/battery monitor/i);
  const veBus = find(/ve\.?bus/i);
  const gridMeter = find(/grid meter/i);
  const chargers = findAll(/solar charger/i);

  // Solar: one entry per MPPT (your 278 and 279)
  const solarChargers = chargers.map((c) => ({
    name: `MPPT ${c.instance}`,
    instance: c.instance,
    power: num(c, { codes: ["PVP"], desc: /^pv power/i }) ?? num(c, { codes: ["ScW"] }),
    pvVoltage: num(c, { codes: ["PVV"], desc: /^pv voltage/i }),
    yieldTodayKwh: num(c, { codes: ["YT"], desc: /yield today/i }),
    yieldYesterdayKwh: num(c, { codes: ["YY"], desc: /yield yesterday/i }),
    state: txt(c, { codes: ["ScS"], desc: /charge state|^state$/i }),
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

  // House load per phase: a1..a3 = total AC consumption (input + output loads)
  const loadPhases = [1, 2, 3].map(
    (p) =>
      num(system, { codes: [`a${p}`], desc: new RegExp(`^ac consumption l${p}`, "i") }) ??
      sum([num(system, { codes: [`i${p}`] }), num(system, { codes: [`o${p}`] })])
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
  };

  const timestamps = records.map((r) => toNumber(r.timestamp)).filter((t) => t !== null);
  const timestamp = timestamps.length ? Math.max(...timestamps) : Math.floor(Date.now() / 1000);

  return {
    siteId,
    timestamp, // unix seconds of the newest value VRM has
    fetchedAt: new Date().toISOString(),
    phaseCount,
    solar: { total: solarTotal, yieldTodayKwh: yieldToday, yieldYesterdayKwh: yieldYesterday, chargers: solarChargers },
    battery,
    grid: { total: sum(gridPhases), phases: gridPhases },
    load: { total: sum(loadPhases), phases: loadPhases },
    inverter: {
      state: txt(veBus, { codes: ["S"], desc: /^state$|ve\.?bus state/i }),
      systemState: txt(system, { codes: ["ss"], desc: /system state/i }),
    },
    devices, // everything, so nothing is ever hidden
  };
}
