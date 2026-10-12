import type { Instrument, Market } from "./index.js";

export interface UniverseInstrumentRow {
  instrument: Instrument;
  tags: string[];
  note: string;
  manual: boolean;
}
export interface UniverseLimits {
  researchMax: number;
  monitoringMax: number;
  effectiveResearchMax: number;
  effectiveMonitoringMax: number;
  researchUsed: number;
  localResearchRemaining: number;
  provider: {
    verified: boolean;
    researchSymbols: number | null;
    simultaneousSubscriptions: number | null;
    monthlyUniqueSymbols: number | null;
    requestsPerSecond: number | null;
  };
}
export interface UniverseSnapshot {
  rows: UniverseInstrumentRow[];
  universeRevision: string;
  limits: UniverseLimits;
}
export interface UniverseImportInputRow {
  symbol: string;
  market: Market;
  name?: string;
  tags?: string[];
  note?: string;
}
export interface UniverseImportRowResult {
  row: number;
  symbol: string;
  market: Market;
  id: string;
  status: "imported" | "existing" | "duplicate";
  duplicateOf?: number;
}
export interface UniverseImportResult {
  results: UniverseImportRowResult[];
  imported: number;
  existing: number;
  duplicates: number;
  universeRevision: string;
  limits: UniverseLimits;
}
export interface UniverseRowError {
  row: number;
  status: "error";
  code: string;
  error: string;
}
