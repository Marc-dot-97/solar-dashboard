// Quick connection test:  npm run check-db
// Used by deploy/install.ps1 before the Windows service is created.
import "dotenv/config";
import mysql from "mysql2/promise";

try {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "solar_dashboard",
    timezone: "Z",
  });
  const [rows] = await pool.query(`
    SELECT @@hostname AS ServerName, VERSION() AS MySqlVersion, DATABASE() AS DatabaseName,
      (SELECT COUNT(*) FROM readings) AS Readings,
      (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_summary') AS DailySummaryView`);
  console.log("✔ Connected:", rows[0]);
  if (!Number(rows[0].DailySummaryView)) console.log("⚠ View daily_summary is missing - run db/schema.sql again (it is safe to re-run).");
  // The app only needs to read and add rows. Make sure it can do exactly that.
  const [grants] = await pool.query("SHOW GRANTS FOR CURRENT_USER()");
  console.log("  Grants:", grants.map((g) => Object.values(g)[0].replace(/IDENTIFIED BY.*/i, "")).join(" | "));
  await pool.end();
} catch (err) {
  console.error("✖ Could not connect:", err.code || "", err.message);
  if (err.code === "ER_BAD_DB_ERROR") console.error("  The database doesn't exist yet - run db/schema.sql.");
  else if (err.code === "ER_NO_SUCH_TABLE") console.error("  The table or view isn't there - run db/schema.sql.");
  else console.error("  Check DB_HOST / DB_PORT / DB_USER / DB_PASSWORD in .env.");
  process.exitCode = 1;
}
