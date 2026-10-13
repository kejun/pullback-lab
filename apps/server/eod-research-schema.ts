/** Immutable research provenance; this source table never participates in live streams. */
export const EOD_RESEARCH_SCHEMA_SQL = `
CREATE TABLE eod_contexts(id TEXT PRIMARY KEY,instrument_id TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE eod_sources(instrument_id TEXT PRIMARY KEY,context_id TEXT NOT NULL REFERENCES eod_contexts(id));
CREATE TRIGGER eod_contexts_no_update BEFORE UPDATE ON eod_contexts BEGIN SELECT RAISE(ABORT,'EOD_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER eod_contexts_no_delete BEFORE DELETE ON eod_contexts BEGIN SELECT RAISE(ABORT,'EOD_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER eod_contexts_no_replace BEFORE INSERT ON eod_contexts WHEN EXISTS(SELECT 1 FROM eod_contexts WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'EOD_EVIDENCE_IMMUTABLE'); END;
`;
