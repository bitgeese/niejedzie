-- niejedzie.pl D1 Schema
-- Train delay tracking for Polish railways

-- Train metadata (cached from /schedules endpoint)
CREATE TABLE IF NOT EXISTS trains (
  schedule_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  train_number TEXT NOT NULL,
  carrier TEXT,
  category TEXT,
  route_start TEXT,
  route_end TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (schedule_id, order_id)
);

-- Station lookup (from /dictionaries/stations)
CREATE TABLE IF NOT EXISTS stations (
  station_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT
);

-- Per-station delay data (append-only, core table)
CREATE TABLE IF NOT EXISTS delay_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  operating_date TEXT NOT NULL,
  station_id INTEGER NOT NULL,
  station_name TEXT,
  sequence_num INTEGER,
  planned_arrival TEXT,
  planned_departure TEXT,
  actual_arrival TEXT,
  actual_departure TEXT,
  arrival_delay INTEGER,
  departure_delay INTEGER,
  is_confirmed INTEGER DEFAULT 1,
  is_cancelled INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON delay_snapshots(operating_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_train ON delay_snapshots(schedule_id, order_id, operating_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_station ON delay_snapshots(station_id, operating_date);

-- Daily aggregate stats (computed by nightly cron)
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  total_trains INTEGER,
  on_time_count INTEGER,
  punctuality_pct REAL,
  avg_delay REAL,
  cancelled_count INTEGER,
  delay_0_5 INTEGER,
  delay_6_15 INTEGER,
  delay_16_30 INTEGER,
  delay_31_60 INTEGER,
  delay_60_plus INTEGER
);

-- City daily stats
CREATE TABLE IF NOT EXISTS city_daily (
  city TEXT NOT NULL,
  date TEXT NOT NULL,
  train_count INTEGER,
  avg_delay REAL,
  punctuality_pct REAL,
  PRIMARY KEY (city, date)
);

-- Disruptions (active + historical)
CREATE TABLE IF NOT EXISTS disruptions (
  disruption_id INTEGER PRIMARY KEY,
  type_code TEXT,
  start_station TEXT,
  end_station TEXT,
  message TEXT,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1
);

-- Monitoring sessions (przesiadki paid feature)
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id TEXT PRIMARY KEY,
  push_subscription TEXT NOT NULL,
  train_a_schedule_id INTEGER NOT NULL,
  train_a_order_id INTEGER NOT NULL,
  transfer_station_id INTEGER NOT NULL,
  train_b_schedule_id INTEGER NOT NULL,
  train_b_order_id INTEGER NOT NULL,
  operating_date TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  last_checked TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_monitoring_active ON monitoring_sessions(status, operating_date);
