/** Raw payloads remain in immutable closed_receipts. These are verified provider cursors, not local sequence claims. */
export const INTRABAR_SCHEMA_SQL = `
CREATE TABLE tick_packets(connection_epoch TEXT NOT NULL,instrument_id TEXT NOT NULL,provider_epoch TEXT NOT NULL,provider_sequence TEXT NOT NULL,receipt_seq INTEGER NOT NULL REFERENCES closed_receipts(seq),payload_hash TEXT NOT NULL,cursor_json TEXT NOT NULL,PRIMARY KEY(connection_epoch,instrument_id,provider_epoch,provider_sequence));
CREATE INDEX tick_packets_receipt ON tick_packets(connection_epoch,instrument_id,receipt_seq);
CREATE TABLE tick_trades(receipt_seq INTEGER NOT NULL REFERENCES closed_receipts(seq),position INTEGER NOT NULL,provider_token TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(receipt_seq,position));
${["tick_packets", "tick_trades"]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'TICK_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'TICK_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${table === "tick_packets" ? "connection_epoch=NEW.connection_epoch AND instrument_id=NEW.instrument_id AND provider_epoch=NEW.provider_epoch AND provider_sequence=NEW.provider_sequence" : "receipt_seq=NEW.receipt_seq AND position=NEW.position"}) BEGIN SELECT RAISE(ABORT,'TICK_EVIDENCE_IMMUTABLE'); END;`,
  )
  .join("\n")}
`;
