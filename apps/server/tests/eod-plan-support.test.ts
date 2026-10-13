import { describe, expect, it } from "vitest";
import type {
  PlanInput,
  SupportSnapshot,
} from "../../../packages/contracts/index.js";
import { avwap } from "../../../packages/domain/indicators.js";
import { Store } from "../store.js";
import { createApp } from "../app.js";
import {
  buildEodResearchContext,
  installEodResearch,
} from "../eod-research.js";
import { eodFixture } from "./eod-research-fixture.js";
import { planInput } from "./closed-bar-fixture.js";
import { actionTestManifest } from "../../../packages/market-data/action-evidence-fixture.js";
function fixture(market: "US" | "CN" = "US") {
  const f = eodFixture(market),
    store = new Store();
  store.putInstrument({
    instrument: f.instrument,
    manual: false,
    tags: [],
    note: "isolated EOD plan fixture",
  });
  installEodResearch(store, [f.input], f.now);
  const daily = store.bars(f.instrument.id, "1D");
  const input: PlanInput = {
    ...planInput,
    instrumentId: f.instrument.id,
    sessionDate: "2026-10-12",
    primarySupport: "101",
    lower: "100.75",
    upper: "101.25",
    stop: "100.4",
    entryMin: "101.61",
    entryMax: "102.5",
    anchorTime: daily[10].time,
    supportSelections: [{ source: "EMA9" }, { source: "AVWAP" }],
  };
  return { ...f, store, daily, plan: input };
}
describe("audited EOD evidence in research plan support", () => {
  it.each(["US", "CN"] as const)(
    "computes %s AVWAP from the chart's audited daily series while freezing a research-only draft",
    (market) => {
      const f = fixture(market);
      try {
        const preview = f.store.supportPreview(
          f.plan,
          f.now,
          f.plan.reason,
          f.plan.sessionDate,
        );
        expect(
          preview.lines.find((line) => line.source === "AVWAP")?.price,
        ).toBe(avwap(f.daily, 10).at(-1));
        expect(preview.reasons).not.toContain("DAILY_HISTORY_INCOMPLETE");
        expect(preview.reasons).not.toContain("ADJUSTMENT_EVIDENCE_UNVERIFIED");
        expect(preview).toMatchObject({
          ready: false,
          status: "INCOMPLETE",
          researchContextId: expect.stringMatching(/^eod-context:/),
          reasons: expect.arrayContaining(["EOD_RESEARCH_ONLY"]),
        });
        expect(preview.providerContextId).toBeUndefined();
        const saved = f.store.createPlan(f.plan, f.now);
        expect(saved).toMatchObject({
          status: "DRAFT",
          attemptId: null,
          approvedQuantity: 0,
          supportSnapshot: preview,
        });
        expect(f.store.planVersion(saved).supportSnapshot).toEqual(preview);
        expect(f.store.supportRevisionReasons(saved, f.now)).toEqual([]);
      } finally {
        f.store.close();
      }
    },
  );
  it("validates the full installed evidence but computes only completed daily bars before the plan date", () => {
    const f = fixture();
    try {
      const date = "2026-10-09",
        eligible = f.daily.filter(
          (b) => new Date(b.time * 1000).toISOString().slice(0, 10) < date,
        );
      const preview = f.store.supportPreview(f.plan, f.now, "", date);
      expect(preview.researchContextId).toMatch(/^eod-context:/);
      expect(preview.reference.previousDailyTime).toBe(eligible.at(-1)!.time);
      expect(preview.lines.find((l) => l.source === "AVWAP")?.price).toBe(
        avwap(eligible, 10).at(-1),
      );
      const excludedAnchor = f.store.supportPreview(
        { ...f.plan, anchorTime: f.daily.at(-1)!.time },
        f.now,
        "",
        date,
      );
      expect(
        excludedAnchor.lines.find((l) => l.source === "AVWAP")?.price,
      ).toBeNull();
      expect(excludedAnchor.reasons).toContain("AVWAP_NOT_READY");
    } finally {
      f.store.close();
    }
  });
  it.each(["expired", "removed", "instrument", "actions"] as const)(
    "invalidates research support on %s without rewriting the old plan snapshot",
    (kind) => {
      const f = fixture();
      try {
        const saved = f.store.createPlan(f.plan, f.now),
          original = structuredClone(saved.supportSnapshot);
        let now = f.now;
        if (kind === "expired")
          now = f.input.review.history.capability.validUntil + 1;
        if (kind === "removed") installEodResearch(f.store, [], now);
        if (kind === "instrument")
          f.store.putInstrument({
            ...f.store.instrument(f.instrument.id),
            instrument: { ...f.instrument, tick: "0.02" },
          });
        if (kind === "actions") {
          const manifest = actionTestManifest();
          manifest.instrumentId = f.instrument.id;
          manifest.coverage.from = 0;
          manifest.coverage.through = now;
          f.store.importActionEvidence(manifest, now);
        }
        const preview = f.store.supportPreview(
          f.plan,
          now,
          "",
          f.plan.sessionDate,
        );
        expect(preview.researchContextId).toBeUndefined();
        expect(preview.providerContextId).toBeUndefined();
        expect(
          preview.lines.find((l) => l.source === "AVWAP")?.price,
        ).toBeNull();
        expect(preview.reasons).toContain("DAILY_HISTORY_INCOMPLETE");
        expect(f.store.supportRevisionReasons(saved, now)).toContain(
          "RESEARCH_CONTEXT_REVISION_CHANGED",
        );
        expect(f.store.planVersion(saved).supportSnapshot).toEqual(original);
      } finally {
        f.store.close();
      }
    },
  );
  it("requires a new explicit plan version after a different reviewed EOD context is installed", () => {
    const f = fixture();
    try {
      const saved = f.store.createPlan(f.plan, f.now);
      f.input.review.history.capability.checkedAt = f.now + 1;
      installEodResearch(f.store, [f.input], f.now + 1);
      expect(f.store.supportRevisionReasons(saved, f.now + 1)).toContain(
        "RESEARCH_CONTEXT_REVISION_CHANGED",
      );
      const preview = f.store.supportPreview(
        f.plan,
        f.now + 1,
        "",
        f.plan.sessionDate,
      );
      expect(preview.researchContextId).not.toBe(
        saved.supportSnapshot!.researchContextId,
      );
      expect(preview.ready).toBe(false);
      expect(preview.researchContextId).toBe(
        buildEodResearchContext(f.input, f.now + 1).id,
      );
    } finally {
      f.store.close();
    }
  });
  it("wires authenticated chart/preview/save but still refuses activate and recover without a live adapter", async () => {
    const f = fixture();
    f.store.close();
    const app = await createApp({
      password: "isolated-eod-support",
      now: () => f.now,
    });
    try {
      app.store.putInstrument({
        instrument: f.instrument,
        manual: false,
        tags: [],
        note: "isolated EOD plan fixture",
      });
      installEodResearch(app.store, [f.input], f.now);
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-requested-with": "PullbackLab" },
        payload: { password: "isolated-eod-support" },
      });
      const headers = {
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-requested-with": "PullbackLab",
      };
      const chart = (
        await app.inject({
          url: `/api/instruments/${f.instrument.id}/bars?anchorTime=${f.plan.anchorTime}`,
          headers,
        })
      ).json();
      const previewResponse = await app.inject({
        method: "POST",
        url: "/api/plans/support-preview",
        headers,
        payload: {
          instrumentId: f.plan.instrumentId,
          anchorTime: f.plan.anchorTime,
          primarySupport: f.plan.primarySupport,
          supportSelections: f.plan.supportSelections,
          sessionDate: f.plan.sessionDate,
        },
      });
      expect(previewResponse.statusCode).toBe(200);
      const preview = previewResponse.json<SupportSnapshot>();
      expect(preview.lines.find((l) => l.source === "AVWAP")?.price).toBe(
        chart.avwap.at(-1),
      );
      const save = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers,
        payload: {
          ...f.plan,
          supportSnapshot: {
            ready: true,
            providerContextId: "forged-live",
            researchContextId: "forged-research",
          },
        },
      });
      expect(save.statusCode, save.body).toBe(200);
      const saved = save.json();
      expect(saved.status).toBe("DRAFT");
      expect(saved.supportSnapshot.ready).toBe(false);
      expect(saved.supportSnapshot.providerContextId).toBeUndefined();
      expect(saved.supportSnapshot.researchContextId).toBe(
        preview.researchContextId,
      );
      for (const [path, extras] of [
        ["activate", {}],
        [
          "monitor/recover",
          { sourceAttemptId: "not-a-live-attempt", expectedWatermark: 0 },
        ],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/plans/${saved.id}/${path}`,
          headers,
          payload: {
            expectedVersion: saved.version,
            expectedAttemptId: null,
            ...extras,
          },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(app.store.plan(saved.id)).toMatchObject({
        status: "DRAFT",
        attemptId: null,
        approvedQuantity: 0,
      });
      expect(app.monitor.availability().liveEligible).toBe(false);
      expect(app.store.events()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
