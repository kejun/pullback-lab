import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/contracts/index";
import {
  MonitorReadFence,
  formalMonitorControls,
  monitorCommandBody,
  type MonitorSnapshot,
} from "../apps/web/src/formal-monitor-state";

const plan = {
  id: "p",
  version: 2,
  instrumentId: "US-A",
  status: "DRAFT",
  attemptId: null,
  mode: "CLOSE_CONFIRM",
  backgroundConfirmed: true,
  reason: "manual evidence",
  supportSnapshot: { ready: true, providerContextId: "server-context" },
} as Plan;
const snapshot: MonitorSnapshot = {
  availability: {
    configured: true,
    connected: true,
    liveEligible: true,
    reason: "SERVER_ADAPTER_CONNECTED",
    instruments: [{ instrumentId: "US-A", liveEligible: true, reason: null }],
  },
  progress: null,
};
const progress: NonNullable<MonitorSnapshot["progress"]> = {
  attemptId: "a",
  planVersion: 2,
  phase: "DATA_PAUSED",
  status: "DATA_PAUSED",
  reason: "MISSING_MINUTE",
  template: "SESSION_FIRST",
  sourceAttemptId: null,
  activatedAt: 1,
  watermark: 123,
  deadline: 1000,
  deadlineWatermark: null,
  inputCount: 2,
  current: true,
  synthetic: false,
};
describe("formal monitor controls", () => {
  it("requires a successful server status read", () =>
    expect(formalMonitorControls(plan, null).canActivate).toBe(false));
  it("opens only the exact server-eligible instrument", () => {
    expect(formalMonitorControls(plan, snapshot).canActivate).toBe(true);
    expect(
      formalMonitorControls({ ...plan, instrumentId: "US-B" }, snapshot)
        .canActivate,
    ).toBe(false);
  });
  it.each(["configured", "connected", "instrument"])(
    "fails closed on unavailable %s",
    (kind) => {
      const blocked = structuredClone(snapshot);
      if (kind === "instrument")
        blocked.availability.instruments[0].liveEligible = false;
      else blocked.availability[kind as "configured" | "connected"] = false;
      expect(formalMonitorControls(plan, blocked).canActivate).toBe(false);
    },
  );
  it("never promotes manual histories, unsupported modes, or missing provider evidence", () => {
    for (const input of [
      { ...plan, researchHistoryId: "manual" },
      { ...plan, mode: "INTRABAR_CROSS" as const },
      { ...plan, supportSnapshot: undefined },
    ])
      expect(formalMonitorControls(input, snapshot).canActivate).toBe(false);
  });
  it("never activates an existing attempt as session-first", () => {
    expect(
      formalMonitorControls({ ...plan, attemptId: "a" }, snapshot).canActivate,
    ).toBe(false);
    expect(
      formalMonitorControls(plan, { ...snapshot, progress }).canActivate,
    ).toBe(false);
  });
  it("allows explicit recovery across versions without impersonating current identity", () => {
    expect(
      formalMonitorControls(
        { ...plan, version: 3 },
        { ...snapshot, progress: { ...progress, current: false } },
      ).canRecover,
    ).toBe(true);
    expect(
      formalMonitorControls(
        { ...plan, version: 3, attemptId: "different", status: "DATA_PAUSED" },
        { ...snapshot, progress },
      ).canRecover,
    ).toBe(false);
  });
  it("cannot recover consumed, invalid, or expired attempts", () => {
    for (const status of [
      "ENTRY_TRIGGERED",
      "TRIGGERED",
      "TAKEN",
      "SKIPPED",
      "INVALID",
      "EXPIRED",
    ])
      expect(
        formalMonitorControls(plan, {
          ...snapshot,
          progress: { ...progress, status: status as typeof progress.status },
        }).canRecover,
      ).toBe(false);
  });
  it("permits stopping an existing attempt after capability loss", () => {
    expect(
      formalMonitorControls(
        { ...plan, status: "DATA_PAUSED", attemptId: "a" },
        {
          ...snapshot,
          availability: { ...snapshot.availability, connected: false },
          progress,
        },
      ).canPause,
    ).toBe(true);
  });
  it("sends only plan/attempt CAS and recovery source/watermark, never client authority", () => {
    expect(
      monitorCommandBody(plan, { ...snapshot, progress }, "recover"),
    ).toEqual({
      expectedVersion: 2,
      expectedAttemptId: null,
      sourceAttemptId: "a",
      expectedWatermark: 123,
    });
    expect(monitorCommandBody(plan, snapshot, "activate")).toEqual({
      expectedVersion: 2,
      expectedAttemptId: null,
    });
  });
});

describe("monitor read lifecycle", () => {
  it("releases the read lock on StrictMode setup-cleanup-setup and isolates late results", () => {
    const reads = new MonitorReadFence();
    const first = reads.begin()!;
    expect(reads.begin()).toBeNull();
    reads.cancel();
    const remounted = reads.begin()!;
    expect(remounted).not.toBeNull();
    expect(reads.current(first)).toBe(false);
    expect(reads.finish(first)).toBe(false);
    expect(reads.begin()).toBeNull();
    expect(reads.finish(remounted)).toBe(true);
    expect(reads.begin()).not.toBeNull();
  });
});
