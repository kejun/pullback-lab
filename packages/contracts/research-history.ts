import type { Bar } from "./index.js";

export interface ResearchHistorySummary {
  id: string;
  instrumentId: string;
  source: string;
  importedAt: number;
  targetDate: string;
  actionEvidenceVersion: string;
  adjustmentVersion: string;
  counts: Record<"1D" | "1m" | "5m", number>;
  current: boolean;
  reasons: string[];
  liveEligible: false;
}
export interface ResearchHistoryPreview {
  status: "PREVIEW";
  token: string;
  expectedHistoryId: string | null;
  expectedActionVersion: string | null;
  summary: Omit<ResearchHistorySummary, "id" | "importedAt" | "current">;
  warnings: string[];
}
export interface ResearchHistoryStatus {
  current: ResearchHistorySummary | null;
  history: ResearchHistorySummary[];
}
export interface ResearchChartData {
  bars: Bar[];
  ema9: (string | null)[];
  ema21: (string | null)[];
  ema50: (string | null)[];
  avwap: (string | null)[];
  synthetic: boolean;
  researchHistory?: ResearchHistorySummary | null;
  /** Completion time in UTC seconds of the daily candle used per point; retrospective, never a receipt-time claim. */
  avwapCutoffs?: (number | null)[];
}
