export type ReceiptPeriod = "1D" | "1m" | "5m";
export type ReceiptScope = ReceiptPeriod | "unknown";
export interface ProviderReceiptSummary {
  sequence: number;
  epoch: number;
  source: string;
  requestedPeriod: ReceiptPeriod | null;
  receivedAt: number;
  observedAt: number;
  providerTimestamp: number;
  status: string;
  reason: string;
  payloadHash: string;
  payloadBytes: number;
}
export interface ProviderReceiptPage {
  instrumentId: string;
  period: ReceiptScope;
  snapshot: string;
  throughSequence: number;
  receipts: ProviderReceiptSummary[];
  nextBefore: number | null;
  liveEligible: false;
}
export interface ReceiptPayload extends ProviderReceiptSummary {
  payloadJson: string | null;
  integrity: "MATCH" | "MISMATCH" | "INVALID_JSON" | "TOO_LARGE";
  computedHash: string | null;
}
export interface ProviderReceiptDetail {
  instrumentId: string;
  snapshot: string;
  selected: ReceiptPayload;
  previous: ReceiptPayload | null;
  comparison: "FIRST_SEEN" | "UNCHANGED" | "CHANGED" | "UNAVAILABLE";
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  liveEligible: false;
}
