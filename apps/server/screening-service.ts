import { createHash } from "node:crypto";
import type {
  Bar,
  CandidateMarketCoverage,
  CandidatePage,
  CandidateRow,
} from "../../packages/contracts/index.js";
import {
  INDICATOR_VERSION,
  rankCandidates,
  screenInstrument,
} from "../../packages/domain/indicators.js";
import type { Store, StoredInstrument } from "./store.js";
import {
  emptyMarketWorkerStatus,
  type MarketWorkerStatus,
} from "./market-worker.js";
import { trustedClosedSupport } from "./closed-bar-adapter.js";
import { universeRevision } from "./universe-service.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function eligible(bar: Bar, now: number): boolean {
  if (
    !bar.final ||
    !Number.isSafeInteger(bar.time) ||
    !Number.isSafeInteger(bar.receivedAt) ||
    bar.time * 1000 > now ||
    bar.receivedAt > now
  )
    return false;
  // Fixture daily bars use midnight UTC, with completion at the documented fixture receipt.
  // This is never used as an exchange calendar for real securities.
  if (bar.id.startsWith("synthetic:") && bar.time * 1000 + 86_399_000 > now)
    return false;
  return true;
}
function syntheticEvidence(row: StoredInstrument, bars: Bar[]): boolean {
  return (
    row.instrument.id.startsWith("DEMO-") &&
    bars.length > 0 &&
    bars.every((bar) => {
      const evidence = bar as Bar & {
        synthetic?: boolean;
        adjustmentVerified?: boolean;
      };
      return (
        bar.id.startsWith("synthetic:") &&
        evidence.synthetic === true &&
        evidence.adjustmentVerified === true
      );
    })
  );
}
function coverage(rows: CandidateRow[]): CandidateMarketCoverage {
  return {
    total: rows.length,
    manual: rows.filter((row) => row.manual).length,
    ready: rows.filter((row) => row.indicators.screeningReady).length,
    passed: rows.filter((row) => row.screeningStatus === "PASS").length,
    failed: rows.filter((row) => row.screeningStatus === "FAIL").length,
    unknown: rows.filter((row) => row.screeningStatus === "UNKNOWN").length,
    ranked: rows.filter((row) => row.rank !== null).length,
  };
}

/** One bounded cache per application. Complete source content participates in its key. */
export class ScreeningService {
  private cached:
    | {
        key: string;
        page: Omit<CandidatePage, "evaluatedAt" | "cacheHit" | "workerHealth">;
      }
    | undefined;
  constructor(private readonly store: Store) {}

