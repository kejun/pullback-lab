import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Funds, Instrument } from "../contracts/index.js";
import { D } from "./numeric.js";
import { solveRisk, stressLoss, type RiskInput } from "./risk.js";
const NOW = Date.UTC(2026, 9, 12, 14, 0);
const instrument: Instrument = {
  id: "XNAS:TEST",
  symbol: "TEST",
  name: "Synthetic",
  market: "US",
  currency: "USD",
  tick: "0.01",
  qMin: 1,
  qStep: 1,
  sellSameDay: true,
  rulesVerified: true,
};
const funds: Funds = {
  generation: 1,
  nav: "10000",
  baseCurrency: "USD",
  cash: { USD: "10000", CNY: "0" },
  existing: {},
  riskBudget: "50",
  riskPool: "50",
  maxWeight: "0.2",
  fx: { USD: "1", CNY: "0.14" },
  fxAsOf: NOW,
  confirmedAt: NOW,
  stale: false,
  buyFee: "0",
  sellFee: "0",
  slippageIn: "0",
  slippageOut: "0",
  feesConfirmed: true,
};
const input = (changes: Partial<RiskInput> = {}): RiskInput => ({
  instrument: { ...instrument },
  funds: { ...funds },
  entryCheck: "20",
  entryMin: "19.6",
  entryMax: "20.5",
  stop: "19.5",
  now: NOW,
  ...changes,
});

describe("risk fixed samples T17–T23", () => {
  it("T17 returns 100 shares and cost-free R reference", () => {
    expect(solveRisk(input())).toMatchObject({
      quantity: 100,
      passed: true,
      cashUse: "2000",
      riskBase: "50",
      exposureBase: "2000",
      referencePrices: { r3: "21.5" },
      nextQuantity: 101,
      nextQuantityFeasible: false,
    });
  });
  it("T18 rechecks price and never increases above the approved quantity", () => {
    const trigger = {
      phase: "TRIGGER" as const,
      approvedQuantity: 100,
      quoteAsOf: NOW,
      funds: { ...funds, maxWeight: "1" },
    };
    expect(solveRisk(input({ ...trigger, entryCheck: "20.4" }))).toMatchObject({
      quantity: 55,
      riskBase: "49.5",
      passed: true,
    });
    expect(solveRisk(input({ ...trigger, entryCheck: "20.6" }))).toMatchObject({
      quantity: 0,
      passed: false,
      reasons: ["ENTRY_OUTSIDE_RANGE"],
    });
    expect(solveRisk(input({ ...trigger, entryCheck: "19.8" })).quantity).toBe(
      100,
    );
    expect(solveRisk(input({ ...trigger, approvedQuantity: 0 })).passed).toBe(
      false,
    );
  });
  it("T19 charges each fixed minimum once per order", () => {
    const result = solveRisk(
      input({ funds: { ...funds, maxWeight: "1", buyFee: "1", sellFee: "1" } }),
    );
    expect(result).toMatchObject({
      quantity: 96,
      riskBase: "50",
      buyFee: "1",
      sellFee: "1",
      nextQuantity: 97,
      nextQuantityFeasible: false,
    });
  });
  it("T20 honors distinct minimum and increment quantities", () => {
    const generous = {
      ...funds,
      riskBudget: "1000",
      riskPool: "1000",
      maxWeight: "1",
    };
    const first = { ...instrument, qMin: 200, qStep: 1 };
    expect(
      solveRisk(
        input({
          instrument: first,
          funds: { ...generous, cash: { USD: "3000", CNY: "0" } },
        }),
      ).quantity,
    ).toBe(0);
    expect(
      solveRisk(
        input({
          instrument: first,
          funds: { ...generous, cash: { USD: "4020", CNY: "0" } },
        }),
      ).quantity,
    ).toBe(201);
    expect(
      solveRisk(
        input({
          instrument: { ...instrument, qMin: 100, qStep: 100 },
          funds: { ...generous, cash: { USD: "4020", CNY: "0" } },
        }),
      ).quantity,
    ).toBe(200);
  });
  it("T21 multiplies by base-per-quote FX and never exchanges cash implicitly", () => {
    const cny: Funds = {
      ...funds,
      baseCurrency: "CNY",
      nav: "100000",
      riskBudget: "350",
      riskPool: "350",
      maxWeight: "1",
      fx: { USD: "7", CNY: "1" },
      cash: { USD: "10000", CNY: "100000" },
    };
    expect(solveRisk(input({ funds: cny }))).toMatchObject({
      quantity: 100,
      riskBase: "350",
    });
    expect(
      solveRisk(input({ funds: { ...cny, fx: { ...cny.fx, USD: "" } } }))
        .passed,
    ).toBe(false);
    expect(
      solveRisk(input({ funds: { ...cny, fxAsOf: NOW - 900001 } })).reasons,
    ).toContain("FX_STALE");
    expect(
      solveRisk(
        input({ funds: { ...cny, cash: { USD: "0", CNY: "1000000" } } }),
      ).reasons,
    ).toContain("CASH_LIMIT");
  });
  it("T22 pure residual input reduces the second reservation; stale after TAKEN blocks", () => {
    const shared = {
      ...funds,
      cash: { USD: "3000", CNY: "0" },
      riskPool: "100",
      maxWeight: "1",
    };
    const a = solveRisk(input({ funds: shared }));
    const b = solveRisk(
      input({
        funds: shared,
        reservations: {
          cash: a.cashUse,
          riskBase: a.riskBase,
          exposureBase: "0",
        },
      }),
    );
    expect(a.quantity).toBe(100);
    expect(b.quantity).toBe(50);
    expect(new D(a.cashUse).plus(b.cashUse).lte(shared.cash.USD)).toBe(true);
    expect(
      solveRisk(input({ funds: { ...shared, stale: true } })).reasons,
    ).toContain("FUNDS_SNAPSHOT_STALE");
    // SQLite transaction concurrency is tested by the server; this test verifies the arithmetic input only.
  });
  it("T23 demonstrates gap loss exceeding budget and marks the sale restriction", () => {
    expect(stressLoss(100, "20", "18")).toBe("200");
    expect(
      solveRisk(input({ instrument: { ...instrument, sellSameDay: false } }))
        .warnings,
    ).toContain("SAME_DAY_STOP_SALE_UNAVAILABLE");
  });
});

