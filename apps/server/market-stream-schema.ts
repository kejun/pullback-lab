import type Database from "better-sqlite3";

export const MARKET_STREAM_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS market_worker_watermarks(
    instrument_id TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('1D','1m','5m')),
    json TEXT NOT NULL, PRIMARY KEY(instrument_id,period));
  CREATE TABLE IF NOT EXISTS market_worker_streams(
    instrument_id TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('1D','1m','5m')),
    json TEXT NOT NULL, PRIMARY KEY(instrument_id,period));
`;

/** Preserve every legacy daily watermark, including its private accepted-start field. */
export function migrateMarketStreams(db: Database.Database): void {
  db.exec(`
    ALTER TABLE market_worker_watermarks RENAME TO market_worker_daily_watermarks_v7;
    ${MARKET_STREAM_SCHEMA_SQL}
    INSERT INTO market_worker_watermarks(instrument_id,period,json)
      SELECT instrument_id,'1D',json_set(json,'$.period','1D') FROM market_worker_daily_watermarks_v7;
    DROP TABLE market_worker_daily_watermarks_v7;
  `);
}