  candidates(
    now: number,
    worker: MarketWorkerStatus = emptyMarketWorkerStatus(),
  ): CandidatePage {
    const snapshot = this.store.db.transaction(() => {
      const rows = this.store.listInstruments();
      const series = rows.map((row) =>
        this.store.bars(row.instrument.id, "1D"),
      );
      return {
        rows,
        rules: this.store.screeningSettings(),
        revision: universeRevision(this.store),
        series,
        trusted: rows.map((row, i) =>
          trustedClosedSupport(this.store.db, row.instrument, series[i], now),
        ),
      };
    })();
    const visible = snapshot.series.map((bars) =>
      bars.filter((bar) => eligible(bar, now)),
    );
    // Revision corrections, intraday receipts and metadata edits invalidate even at unchanged lengths/times.
    // Eligibility also participates so a previously future bar invalidates once its inputs become known.
    const key = hash({
      algorithm: INDICATOR_VERSION,
      rules: snapshot.rules.current,
      universe: snapshot.revision,
      bars: snapshot.series,
      providerContexts: snapshot.trusted.map((context) => context?.id ?? null),
      visible: visible.map((bars) => bars.map((bar) => bar.id)),
    });
    const cacheHit = this.cached?.key === key;
    if (!cacheHit) {
      const candidates = snapshot.rows.map((row, index): CandidateRow => {
        const bars = visible[index];
        const original = snapshot.series[index];
        const synthetic = syntheticEvidence(row, bars);
        const trusted = snapshot.trusted[index];
        const verified = synthetic || Boolean(trusted);
        const result = screenInstrument(row.instrument, bars, {
          historyComplete: verified,
          unadjusted: synthetic,
          parameters: snapshot.rules.current?.parameters,
        });
        if (!verified) {
          result.status = "UNKNOWN";
          result.reasons = [
            ...new Set([
              ...result.reasons,
              "HISTORY_NOT_VERIFIED",
              "ADJUSTMENT_PROVENANCE_UNVERIFIED",
            ]),
          ];
        }
        if (!snapshot.rules.current) {
          result.status = "UNKNOWN";
          result.reasons = [
            ...new Set([...result.reasons, "SCREENING_RULES_UNCONFIRMED"]),
          ];
        }
        const ignoredUnfinished = original.filter((bar) => !bar.final).length;
        const ignoredFuture = original.filter(
          (bar) => bar.final && !eligible(bar, now),
        ).length;
        const healthReasons = [
          ...(bars.length === 0 ? ["MISSING_HISTORY"] : []),
          ...(bars.length > 0 && bars.length < 250
            ? ["INSUFFICIENT_HISTORY"]
            : []),
          ...(synthetic
            ? ["SYNTHETIC_FIXTURE_NOT_LIVE"]
            : trusted
              ? ["SERVER_CONTEXT_DAILY_VERIFIED"]
              : ["HISTORY_NOT_VERIFIED", "ADJUSTMENT_PROVENANCE_UNVERIFIED"]),
          ...(!row.instrument.rulesVerified
            ? ["INSTRUMENT_RULES_UNVERIFIED"]
            : []),
          ...result.reasons.filter((reason) =>
            /^(?:INVALID_|UNORDERED_|MIXED_|INDICATOR_INPUT_MISSING)/.test(
              reason,
            ),
          ),
          ...(ignoredUnfinished ? ["UNFINISHED_BARS_EXCLUDED"] : []),
          ...(ignoredFuture ? ["FUTURE_INPUTS_EXCLUDED"] : []),
        ];
        return {
          ...result,
          status: row.manual ? "MANUAL" : result.status,
          screeningStatus: result.status as CandidateRow["screeningStatus"],
          manual: row.manual,
          origin: row.manual
            ? "MANUAL"
            : synthetic
              ? "SYNTHETIC"
              : trusted
                ? "PROVIDER"
                : "IMPORTED",
          tags: row.tags,
          note: row.note,
          dataCutoff: bars.at(-1)?.time ?? null,
          knownAt: bars.length
            ? Math.max(...bars.map((bar) => bar.receivedAt))
            : null,
          turnoverBasis:
            result.indicators.adv20 === null
              ? "MISSING"
              : result.indicators.estimatedTurnover
                ? "ESTIMATED"
                : "PROVIDER",
          health: {
            state: !bars.length
              ? "MISSING"
              : synthetic
                ? "SYNTHETIC"
                : trusted
                  ? "VERIFIED"
                  : "UNKNOWN",
            reasons: healthReasons,
            ignoredUnfinished,
            ignoredFuture,
          },
        };
      });
      const ranked = rankCandidates(
        candidates,
        snapshot.rules.current?.parameters.limitPerMarket ??
          snapshot.rules.defaultParameters.limitPerMarket,
      ) as CandidateRow[];
      this.cached = {
        key,
        page: {
          candidates: ranked,
          coverage: ranked.filter((row) => row.indicators.screeningReady)
            .length,
          asOf: ranked.reduce(
            (date, row) => (row.date > date ? row.date : date),
            "",
          ),
          rules: snapshot.rules,
          universeRevision: snapshot.revision,
          computedAt: now,
          marketCoverage: {
            US: coverage(
              ranked.filter((row) => row.instrument.market === "US"),
            ),
            CN: coverage(
              ranked.filter((row) => row.instrument.market === "CN"),
            ),
          },
        },
      };
    }
    const {
      state,
      reason,
      source,
      lastSuccessAt,
      lastFailureAt,
      lastErrorCode,
      lastQuarantineReason,
      providerQuotaVerified,
      liveEligible,
    } = worker;
    return {
      ...structuredClone(this.cached!.page),
      evaluatedAt: now,
      cacheHit,
      workerHealth: {
        state,
        reason,
        source,
        lastSuccessAt,
        lastFailureAt,
        lastErrorCode,
        lastQuarantineReason,
        providerQuotaVerified,
        liveEligible,
      },
    };
  }
}
