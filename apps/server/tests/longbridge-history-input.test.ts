import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHistoryCapture,
  dailyHistoryWindows,
  inspectHistorySamples,
} from "../../../packages/market-data/history-capture.js";
import type { ProviderBarSample } from "../../../packages/market-data/longbridge.js";
import {
  prepareLongbridgeHistoryCandidates,
  readLongbridgeHistoryCapture,
} from "../longbridge-history-input.js";
const instrument = { symbol: "AAPL.US", market: "US" as const };
const window = { from: "2026-01-01", through: "2026-04-10" };
const at = Date.parse("2026-05-01T00:00:00Z");
function sample(timestamp: number, receivedAt = at + 1): ProviderBarSample {
  return {
    symbol: instrument.symbol,
    period: "1D",
    timestamp,
    receivedAt,
    open: "100.10",
    high: "102",
    low: "99",
    close: "101",
    volume: "100",
    turnover: "10000.50",
    tradeSession: 0,
    adjustment: "RAW",
    finality: "UNKNOWN",
    volumeUnit: "UNVERIFIED",
  };
}
function capture() {
  const c = createHistoryCapture(instrument.symbol, window, at);
  for (const page of dailyHistoryWindows(window.from, window.through)) {
    c.pages.push({
      ...page,
      receivedAt: at + 2,
      samples: [sample(Date.parse(`${page.from}T05:00:00Z`))],
    });
    c.calendarPages.push({
      ...page,
      receivedAt: at + 3,
      tradingDays: [page.from],
      halfDays: [],
      sessionHoursVerified: false,
    });
  }
  c.completedAt = at + 4;
  c.status = "SAMPLED";
  return c;
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function journal(c = capture()) {
  const dir = mkdtempSync(join(tmpdir(), "history-input-"));
  dirs.push(dir);
  const path = join(dir, "history.jsonl");
  const report = {
    schema: "pullback-lab-market-probe-v2",
    completedAt: new Date(at + 5).toISOString(),
    historyCaptures: [c],
  };
  writeFileSync(path, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return { path, report, dir };
}
describe("bounded private Longbridge history input", () => {
  it("preserves exact raw values, receipt times, source, all samples and UNKNOWN states", () => {
    const c = capture();
    c.pages[0].samples.push(
      ...Array.from({ length: 9 }, (_, i) =>
        sample(c.pages[0].samples[0].timestamp + (i + 1) * 86400000),
      ),
    );
    const result = prepareLongbridgeHistoryCandidates(c, instrument);
    expect(result.samples).toEqual(c.pages.flatMap((p) => p.samples));
    expect(result.samples).toHaveLength(11);
    expect(result.captureHash).toMatch(/^longbridge-history-v1:[a-f0-9]{64}$/);
    expect(result.scope).toMatchObject({
      ...window,
      symbol: instrument.symbol,
      source: "longbridge-node-5.2.0",
      endpoint: "historyCandlesticksByDate",
    });
    expect(result.receivedAt).toEqual({ first: at + 1, last: at + 3 });
    expect(result.capture).toMatchObject({
      capability: "UNKNOWN",
      coverage: "UNKNOWN",
      timestampAnchor: "UNKNOWN",
    });
    expect(result.samples[0]).toMatchObject({
      volume: "100",
      turnover: "10000.50",
      volumeUnit: "UNVERIFIED",
      finality: "UNKNOWN",
    });
    c.pages[0].samples[0].close = "100";
    expect(
      prepareLongbridgeHistoryCandidates(c, instrument).captureHash,
    ).not.toBe(result.captureHash);
    expect(result.samples[0].close).toBe("101");
  });
  it("preserves same-payload duplicates across receipts but rejects conflicting revisions", () => {
    const c = capture(),
      first = c.pages[0].samples[0];
    c.pages[0].samples.push({ ...first, receivedAt: at + 2 });
    expect(
      prepareLongbridgeHistoryCandidates(c, instrument).duplicateTimestamps,
    ).toEqual([first.timestamp]);
    expect(
      prepareLongbridgeHistoryCandidates(c, instrument).samples,
    ).toHaveLength(3);
    c.pages[0].samples.push({ ...first, volume: "101" });
    expect(
      inspectHistorySamples(c.pages.flatMap((p) => p.samples))
        .conflictTimestamps,
    ).toEqual([first.timestamp]);
    expect(() => prepareLongbridgeHistoryCandidates(c, instrument)).toThrow(
      "HISTORY_CAPTURE_CONFLICT",
    );
  });
  it.each([
    (c: ReturnType<typeof capture>) => {
      c.status = "INCOMPLETE";
    },
    (c: ReturnType<typeof capture>) => {
      c.completedAt = undefined;
    },
    (c: ReturnType<typeof capture>) => {
      c.pages.pop();
    },
    (c: ReturnType<typeof capture>) => {
      c.calendarPages.pop();
    },
    (c: ReturnType<typeof capture>) => {
      c.pages.reverse();
    },
    (c: ReturnType<typeof capture>) => {
      c.pages[0].samples[0].symbol = "OTHER.US";
    },
    (c: ReturnType<typeof capture>) => {
      c.pages[0].samples[0].receivedAt = at - 1;
    },
    (c: ReturnType<typeof capture>) => {
      c.pages[0].samples[0].receivedAt = at + 10;
    },
    (c: ReturnType<typeof capture>) => {
      c.calendarPages[0].tradingDays.push("2026-04-01");
    },
    (c: ReturnType<typeof capture>) => {
      c.calendarPages[0].tradingDays.push(c.calendarPages[0].tradingDays[0]);
    },
    (c: ReturnType<typeof capture>) => {
      c.pages[0].samples[0].finality = "CONFIRMED";
    },
  ])("rejects incomplete, mismatched and self-certifying captures", (edit) => {
    const c = capture();
    edit(c);
    expect(() => prepareLongbridgeHistoryCandidates(c, instrument)).toThrow();
  });
  it("reads only a final completed checkpoint and refuses truncated or mutated tails", () => {
    const { path, report } = journal();
    const earlier = { ...report, historyCaptures: [] };
    writeFileSync(
      path,
      `${JSON.stringify(earlier)}\n${JSON.stringify(report)}\n`,
    );
    expect(
      readLongbridgeHistoryCapture(path, {
        ...window,
        symbol: instrument.symbol,
      }).samples,
    ).toHaveLength(2);
    const bytes = readFileSync(path, "utf8");
    writeFileSync(path, `${bytes}{"incomplete":`);
    expect(() =>
      readLongbridgeHistoryCapture(path, {
        ...window,
        symbol: instrument.symbol,
      }),
    ).toThrow("HISTORY_CAPTURE_JOURNAL_INCOMPLETE");
    writeFileSync(path, `${bytes}{}\n`);
    expect(() =>
      readLongbridgeHistoryCapture(path, {
        ...window,
        symbol: instrument.symbol,
      }),
    ).toThrow("HISTORY_CAPTURE_JOURNAL_INCOMPLETE");
  });
  it("rejects wrong scope, duplicate captures and symlinks without exposing paths", () => {
    const { path, report, dir } = journal();
    expect(() =>
      readLongbridgeHistoryCapture(path, { ...window, symbol: "OTHER.US" }),
    ).toThrow("HISTORY_CAPTURE_SCOPE_MISMATCH");
    report.historyCaptures.push(report.historyCaptures[0]);
    writeFileSync(path, `${JSON.stringify(report)}\n`);
    expect(() =>
      readLongbridgeHistoryCapture(path, {
        ...window,
        symbol: instrument.symbol,
      }),
    ).toThrow("HISTORY_CAPTURE_SCOPE_MISMATCH");
    const link = join(dir, "link.jsonl");
    symlinkSync(path, link);
    expect(() =>
      readLongbridgeHistoryCapture(link, {
        ...window,
        symbol: instrument.symbol,
      }),
    ).toThrow("HISTORY_CAPTURE_READ_FAILED");
  });
  it("rejects impossible, reversed and excessive windows; includes both end dates", () => {
    expect(dailyHistoryWindows("2026-01-01", "2026-04-10")).toEqual([
      { from: "2026-01-01", through: "2026-03-31" },
      { from: "2026-04-01", through: "2026-04-10" },
    ]);
    expect(dailyHistoryWindows("2026-10-13", "2026-10-13")).toHaveLength(1);
    for (const [from, through] of [
      ["2026-02-30", "2026-03-01"],
      ["2026-10-13", "2026-10-12"],
      ["2020-01-01", "2026-01-01"],
    ])
      expect(() => dailyHistoryWindows(from, through)).toThrow();
  });
});
