// MySQL history store. If the database can't be reached, the live
// dashboard keeps working - it just won't save history.
import mysql from "mysql2/promise";

let pool = null;
let active = false;

export const isActive = () => active;

export async function init() {
  if (process.env.DB_ENABLED !== "true") {
    console.log("MySQL: disabled (DB_ENABLED is not true) - running live-only");
    return;
  }
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || "solar_dashboard",
      waitForConnections: true,
      connectionLimit: 5,
      timezone: "Z", // store and read all times as UTC
    });
    await pool.query("SELECT 1");
    active = true;
    console.log(`MySQL: connected to ${process.env.DB_HOST}/${process.env.DB_NAME}`);
  } catch (err) {
    active = false;
    console.error(`MySQL: could not connect (${err.message}) - running live-only`);
  }
}

export async function saveReading(s) {
  if (!active) return;
  const r = (v, dp = 1) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));
  await pool.execute(
    `INSERT IGNORE INTO readings
      (site_id, recorded_at, pv_w, pv_yield_today_kwh, battery_w, battery_soc, battery_v, battery_a,
       grid_w, grid_l1_w, grid_l2_w, grid_l3_w, load_w, load_l1_w, load_l2_w, load_l3_w,
       inverter_state, chargers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.siteId,
      new Date(s.timestamp * 1000),
      r(s.solar.total),
      r(s.solar.yieldTodayKwh, 2),
      r(s.battery.power),
      r(s.battery.soc),
      r(s.battery.voltage, 2),
      r(s.battery.current, 2),
      r(s.grid.total),
      r(s.grid.phases[0]),
      r(s.grid.phases[1]),
      r(s.grid.phases[2]),
      r(s.load.total),
      r(s.load.phases[0]),
      r(s.load.phases[1]),
      r(s.load.phases[2]),
      s.inverter.state ? String(s.inverter.state).slice(0, 50) : null,
      JSON.stringify(s.solar.chargers),
    ]
  );
}

export async function history(siteId, hours) {
  if (!active) return [];
  const [rows] = await pool.execute(
    `SELECT recorded_at, pv_w, battery_w, battery_soc, grid_w, load_w
       FROM readings
      WHERE site_id = ? AND recorded_at >= UTC_TIMESTAMP() - INTERVAL ? HOUR
      ORDER BY recorded_at`,
    [siteId, String(hours)]
  );
  return rows;
}