describe("risk rejection and maximality", () => {
  it("rejects missing fees, stale/future snapshots, quote and missing approval at trigger", () => {
    expect(
      solveRisk(input({ funds: { ...funds, feesConfirmed: false } })).reasons,
    ).toContain("FEES_UNCONFIRMED");
    expect(
      solveRisk(input({ funds: { ...funds, confirmedAt: NOW - 86400001 } }))
        .reasons,
    ).toContain("FUNDS_SNAPSHOT_EXPIRED");
    expect(
      solveRisk(input({ funds: { ...funds, confirmedAt: NOW + 1 } })).passed,
    ).toBe(false);
    expect(
      solveRisk(input({ phase: "TRIGGER", approvedQuantity: 100 })).reasons,
    ).toContain("FRESH_QUOTE_REQUIRED");
    expect(
      solveRisk(
        input({
          phase: "TRIGGER",
          approvedQuantity: 100,
          quoteAsOf: NOW - 3001,
        }),
      ).reasons,
    ).toContain("QUOTE_STALE");
    expect(
      solveRisk(input({ phase: "TRIGGER", quoteAsOf: NOW })).reasons,
    ).toContain("APPROVED_QUANTITY_REQUIRED");
    expect(solveRisk(input({ sessionStartedAt: NOW + 1 })).reasons).toContain(
      "FUNDS_SESSION_CONFIRMATION_REQUIRED",
    );
  });
  it("PLAN reserves at the final allowed ceiling without double-counting entry slippage", () => {
    expect(
      solveRisk(
        input({
          phase: "PLAN",
          entryCheck: "20.5",
          funds: { ...funds, slippageIn: "0.1" },
        }),
      ),
    ).toMatchObject({ entry: "20.5", quantity: 50, passed: true });
    expect(
      solveRisk(
        input({
          phase: "TRIGGER",
          quoteAsOf: NOW,
          approvedQuantity: 50,
          entryCheck: "20.5",
          funds: { ...funds, slippageIn: "0.1" },
        }),
      ).reasons,
    ).toContain("ENTRY_OUTSIDE_RANGE");
  });
  it("rounds entry up and stop down, applies ask, and prevents prices outside the band", () => {
    expect(
      solveRisk(
        input({
          entryCheck: "20.001",
          funds: { ...funds, slippageOut: "0.001" },
        }),
      ),
    ).toMatchObject({ entry: "20.01", stopExec: "19.49" });
    expect(solveRisk(input({ ask: "20.4" })).entry).toBe("20.4");
    expect(
      solveRisk(
        input({ entryCheck: "20.5", funds: { ...funds, slippageIn: "0.001" } }),
      ).reasons,
    ).toContain("ENTRY_OUTSIDE_RANGE");
    expect(
      solveRisk(input({ funds: { ...funds, slippageOut: "20" } })).reasons,
    ).toContain("INVALID_EXECUTION_PRICES");
  });
  it("supports minimum + per-share + notional monotone cost schedules", () => {
    const result = solveRisk(
      input({
        funds: { ...funds, maxWeight: "1" },
        feeSchedule: {
          currency: "USD",
          version: "test-v1",
          confirmed: true,
          buy: { minimum: "1", perShare: "0.01", notionalRate: "0.001" },
          sell: { minimum: "1" },
        },
      }),
    );
    expect(result.quantity).toBe(92);
    expect(result.buyFee).toBe("2.76");
    expect(result.riskBase).toBe("49.76");
  });
  it("uses every reservation constraint, with deficits never clamped into permission", () => {
    expect(
      solveRisk(
        input({
          reservations: { cash: "0", riskBase: "50", exposureBase: "0" },
        }),
      ).reasons,
    ).toContain("RISK_POOL_LIMIT");
    expect(
      solveRisk(
        input({
          reservations: { cash: "0", riskBase: "0", exposureBase: "2000" },
        }),
      ).reasons,
    ).toContain("EXPOSURE_LIMIT");
    expect(
      solveRisk(
        input({ funds: { ...funds, existing: { [instrument.id]: "1990" } } }),
      ).quantity,
    ).toBe(0);
  });
  it("never treats zero budget or malformed numeric values as successful inputs", () => {
    for (const nav of ["NaN", "1e5", "-1", "0"])
      expect(solveRisk(input({ funds: { ...funds, nav } })).passed).toBe(false);
    expect(
      solveRisk(input({ instrument: { ...instrument, qStep: 0 } })).passed,
    ).toBe(false);
    expect(
      solveRisk(input({ instrument: { ...instrument, rulesVerified: false } }))
        .passed,
    ).toBe(false);
    expect(
      solveRisk(input({ entryCheck: 20 as unknown as string })).passed,
    ).toBe(false);
  });
  it("properties: all four limits hold, legal q, approval cap, and no feasible next q", () => {
    fc.assert(
      fc.property(
        fc.record({
          budget: fc.integer({ min: 1, max: 1000 }),
          cash: fc.integer({ min: 1, max: 100000 }),
          qMin: fc.integer({ min: 1, max: 200 }),
          qStep: fc.integer({ min: 1, max: 100 }),
          cap: fc.integer({ min: 0, max: 1000 }),
          fee: fc.integer({ min: 0, max: 10 }),
        }),
        ({ budget, cash, qMin, qStep, cap, fee }) => {
          const result = solveRisk(
            input({
              instrument: { ...instrument, qMin, qStep },
              funds: {
                ...funds,
                riskBudget: budget.toString(),
                riskPool: budget.toString(),
                cash: { USD: cash.toString(), CNY: "0" },
                buyFee: fee.toString(),
                sellFee: fee.toString(),
              },
              approvedQuantity: cap,
            }),
          );
          if (result.passed) {
            expect((result.quantity - qMin) % qStep).toBe(0);
            expect(result.quantity).toBeGreaterThanOrEqual(qMin);
            expect(result.quantity).toBeLessThanOrEqual(cap);
            expect(Object.values(result.checks!).every((c) => c.passed)).toBe(
              true,
            );
            expect(result.nextQuantityFeasible).toBe(false);
            expect(new D(result.riskBase).lte(budget.toString())).toBe(true);
            expect(new D(result.cashUse).lte(cash.toString())).toBe(true);
          } else expect(result.quantity).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
