import type { Bar } from "../contracts/index.js";
import { evidenceHash, type ActionManifest } from "./action-evidence.js";
// Explicitly synthetic evidence. This is not an issuer announcement or market data.
export const ACTION_TEST_NOW = 4_000_000;
export const actionTestBar: Bar = {
  id: "raw",
  time: 1000,
  open: "100",
  high: "120",
  low: "90",
  close: "110",
  volume: "20",
  turnover: "2200",
  receivedAt: 1_010_000,
  final: true,
  adjustmentVersion: "raw-v1",
};
export function actionTestManifest(): ActionManifest {
  const content =
    "SYNTHETIC TEST ONLY: 2 shares after for each 1 share before; full synthetic window.";
  return {
    schema: "pullback-lab-actions-v1",
    instrumentId: "DEMO-US-A",
    market: "US",
    expectedVersion: null,
    source: "synthetic-fixture",
    review: { reviewer: "fixture-reviewer", confirmed: true },
    coverage: {
      from: 0,
      through: 3_000_000,
      status: "COMPLETE",
      documentIds: ["doc"],
      reason: "完整合成窗口",
    },
    removedActionIds: [],
    documents: [
      {
        id: "doc",
        url: "https://example.invalid/synthetic",
        publishedAt: 1_000_000,
        content,
        sha256: evidenceHash(content),
      },
    ],
    actions: [
      {
        id: "split",
        revision: 1,
        kind: "SPLIT",
        effectiveAt: 2_000_000,
        publishedAt: 1_500_000,
        sharesAfter: "2",
        sharesBefore: "1",
        documentIds: ["doc"],
      },
    ],
  };
}
