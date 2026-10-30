-- =====================================================================
-- Solar View - PROD app login
-- WHERE:  MySQL Workbench connected to 10.10.1.2, port 3306, as root.
-- ORDER:  run db/schema.sql FIRST (it creates the database, table and view), then this file.
-- BEFORE: replace  <<CHOOSE_A_STRONG_PASSWORD>>  (keep the quotes). Use letters, digits, - and _ only.
--         Put the same password in C:\Apps\solar-dashboard\.env as DB_PASSWORD.
--         Do NOT save the real password into this file or commit it to Git.
-- =====================================================================
CREATE USER IF NOT EXISTS 'solar_app'@'%' IDENTIFIED BY '<<CHOOSE_A_STRONG_PASSWORD>>';
-- The app only adds readings and reads history.
GRANT SELECT, INSERT ON solar_dashboard.* TO 'solar_app'@'%';
