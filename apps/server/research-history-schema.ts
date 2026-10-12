export const RESEARCH_HISTORY_SCHEMA_SQL = `
CREATE TABLE research_history(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  recorded_at INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  request_token TEXT NOT NULL UNIQUE,
  request_epoch TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX research_history_instrument ON research_history(instrument_id,sequence DESC);
CREATE TRIGGER research_history_no_update BEFORE UPDATE ON research_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_HISTORY'); END;
CREATE TRIGGER research_history_no_delete BEFORE DELETE ON research_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_HISTORY'); END;
CREATE TRIGGER research_history_no_replace BEFORE INSERT ON research_history
WHEN EXISTS(SELECT 1 FROM research_history WHERE sequence=NEW.sequence OR id=NEW.id OR request_token=NEW.request_token)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_HISTORY'); END;
`;
