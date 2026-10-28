-- =============================================================
-- Solar dashboard - MySQL schema
-- Run this on the DEV MySQL server first (MySQL Workbench or the
-- mysql command line over RDP). Later, run the same file on PROD.
-- =============================================================

CREATE DATABASE IF NOT EXISTS solar_dashboard
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE solar_dashboard;

-- One row per VRM reading (about one per minute)
CREATE TABLE IF NOT EXISTS readings (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id             INT UNSIGNED    NOT NULL,              -- VRM installation id (329491)
  recorded_at         DATETIME        NOT NULL,              -- UTC (add 2h for SAST)
  pv_w                DECIMAL(10,1)   NULL,                  -- total solar, watts
  pv_yield_today_kwh  DECIMAL(10,2)   NULL,
  battery_w           DECIMAL(10,1)   NULL,                  -- + charging / - discharging
  battery_soc         DECIMAL(5,1)    NULL,                  -- %
  battery_v           DECIMAL(6,2)    NULL,
  battery_a           DECIMAL(8,2)    NULL,
  grid_w              DECIMAL(10,1)   NULL,                  -- + importing / - exporting
  grid_l1_w           DECIMAL(10,1)   NULL,
  grid_l2_w           DECIMAL(10,1)   NULL,
  grid_l3_w           DECIMAL(10,1)   NULL,
  load_w              DECIMAL(10,1)   NULL,                  -- house / AC consumption
  load_l1_w           DECIMAL(10,1)   NULL,
  load_l2_w           DECIMAL(10,1)   NULL,
  load_l3_w           DECIMAL(10,1)   NULL,
  inverter_state      VARCHAR(50)     NULL,
  chargers_json       JSON            NULL,                  -- per-MPPT detail (278, 279)
  created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_site_time (site_id, recorded_at)
) ENGINE=InnoDB;

-- Handy view: daily summary in South African time
CREATE OR REPLACE VIEW daily_summary AS
SELECT
  site_id,
  DATE(recorded_at + INTERVAL 2 HOUR)          AS day_sast,
  MAX(pv_yield_today_kwh)                      AS pv_yield_kwh,
  ROUND(MAX(pv_w))                             AS peak_pv_w,
  ROUND(MAX(load_w))                           AS peak_load_w,
  MIN(battery_soc)                             AS min_soc,
  ROUND(SUM(GREATEST(grid_w, 0)) / 60 / 1000, 2) AS grid_import_kwh_est
FROM readings
GROUP BY site_id, day_sast;

-- -------------------------------------------------------------
-- App login (run once per server, as an admin user).
-- Replace the password. Replace '%' with your PC's IP address
-- if you want to lock it down, e.g. 'solar_app'@'172.31.176.%'
-- -------------------------------------------------------------
-- CREATE USER IF NOT EXISTS 'solar_app'@'%' IDENTIFIED BY 'ChangeThisPassword!';
-- GRANT SELECT, INSERT ON solar_dashboard.* TO 'solar_app'@'%';
-- FLUSH PRIVILEGES;
