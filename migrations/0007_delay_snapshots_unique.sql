-- delay_snapshots previously lacked a natural unique key, so every poll cycle
-- inserted duplicate rows instead of replacing them. By 2026-04-11 the table
-- had grown to 43M+ rows and filled the 10GB D1 ceiling. This index makes
-- `INSERT OR REPLACE` actually replace on the natural key.
--
-- Applied after truncating the table (43M rows of duplicates existed).

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique
  ON delay_snapshots(schedule_id, order_id, operating_date, station_id, sequence_num);
