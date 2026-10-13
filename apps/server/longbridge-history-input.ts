import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Instrument } from "../../packages/contracts/index.js";
import type { ProviderBarSample } from "../../packages/market-data/longbridge.js";
import {
  dailyHistoryWindows,
  historyCaptureSchema,
  HISTORY_MAX_JOURNAL_BYTES,
  HISTORY_MAX_CHECKPOINT_BYTES,
  inspectHistorySamples,
  type HistoryCalendarPage,
  type HistoryWindow,
  type LongbridgeHistoryCapture,
} from "../../packages/market-data/history-capture.js";

export interface LongbridgeHistoryCandidates {
  /** Local content integrity only, never provider authenticity or audited eligibility. */
  captureHash: string;
  scope: Pick<
    LongbridgeHistoryCapture,
    "source" | "sdk" | "symbol" | "market" | "from" | "through" | "endpoint"
  >;
  samples: ProviderBarSample[];
  calendarPages: HistoryCalendarPage[];
  receivedAt: { first: number; last: number };
  duplicateTimestamps: number[];
  capture: LongbridgeHistoryCapture;
}
export class LongbridgeHistoryInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new LongbridgeHistoryInputError(code);
}

/** Server-only conversion to quarantined candidates. No normalization, session inference or certification. */
export function prepareLongbridgeHistoryCandidates(
  input: unknown,
  instrument: Pick<Instrument, "symbol" | "market">,
): LongbridgeHistoryCandidates {
  const parsed = historyCaptureSchema.safeParse(input);
  if (!parsed.success) return fail("HISTORY_CAPTURE_INVALID");
  const capture: LongbridgeHistoryCapture = parsed.data;
  if (
    capture.status !== "SAMPLED" ||
    capture.completedAt === undefined ||
    capture.completedAt < capture.startedAt
  )
    fail("HISTORY_CAPTURE_INCOMPLETE");
  if (
    capture.symbol !== instrument.symbol ||
    capture.market !== instrument.market ||
    capture.market !== (capture.symbol.endsWith(".US") ? "US" : "CN")
  )
    fail("HISTORY_CAPTURE_SCOPE_MISMATCH");
  let windows: HistoryWindow[];
  try {
    windows = dailyHistoryWindows(capture.from, capture.through);
  } catch {
    return fail("HISTORY_CAPTURE_WINDOW_INVALID");
  }
  for (const pages of [capture.pages, capture.calendarPages]) {
    if (pages.length !== windows.length) fail("HISTORY_CAPTURE_INCOMPLETE");
    pages.forEach((page, index) => {
      if (
        page.from !== windows[index].from ||
        page.through !== windows[index].through
      )
        fail("HISTORY_CAPTURE_PAGE_MISMATCH");
      if (
        page.receivedAt < capture.startedAt ||
        page.receivedAt > capture.completedAt!
      )
        fail("HISTORY_CAPTURE_RECEIPT_INVALID");
    });
  }
  for (const page of capture.pages) {
    for (const sample of page.samples) {
      if (sample.symbol !== capture.symbol || sample.period !== "1D")
        fail("HISTORY_CAPTURE_SAMPLE_MISMATCH");
      if (
        sample.receivedAt < capture.startedAt ||
        sample.receivedAt > page.receivedAt ||
        sample.timestamp > sample.receivedAt
      )
        fail("HISTORY_CAPTURE_RECEIPT_INVALID");
    }
  }
  for (const page of capture.calendarPages) {
    for (const dates of [page.tradingDays, page.halfDays]) {
      if (
        new Set(dates).size !== dates.length ||
        dates.some((date) => date < page.from || date > page.through)
      )
        fail("HISTORY_CAPTURE_CALENDAR_INVALID");
    }
  }
  const samples = capture.pages.flatMap((page) => page.samples);
  const diagnostics = inspectHistorySamples(samples);
  if (diagnostics.conflictTimestamps.length) fail("HISTORY_CAPTURE_CONFLICT");
  const received = [...capture.pages, ...capture.calendarPages].map(
    (page) => page.receivedAt,
  );
  received.push(...samples.map((sample) => sample.receivedAt));
  const { source, sdk, symbol, market, from, through, endpoint } = capture;
  return {
    captureHash: `longbridge-history-v1:${createHash("sha256").update(JSON.stringify(capture)).digest("hex")}`,
    scope: { source, sdk, symbol, market, from, through, endpoint },
    samples,
    calendarPages: capture.calendarPages,
    receivedAt: { first: Math.min(...received), last: Math.max(...received) },
    duplicateTimestamps: diagnostics.duplicateTimestamps,
    capture,
  };
}

/** Fixed server-code path only. Read the final complete checkpoint; never fall back across a damaged tail. */
export function readLongbridgeHistoryCapture(
  path: string,
  scope: HistoryWindow & { symbol: string },
): LongbridgeHistoryCandidates {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > HISTORY_MAX_JOURNAL_BYTES
    )
      fail("HISTORY_CAPTURE_FILE_BOUNDS");
    const length = Math.min(stat.size, HISTORY_MAX_CHECKPOINT_BYTES + 1);
    const tail = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(
        fd,
        tail,
        read,
        length - read,
        stat.size - length + read,
      );
      if (!count) fail("HISTORY_CAPTURE_FILE_CHANGED");
      read += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      fail("HISTORY_CAPTURE_FILE_CHANGED");
    if (tail.at(-1) !== 10) fail("HISTORY_CAPTURE_JOURNAL_INCOMPLETE");
    const start = tail.lastIndexOf(10, tail.length - 2) + 1;
    if (
      (!start && stat.size > length) ||
      tail.length - start > HISTORY_MAX_CHECKPOINT_BYTES
    )
      fail("HISTORY_CAPTURE_CHECKPOINT_BOUNDS");
    const report: unknown = JSON.parse(
      tail.subarray(start, tail.length - 1).toString("utf8"),
    );
    if (!report || typeof report !== "object")
      fail("HISTORY_CAPTURE_REPORT_INVALID");
    const record = report as Record<string, unknown>;
    if (
      record.schema !== "pullback-lab-market-probe-v2" ||
      typeof record.completedAt !== "string" ||
      !Number.isFinite(Date.parse(record.completedAt)) ||
      !Array.isArray(record.historyCaptures)
    )
      fail("HISTORY_CAPTURE_JOURNAL_INCOMPLETE");
    const matches = record.historyCaptures.filter(
      (value) =>
        value &&
        typeof value === "object" &&
        value.symbol === scope.symbol &&
        value.from === scope.from &&
        value.through === scope.through,
    );
    if (matches.length !== 1) fail("HISTORY_CAPTURE_SCOPE_MISMATCH");
    const candidates = prepareLongbridgeHistoryCandidates(matches[0], {
      symbol: scope.symbol,
      market: scope.symbol.endsWith(".US") ? "US" : "CN",
    });
    if (candidates.capture.completedAt! > Date.parse(record.completedAt))
      fail("HISTORY_CAPTURE_RECEIPT_INVALID");
    return candidates;
  } catch (error) {
    if (error instanceof LongbridgeHistoryInputError) throw error;
    return fail("HISTORY_CAPTURE_READ_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
