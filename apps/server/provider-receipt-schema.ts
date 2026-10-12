import type Database from "better-sqlite3";

// Keep these expressions identical in the index and its queries. Malformed legacy
// payloads must not prevent a backed-up database from migrating.
export const RECEIPT_SYMBOL_SQL = `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.symbol') END`;
export const RECEIPT_PERIOD_SQL = `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.period') END`;

export function migrateProviderReceipts(db: Database.Database): void {
  const columns = db.pragma("table_info(market_provider_receipts)") as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === "requested_period"))
    db.exec(`ALTER TABLE market_provider_receipts ADD COLUMN requested_period TEXT
      CHECK(requested_period IN ('1D','1m','5m'))`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS market_provider_stream_sequence
      ON market_provider_receipts(instrument_id,requested_period,sequence DESC);
    CREATE INDEX IF NOT EXISTS market_provider_predecessor
      ON market_provider_receipts(instrument_id,source,${RECEIPT_SYMBOL_SQL},${RECEIPT_PERIOD_SQL},provider_timestamp,sequence DESC);
  `);
}
