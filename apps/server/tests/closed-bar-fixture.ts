/** Isolated contract fixture. Never imported by application or provider startup. */
import type { Funds, PlanInput } from "../../../packages/contracts/index.js";
import {
  generateDemoBars,
  demoInstruments,
} from "../../../packages/market-data/fixtures.js";
import { resolveSession } from "../../../packages/market-data/calendar.js";
import type {
  ClosedBarAdapter,
  ClosedBarContext,
  ClosedBarSink,
  ClosedMinute,
} from "../closed-bar-adapter.js";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { Store } from "../store.js";
export const OPEN = Date.parse("2026-10-09T13:30:00Z");
export const INSTRUMENT = "CONTRACT-US-A";
export class ContractAdapter implements ClosedBarAdapter {
  sinks: ClosedBarSink[] = [];
  context: ClosedBarContext = {
    source: "isolated-contract-test",
    probeReportId: "test-probe",
    instrumentRulesId: "test-rules",
    dailyHistoryId: "test-complete-daily",
    adjustmentEvidenceId: "test-no-splits",
    basisDate: "2026-10-09",
    basisKnownAt: OPEN - 1,
    instrument: {
      ...demoInstruments[0],
      id: INSTRUMENT,
      symbol: "CONTRACT.US",
      name: "Isolated runtime contract fixture",
    },
    calendar: {
      market: "US",
      date: "2026-10-09",
      status: "OPEN",
      intervals: [{ open: "09:30", close: "16:00" }],
      source: "test-calendar",
      version: "test-v1",
      knownAt: OPEN - 1000,
      verified: true,
    },
    capability: {
      market: "US",
      source: "isolated-contract-test",
      checkedAt: OPEN - 1000,
      validUntil: OPEN + 8 * 3600000,
      deploymentRegion: "OTHER",
      apiEntitlementVerified: true,
      historicalReadVerified: true,
      realtimeEntitlementVerified: true,
      unitsVerified: true,
      calendarVerified: true,
      completeMinutes: true,
      finalityContractVerified: true,
      maxClosedBarDelayMs: 30000,
      quoteAgeMs: 3000,
      sequenceContractVerified: false,
      continuousTradesVerified: false,
      clockSkewMs: 0,
      delayMinutes: 0,
    },
    daily: generateDemoBars("DEMO-US-A", "1D").map((b, i) => ({
      ...b,
      id: `contract:daily:${i}`,
      synthetic: false,
      adjustmentVerified: true,
      adjustmentVersion: "contract-split-v1",
    })),
  };
  contexts() {
    return [this.context];
  }
  async start(sink: ClosedBarSink) {
    this.sinks.push(sink);
  }
  subscriptions: readonly string[] = [];
  async setSubscriptions(ids: readonly string[]) {
    this.subscriptions = [...ids];
  }
  async stop() {}
  get sink() {
    return this.sinks.at(-1)!;
  }
  get session() {
    const r = resolveSession([this.context.calendar], "US", "2026-10-09", OPEN);
    if (!r.ok || !r.session) throw new Error("fixture session");
    return r.session;
  }
  bar(index: number, values: Partial<ClosedMinute> = {}): ClosedMinute {
    return {
      id: `contract:minute:${index}`,
      instrumentId: INSTRUMENT,
      market: "US",
      period: "1m",
      start: OPEN + index * 60000,
      end: OPEN + (index + 1) * 60000,
      open: "101",
      high: "101.2",
      low: "100.8",
      close: "101",
      volume: "1000",
      volumeUnit: "SHARE",
      final: true,
      source: this.context.source,
      providerRevision: "1",
      sessionId: this.session.id,
      adjustment: "RAW",
      ...values,
    };
  }
  quote(at: number, price = "101") {
    this.sink.quote({
      instrumentId: INSTRUMENT,
      sessionId: this.session.id,
      source: this.context.source,
      id: `quote:${at}:${price}`,
      price,
      at,
    });
  }
}
export const planInput: PlanInput = {
  instrumentId: INSTRUMENT,
  anchorTime: null,
  primarySupport: "100",
  lower: "99.75",
  upper: "100.25",
  stop: "99.4",
  entryMin: "100.61",
  entryMax: "101.5",
  mode: "CLOSE_CONFIRM",
  sessionDate: "2026-10-09",
  reason: "Isolated formal runtime contract",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "support" },
  ],
};
export const testFunds: Funds = {
  generation: 0,
  nav: "10000",
  baseCurrency: "USD",
  cash: { USD: "10000", CNY: "0" },
  existing: {},
  riskBudget: "50",
  riskPool: "100",
  maxWeight: "0.2",
  fx: { USD: "1", CNY: "0.14" },
  fxAsOf: OPEN,
  confirmedAt: OPEN,
  stale: false,
  buyFee: "0",
  sellFee: "0",
  slippageIn: "0",
  slippageOut: "0",
  feesConfirmed: true,
};
export async function setupClosed(
  options: { path?: string; autoDrain?: boolean; activate?: boolean } = {},
) {
  let now = OPEN - 1;
  const store = new Store(options.path);
  const adapter = new ContractAdapter();
  store.putInstrument({
    instrument: adapter.context.instrument,
    manual: true,
    note: "isolated test",
    tags: [],
  });
  const runner = new ClosedBarRuntime(store, {
    adapter,
    now: () => now,
    autoDrain: options.autoDrain,
  });
  await runner.start();
  store.confirmScreening(undefined, 0, now);
  store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
  const created = store.createPlan(planInput, now);
  const plan =
    options.activate === false
      ? created
      : runner.activate(created.id, {
          expectedVersion: created.version,
          expectedAttemptId: null,
        }).plan;
  now = OPEN;
  store.updateFunds(testFunds, store.funds()!.generation, now);
  return {
    store,
    adapter,
    runner,
    plan,
    setNow: (at: number) => {
      now = at;
    },
    now: () => now,
    minute: (i: number, values: Partial<ClosedMinute> = {}, delay = 0) => {
      now = OPEN + (i + 1) * 60000 + delay;
      adapter.quote(now, values.close ?? "101");
      adapter.sink.minute(adapter.bar(i, values));
    },
    close: async () => {
      await runner.stop();
      store.close();
    },
  };
}
