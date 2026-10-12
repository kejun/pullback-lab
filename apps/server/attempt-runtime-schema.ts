/** Kept dependency-free so database initialization never imports the runtime/Store cycle. */
export const ATTEMPT_RUNTIME_SCHEMA_SQL = `
CREATE TABLE runtime_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  plan_version INTEGER NOT NULL,
  owner_epoch TEXT NOT NULL,
  phase TEXT NOT NULL,
  step INTEGER NOT NULL,
  simulation_time INTEGER NOT NULL,
  deadline_watermark INTEGER,
  config_json TEXT NOT NULL,
  fixture_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  emitted_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE runtime_inputs (
  attempt_id TEXT NOT NULL REFERENCES runtime_attempts(attempt_id),
  ingest_seq INTEGER NOT NULL,
  input_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  emitted_json TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,ingest_seq),
  UNIQUE(attempt_id,input_id)
);
CREATE TRIGGER runtime_inputs_immutable_update BEFORE UPDATE ON runtime_inputs
BEGIN SELECT RAISE(ABORT, 'runtime_inputs is append-only'); END;
CREATE TRIGGER runtime_inputs_immutable_delete BEFORE DELETE ON runtime_inputs
BEGIN SELECT RAISE(ABORT, 'runtime_inputs is append-only'); END;
CREATE TRIGGER runtime_inputs_immutable_replace BEFORE INSERT ON runtime_inputs
WHEN EXISTS(SELECT 1 FROM runtime_inputs WHERE attempt_id=NEW.attempt_id AND (ingest_seq=NEW.ingest_seq OR input_id=NEW.input_id))
BEGIN SELECT RAISE(ABORT, 'runtime_inputs is append-only'); END;
CREATE TRIGGER runtime_attempts_frozen BEFORE UPDATE ON runtime_attempts
WHEN OLD.attempt_id<>NEW.attempt_id OR OLD.plan_id<>NEW.plan_id OR OLD.plan_version<>NEW.plan_version
  OR OLD.config_json<>NEW.config_json OR OLD.fixture_json<>NEW.fixture_json OR OLD.source_json<>NEW.source_json OR OLD.created_at<>NEW.created_at
BEGIN SELECT RAISE(ABORT, 'runtime configuration is frozen'); END;
CREATE TRIGGER runtime_attempts_immutable_delete BEFORE DELETE ON runtime_attempts
BEGIN SELECT RAISE(ABORT, 'runtime configuration is frozen'); END;
CREATE TRIGGER runtime_attempts_immutable_replace BEFORE INSERT ON runtime_attempts
WHEN EXISTS(SELECT 1 FROM runtime_attempts WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'runtime configuration is frozen'); END;
`;
