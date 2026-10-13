import { afterEach, describe, expect, it } from "vitest";
import { actionTestManifest } from "../../../packages/market-data/action-evidence-fixture.js";
import { ActionEvidenceRepository } from "../../../packages/market-data/action-evidence.js";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { closedHash, trustedClosedSupport } from "../closed-bar-adapter.js";
import { currentActionEvidenceVersion } from "../closed-action-binding.js";
import { ScreeningService } from "../screening-service.js";
import {
  ContractAdapter,
  INSTRUMENT,
  OPEN,
  planInput,
  setupClosed,
} from "./closed-bar-fixture.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function manifest(expectedVersion: string | null = null) {
  const m = actionTestManifest();
  m.instrumentId = INSTRUMENT;
  m.expectedVersion = expectedVersion;
  m.actions = [];
  m.coverage.through = OPEN;
  m.coverage.reason = "isolated revocation test";
  return m;
}
const command = (p: { version: number; attemptId: string | null }) => ({
  expectedVersion: p.version,
  expectedAttemptId: p.attemptId,
});
async function setup(options: Parameters<typeof setupClosed>[0] = {}) {
  const f = await setupClosed(options);
  cleanup.push(f.close);
  return f;
}
describe("persistent per-instrument corporate action revocation", () => {
  it("revokes research and new activation even with no active attempt", async () => {
    const f = await setup({ activate: false });
    const service = new ScreeningService(f.store);
    expect(service.candidates(f.now()).candidates[0].health.state).toBe(
      "VERIFIED",
    );
    f.store.importActionEvidence(manifest(), f.now());
    expect(
      f.store.db.prepare("SELECT COUNT(*) n FROM closed_sources").get(),
    ).toEqual({ n: 0 });
    expect(f.runner.availability()).toMatchObject({
      liveEligible: false,
      instruments: [
        {
          liveEligible: false,
          tickEligible: false,
          reason: "CORPORATE_ACTION_CONTEXT_REVOKED",
        },
      ],
    });
    expect(service.candidates(f.now()).candidates[0].screeningStatus).toBe(
      "UNKNOWN",
    );
    expect(service.candidates(f.now()).cacheHit).toBe(true);
    const p = f.store.createPlan(planInput, f.now());
    expect(p.supportSnapshot?.ready).toBe(false);
    expect(() => f.runner.activate(p.id, command(p))).toThrow();
  });
  it("pauses active plans atomically and blocks recovery and queued opportunities", async () => {
    const f = await setup({ autoDrain: false });
    f.minute(0, { open: "101", high: "101.2", low: "100", close: "100.6" });
    f.minute(1, { open: "100.6", high: "102", low: "100.5", close: "101.5" });
    f.store.importActionEvidence(manifest(), f.now());
    const p = f.store.plan(f.plan.id),
      status = f.runner.status(p.id)!;
    expect(p.status).toBe("DATA_PAUSED");
    expect(() =>
      f.runner.activate(p.id, command(p), {
        sourceAttemptId: status.attemptId,
        expectedWatermark: status.watermark,
      }),
    ).toThrow();
    f.runner.drain();
    f.runner.flush();
    expect(f.store.events().some((e) => e.type === "ENTRY_TRIGGERED")).toBe(
      false,
    );
    expect(
      f.store.db
        .prepare(
          "SELECT COUNT(*) n FROM closed_receipt_results WHERE status='ACTION_CONTEXT_REVOKED'",
        )
        .get(),
    ).toEqual({ n: 4 });
  });
  it("rejects old static context on restart, including clock rollback before the recorded revocation", async () => {
    const f = await setup({ activate: false });
    f.store.importActionEvidence(manifest(), OPEN + 1000);
    await f.runner.stop();
    const restart = new ClosedBarRuntime(f.store, {
      adapter: f.adapter,
      now: () => OPEN - 1,
    });
    try {
      await expect(restart.start()).rejects.toThrow("ADAPTER_START_FAILED");
      expect(f.adapter.sinks).toHaveLength(1);
      expect(
        f.store.db.prepare("SELECT COUNT(*) n FROM closed_sources").get(),
      ).toEqual({ n: 0 });
    } finally {
      await restart.stop();
    }
  });
  it("requires an explicit newly reviewed binding and invalidates again for a same-millisecond newer generation", async () => {
    const f = await setup({ activate: false });
    const first = f.store.importActionEvidence(manifest(), OPEN).version;
    await f.runner.stop();
    const reviewed = new ContractAdapter();
    reviewed.context.actionEvidenceVersion = first;
    reviewed.context.adjustmentEvidenceId = first;
    const newHash = closedHash(reviewed.context);
    expect(newHash).not.toBe(closedHash(f.adapter.context));
    const restart = new ClosedBarRuntime(f.store, {
      adapter: reviewed,
      now: () => OPEN,
    });
    try {
      await restart.start();
      expect(restart.availability().liveEligible).toBe(true);
      const frozen = trustedClosedSupport(
        f.store.db,
        reviewed.context.instrument,
        reviewed.context.daily,
        OPEN,
      );
      expect(frozen?.actionEvidenceVersion).toBe(first);
      const next = manifest(first);
      next.coverage.status = "UNKNOWN";
      const second = f.store.importActionEvidence(next, OPEN).version;
      expect(second).not.toBe(first);
      expect(currentActionEvidenceVersion(f.store.db, INSTRUMENT)).toBe(second);
      expect(
        trustedClosedSupport(
          f.store.db,
          reviewed.context.instrument,
          reviewed.context.daily,
          OPEN - 1,
        ),
      ).toBeNull();
      expect(restart.availability().liveEligible).toBe(false);
    } finally {
      await restart.stop();
    }
  });
  it("rolls back immutable evidence, source revocation and plan state if revocation storage fails", async () => {
    const f = await setup();
    const before = f.store.plan(f.plan.id);
    f.store.db.exec(
      "CREATE TRIGGER fail_revoke BEFORE DELETE ON closed_sources BEGIN SELECT RAISE(ABORT,'INJECTED_REVOCATION_FAILURE'); END",
    );
    expect(() => f.store.importActionEvidence(manifest(), OPEN)).toThrow(
      "INJECTED_REVOCATION_FAILURE",
    );
    expect(
      new ActionEvidenceRepository(f.store.db).latest(INSTRUMENT),
    ).toBeNull();
    expect(f.store.plan(f.plan.id)).toEqual(before);
    expect(
      f.store.db.prepare("SELECT COUNT(*) n FROM closed_sources").get(),
    ).toEqual({ n: 1 });
    expect(f.runner.availability().liveEligible).toBe(true);
  });
  it("duplicate/dry-run evidence does not generate a new revocation", async () => {
    const f = await setup({ activate: false });
    f.store.importActionEvidence(manifest(), OPEN, true);
    expect(currentActionEvidenceVersion(f.store.db, INSTRUMENT)).toBeNull();
    expect(f.runner.availability().liveEligible).toBe(true);
    const first = f.store.importActionEvidence(manifest(), OPEN).version;
    expect(f.store.importActionEvidence(manifest(), OPEN + 1).status).toBe(
      "DUPLICATE",
    );
    expect(currentActionEvidenceVersion(f.store.db, INSTRUMENT)).toBe(first);
  });
});
