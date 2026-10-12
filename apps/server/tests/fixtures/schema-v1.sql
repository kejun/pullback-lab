-- Exact released schema from main 22f4fb5, before versioned migration support.

      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instruments(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bars(instrument_id TEXT NOT NULL, period TEXT NOT NULL, bar_id TEXT NOT NULL, time INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(instrument_id,period,bar_id));
      CREATE INDEX IF NOT EXISTS bars_timeline ON bars(instrument_id,period,time);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_versions(plan_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(plan_id,version));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_snapshots(generation INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(plan_id TEXT PRIMARY KEY, allocation_order INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_inputs(hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL, type TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL REFERENCES decision_inputs(hash), json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_technical_per_attempt ON decision_events(attempt_id) WHERE type='TECHNICAL_TRIGGERED';
      CREATE UNIQUE INDEX IF NOT EXISTS one_entry_per_attempt ON decision_events(attempt_id) WHERE type IN ('ENTRY_TRIGGERED','HISTORICAL_TRIGGERED');
      CREATE TABLE IF NOT EXISTS notifications(event_id TEXT PRIMARY KEY REFERENCES decision_events(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_ack(event_id TEXT PRIMARY KEY REFERENCES decision_events(id), read_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS record_revisions(id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES decision_events(id), created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feedback_order ON record_revisions(event_id,created_at);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS command_results(key TEXT PRIMARY KEY, route TEXT NOT NULL, input_hash TEXT NOT NULL, json TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(1, CAST(unixepoch('subsec') * 1000 AS INTEGER));
    
