const keys: Record<string, string> = {
  closed_contexts: "id=NEW.id",
  closed_receipts: "seq=NEW.seq",
  closed_receipt_results: "seq=NEW.seq",
  closed_minutes:
    "connection_epoch=NEW.connection_epoch AND instrument_id=NEW.instrument_id AND start=NEW.start",
  closed_inputs: "attempt_id=NEW.attempt_id AND ingest_seq=NEW.ingest_seq",
  closed_attempts: "attempt_id=NEW.attempt_id",
};
/** Separate from historical sampling and uploaded research. Only the server adapter writes here. */
export const CLOSED_BAR_SCHEMA_SQL = `
CREATE TABLE closed_contexts(id TEXT PRIMARY KEY,instrument_id TEXT NOT NULL,session_date TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE closed_sources(instrument_id TEXT PRIMARY KEY,context_id TEXT NOT NULL REFERENCES closed_contexts(id),owner_epoch TEXT NOT NULL);
CREATE TABLE closed_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner_epoch TEXT NOT NULL,connection_epoch TEXT NOT NULL,instrument_id TEXT NOT NULL,received_at INTEGER NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL);
CREATE TABLE closed_receipt_results(seq INTEGER PRIMARY KEY REFERENCES closed_receipts(seq),status TEXT NOT NULL,decision_at INTEGER NOT NULL);
CREATE INDEX closed_receipts_stream ON closed_receipts(connection_epoch,instrument_id,seq);
CREATE TABLE closed_streams(connection_epoch TEXT NOT NULL,instrument_id TEXT NOT NULL,context_id TEXT NOT NULL REFERENCES closed_contexts(id),from_at INTEGER NOT NULL,through_at INTEGER NOT NULL,healthy INTEGER NOT NULL,reason TEXT,PRIMARY KEY(connection_epoch,instrument_id));
CREATE TABLE closed_minutes(connection_epoch TEXT NOT NULL,instrument_id TEXT NOT NULL,start INTEGER NOT NULL,receipt_seq INTEGER NOT NULL REFERENCES closed_receipts(seq),json TEXT NOT NULL,PRIMARY KEY(connection_epoch,instrument_id,start));
CREATE TABLE closed_attempts(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),plan_id TEXT NOT NULL,plan_version INTEGER NOT NULL,owner_epoch TEXT NOT NULL,connection_epoch TEXT NOT NULL,context_id TEXT NOT NULL REFERENCES closed_contexts(id),activation_seq INTEGER NOT NULL,config_json TEXT NOT NULL,state_json TEXT NOT NULL,emitted_json TEXT NOT NULL,phase TEXT NOT NULL,watermark INTEGER NOT NULL,deadline_watermark INTEGER,source_attempt_id TEXT,created_at INTEGER NOT NULL);
CREATE TABLE closed_inputs(attempt_id TEXT NOT NULL REFERENCES closed_attempts(attempt_id),ingest_seq INTEGER NOT NULL,receipt_seq INTEGER REFERENCES closed_receipts(seq),input_hash TEXT NOT NULL,input_json TEXT NOT NULL,state_json TEXT NOT NULL,events_json TEXT NOT NULL,decision_at INTEGER NOT NULL,PRIMARY KEY(attempt_id,ingest_seq));
CREATE UNIQUE INDEX closed_input_identity ON closed_inputs(attempt_id,json_extract(input_json,'$.id'));
CREATE TRIGGER closed_attempts_no_delete BEFORE DELETE ON closed_attempts BEGIN SELECT RAISE(ABORT,'CLOSED_ATTEMPT_FROZEN'); END;
${Object.entries(keys)
  .map(
    ([table, key]) =>
      `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${key}) BEGIN SELECT RAISE(ABORT,'CLOSED_EVIDENCE_IMMUTABLE'); END;`,
  )
  .join("\n")}
CREATE TRIGGER closed_attempt_config_frozen BEFORE UPDATE ON closed_attempts WHEN OLD.attempt_id<>NEW.attempt_id OR OLD.plan_id<>NEW.plan_id OR OLD.plan_version<>NEW.plan_version OR OLD.owner_epoch<>NEW.owner_epoch OR OLD.connection_epoch<>NEW.connection_epoch OR OLD.context_id<>NEW.context_id OR OLD.activation_seq<>NEW.activation_seq OR OLD.config_json<>NEW.config_json OR OLD.source_attempt_id IS NOT NEW.source_attempt_id OR OLD.created_at<>NEW.created_at BEGIN SELECT RAISE(ABORT,'CLOSED_ATTEMPT_FROZEN'); END;
${[
  "closed_contexts",
  "closed_receipts",
  "closed_receipt_results",
  "closed_minutes",
  "closed_inputs",
]
  .map(
    (
      table,
    ) => `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'CLOSED_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'CLOSED_EVIDENCE_IMMUTABLE'); END;`,
  )
  .join("\n")}
`;
