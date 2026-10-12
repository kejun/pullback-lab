import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ScreeningParameters,
  ScreeningRuleVersion,
} from "../../packages/contracts/screening.js";
import { INDICATOR_VERSION } from "../../packages/domain/indicators.js";
import { DEFAULT_SCREENING_PARAMETERS } from "../../packages/domain/screening-rules.js";

export const SCREENING_SCHEMA_SQL = `
  CREATE TABLE screening_rule_versions(version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
  CREATE TRIGGER screening_rule_versions_no_update BEFORE UPDATE ON screening_rule_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCREENING_RULE'); END;
  CREATE TRIGGER screening_rule_versions_no_delete BEFORE DELETE ON screening_rule_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCREENING_RULE'); END;
  CREATE TRIGGER screening_rule_versions_no_replace BEFORE INSERT ON screening_rule_versions WHEN EXISTS(SELECT 1 FROM screening_rule_versions WHERE version=NEW.version OR hash=NEW.hash) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCREENING_RULE'); END;
`;

export function makeScreeningRule(
  version: number,
  parameters: ScreeningParameters,
  confirmedAt: number | null,
  confirmationBasis: ScreeningRuleVersion["confirmationBasis"] = "USER_CONFIRMED",
): ScreeningRuleVersion {
  const content = {
    version,
    algorithmVersion: INDICATOR_VERSION,
    parameters,
    confirmedAt,
    confirmationBasis,
    source: "C_ENGINEERING_TEST_PRESET" as const,
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

export function currentScreeningRule(
  db: Database.Database,
): ScreeningRuleVersion | null {
  const row = db
    .prepare(
      "SELECT json FROM screening_rule_versions ORDER BY version DESC LIMIT 1",
    )
    .get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) : null;
}

export function insertScreeningRule(
  db: Database.Database,
  rule: ScreeningRuleVersion,
): void {
  db.prepare(
    "INSERT INTO screening_rule_versions(version,hash,json) VALUES(?,?,?)",
  ).run(rule.version, rule.hash, JSON.stringify(rule));
}

/** A legacy boolean proves confirmation, but does not establish when it occurred. */
export function migrateScreeningRules(db: Database.Database): void {
  db.exec(SCREENING_SCHEMA_SQL);
  const flag = db
    .prepare("SELECT value FROM settings WHERE key='screening_confirmed'")
    .get() as { value: string } | undefined;
  if (flag?.value === "true")
    insertScreeningRule(
      db,
      makeScreeningRule(
        1,
        DEFAULT_SCREENING_PARAMETERS,
        null,
        "LEGACY_CONFIRMED_FLAG",
      ),
    );
}
