import { prepareLongbridgeHistoryCandidates } from "../longbridge-history-input.js";
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEodResearchContext,
  installEodResearch,
  trustedDailyResearch,
} from "../eod-research.js";
import { eodFixture } from "./eod-research-fixture.js";
import { Store } from "../store.js";
import { createApp } from "../app.js";
import { ScreeningService } from "../screening-service.js";
import {
  trustedClosedSupport,
  validateClosedContext,
} from "../closed-bar-adapter.js";
import { prepareProductionResearch } from "../production-research.js";
import { ActionEvidenceRepository } from "../../../packages/market-data/action-evidence.js";
import { actionTestManifest } from "../../../packages/market-data/action-evidence-fixture.js";
function seed(store: Store, input: ReturnType<typeof eodFixture>["input"]) {
  store.putInstrument({
    instrument: input.review.history.instrument,
    manual: false,
    tags: [],
    note: "isolated EOD fixture",
  });
}
describe("independent audited EOD research", () => {
  it.each(["US", "CN"] as const)(
    "installs %s complete daily research with realtime/clock/region unknown, but cannot validate as live",
    (market) => {
      const { input, now, instrument } = eodFixture(market),
        c = buildEodResearchContext(input, now),
        store = new Store();
      try {
        seed(store, input);
        installEodResearch(store, [input], now);
        store.confirmScreening(undefined, 0, now);
        expect(c.basisDate).toBe("2026-10-09");
        expect(c.daily.length).toBeGreaterThan(250);
        expect(c.capability.realtimeEntitlementVerified).toBe(false);
        expect(() => validateClosedContext(c, now)).toThrow(
          "LIVE_CAPABILITY_UNVERIFIED",
        );
        expect(
          trustedClosedSupport(store.db, instrument, c.daily, now),
        ).toBeNull();
        expect(
          trustedDailyResearch(store.db, instrument, c.daily, now)?.id,
        ).toBe(c.id);
        expect(
          new ScreeningService(store).candidates(now).candidates[0],
        ).toMatchObject({ origin: "PROVIDER", health: { state: "VERIFIED" } });
        expect((c.daily[0] as any).raw.providerOrigin).toMatchObject({
          captureHash: c.captureHash,
          rawVolume: "1000",
          rawVolumeUnit: "UNVERIFIED",
        });
        expect(
          store.db.prepare("SELECT count(*) n FROM closed_sources").get(),
        ).toEqual({ n: 0 });
      } finally {
        store.close();
      }
    },
  );
  it("converts only the reviewed historical endpoint LOT unit exactly once and preserves turnover and raw units", () => {
    const { input, now } = eodFixture("CN");
    input.review.endpoint.volumeUnit = "LOT";
    input.review.endpoint.sharesPerLot = 100;
    const c = buildEodResearchContext(input, now);
    expect(c.daily[0]).toMatchObject({ volume: "100000", turnover: "100500" });
    expect((c.daily[0] as any).raw.providerOrigin).toMatchObject({
      rawVolume: "1000",
      sharesPerLot: 100,
      reviewedVolumeUnit: "LOT",
    });
  });
  it.each([
    "apiEntitlementVerified",
    "historicalReadVerified",
    "unitsVerified",
    "calendarVerified",
    "finalityContractVerified",
  ] as const)(
    "rejects unknown historical %s even if capture says SAMPLED",
    (key) => {
      const { input, now } = eodFixture();
      input.review.history.capability[key] = false;
      expect(() => buildEodResearchContext(input, now)).toThrow();
    },
  );
  it("rejects expiration, a future review or data received after the review", () => {
    for (const kind of ["expired", "future", "early-review"]) {
      const { input, now } = eodFixture();
      if (kind === "expired")
        input.review.history.capability.validUntil = now - 1;
      else
        input.review.history.capability.checkedAt =
          kind === "future" ? now + 1 : now - 1001;
      expect(() => buildEodResearchContext(input, now)).toThrow();
    }
  });
  it("rejects missing days, unknown calendar hours, mismatched scope and duplicate source samples", () => {
    for (const kind of ["bar", "calendar", "scope", "duplicate", "half"]) {
      const { input, now, capture } = eodFixture();
      if (kind === "bar") capture.pages[0].samples.pop();
      if (kind === "calendar") input.review.history.calendarDays = [];
      if (kind === "scope")
        input.review.history.historyStartDate = "2025-10-02";
      if (kind === "duplicate")
        capture.pages[0].samples.push({ ...capture.pages[0].samples[0] });
      if (kind === "half") input.review.halfTradingDates = [];
      input.review.expectedCaptureHash = prepareLongbridgeHistoryCandidates(
        capture,
        input.review.history.instrument,
      ).captureHash;
      expect(() => buildEodResearchContext(input, now)).toThrow();
    }
  });
  it("invalidates cached screening on expiry, changed instrument or data hashes, never falling back to old qualification", () => {
    const { input, now, instrument } = eodFixture(),
      store = new Store();
    try {
      seed(store, input);
      installEodResearch(store, [input], now);
      store.confirmScreening(undefined, 0, now);
      const screening = new ScreeningService(store);
      expect(screening.candidates(now).candidates[0].health.state).toBe(
        "VERIFIED",
      );
      expect(
        screening.candidates(now + 86400001).candidates[0].health.state,
      ).toBe("UNKNOWN");
      expect(trustedDailyResearch(store.db, instrument, [], now)).toBeNull();
      expect(
        trustedDailyResearch(
          store.db,
          { ...instrument, tick: "0.02" },
          store.bars(instrument.id, "1D"),
          now,
        ),
      ).toBeNull();
    } finally {
      store.close();
    }
  });
  it("revokes with no active plan, rejects restart of old binding even on clock rollback, and permits a new explicit review", () => {
    const { input, now, instrument } = eodFixture(),
      store = new Store();
    try {
      seed(store, input);
      installEodResearch(store, [input], now);
      const repository = new ActionEvidenceRepository(store.db),
        manifest = actionTestManifest();
      manifest.instrumentId = instrument.id;
      manifest.coverage.from = 0;
      manifest.coverage.through = now;
      const result = store.importActionEvidence(manifest, now);
      expect(
        store.db.prepare("SELECT count(*) n FROM eod_sources").get(),
      ).toEqual({ n: 0 });
      expect(() => installEodResearch(store, [input], now)).toThrow(
        "CORPORATE_ACTION_CONTEXT_REVOKED",
      );
      expect(() => installEodResearch(store, [input], now - 1)).toThrow();
      input.review.history.actionEvidenceVersion = result.version;
      input.review.history.adjustments = repository.dataset(
        instrument.id,
        now,
        result.version,
      )!;
      input.review.history.capability.checkedAt = now;
      expect(() => installEodResearch(store, [input], now)).not.toThrow();
    } finally {
      store.close();
    }
  });
  it("rolls back installation and immutable provenance on an injected source insertion failure", () => {
    const { input, now } = eodFixture(),
      store = new Store();
    try {
      seed(store, input);
      store.db.exec(
        "CREATE TRIGGER fail_eod BEFORE INSERT ON eod_sources BEGIN SELECT RAISE(ABORT,'injected'); END;",
      );
      expect(() => installEodResearch(store, [input], now)).toThrow();
      expect(
        store.db.prepare("SELECT count(*) n FROM eod_contexts").get(),
      ).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });
  it("is default-off and refuses an env switch without reviewed input, with no SDK connection", () => {
    expect(prepareProductionResearch(undefined, {}).report).toMatchObject({
      mode: "off",
      configured: false,
      liveEnabled: false,
    });
    expect(() =>
      prepareProductionResearch(undefined, {
        PULLBACK_RESEARCH_MODE: "longbridge-eod",
      }),
    ).toThrow("AUDITED_RESEARCH_CONFIGURATION_REQUIRED");
  });
  it("wires the actual authenticated chart/candidates while monitor remains disabled; reboot without config removes trust", async () => {
    const { input, now, instrument } = eodFixture(),
      dir = mkdtempSync(join(tmpdir(), "eod-app-")),
      path = join(dir, "data.sqlite");
    const store = new Store(path);
    seed(store, input);
    store.close();
    let app = await createApp({
      databasePath: path,
      password: "eod-test-password",
      eodResearch: [input],
      now: () => now,
    });
    try {
      app.store.confirmScreening(undefined, 0, now);
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-requested-with": "PullbackLab" },
        payload: { password: "eod-test-password" },
      });
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const chart = (
        await app.inject({
          url: `/api/instruments/${instrument.id}/bars?anchorTime=${app.store.bars(instrument.id, "1D")[0].time}`,
          headers: { cookie },
        })
      ).json();
      expect(chart.providerContext).toMatchObject({
        id: expect.stringMatching(/^eod-context:/),
        researchOnly: true,
      });
      expect(chart.avwap.at(-1)).not.toBeNull();
      expect(app.monitor.availability().liveEligible).toBe(false);
      await app.monitor.start();
      expect(app.monitor.availability().liveEligible).toBe(false);
      await app.close();
      app = await createApp({
        databasePath: path,
        password: "eod-test-password",
        now: () => now,
      });
      expect(
        app.store.db.prepare("SELECT count(*) n FROM eod_sources").get(),
      ).toEqual({ n: 0 });
      expect(
        app.store.db.prepare("SELECT count(*) n FROM eod_contexts").get(),
      ).toEqual({ n: 1 });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EOD integrity and persistence regressions", () => {
  it.each(["0.5", "9007199254740992", "123456789012345678901234567890"])(
    "rejects native SDK volume outside the audited integer transport: %s",
    (volume) => {
      const { input, now, capture } = eodFixture();
      capture.pages[0].samples[0].volume = volume;
      input.review.expectedCaptureHash = prepareLongbridgeHistoryCandidates(
        capture,
        input.review.history.instrument,
      ).captureHash;
      expect(() => buildEodResearchContext(input, now)).toThrow(
        "EOD_CAPTURE_VOLUME_INVALID",
      );
    },
  );
  it("rejects an explicitly rebound context which omits a currently known relevant company action", () => {
    const { input, now, instrument } = eodFixture(),
      store = new Store();
    try {
      seed(store, input);
      const manifest = actionTestManifest();
      manifest.instrumentId = instrument.id;
      manifest.actions[0].effectiveAt = Date.parse("2025-10-02T13:30:00Z");
      manifest.coverage.through = now;
      const imported = store.importActionEvidence(manifest, now);
      input.review.history.actionEvidenceVersion = imported.version;
      input.review.history.capability.checkedAt = now;
      expect(() => installEodResearch(store, [input], now)).toThrow(
        "HISTORY_ACTION_BINDING_MISMATCH",
      );
    } finally {
      store.close();
    }
  });
  it("cannot turn raw upload-like assertions into a trusted capture", () => {
    const { input, now, capture } = eodFixture();
    (capture as any).capability = "COMPLETE";
    (capture as any).verified = true;
    expect(() => buildEodResearchContext(input, now)).toThrow(
      "HISTORY_CAPTURE_INVALID",
    );
  });
  it("preserves nonempty immutable EOD history through backup/restore without activating a live stream", async () => {
    const { backupDatabase, restoreDatabase } =
      await import("../backup-service.js");
    const { input, now } = eodFixture(),
      dir = mkdtempSync(join(tmpdir(), "eod-backup-")),
      path = join(dir, "source.sqlite"),
      copy = join(dir, "copy.sqlite"),
      target = join(dir, "restored.sqlite");
    const store = new Store(path);
    let restored: Store | undefined;
    try {
      seed(store, input);
      installEodResearch(store, [input], now);
      const original = store.db.prepare("SELECT * FROM eod_contexts").all();
      expect(await backupDatabase(path, copy)).toEqual({ schemaVersion: 13 });
      expect(await restoreDatabase(copy, target)).toEqual({
        schemaVersion: 13,
      });
      restored = new Store(target);
      expect(restored.db.prepare("SELECT * FROM eod_contexts").all()).toEqual(
        original,
      );
      expect(() =>
        restored!.db.prepare("UPDATE eod_contexts SET json='{}'").run(),
      ).toThrow("EOD_EVIDENCE_IMMUTABLE");
      expect(
        restored.db.prepare("SELECT count(*) n FROM closed_streams").get(),
      ).toEqual({ n: 0 });
      expect(store.db.prepare("SELECT * FROM eod_contexts").all()).toEqual(
        original,
      );
    } finally {
      restored?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("binds a review to exact raw capture content: OHLC, calendars and receipts cannot silently inherit approval", () => {
  for (const change of ["ohlc", "calendar", "receipt"]) {
    const { input, now, capture } = eodFixture();
    if (change === "ohlc") capture.pages[0].samples[0].close = "102";
    if (change === "calendar") capture.calendarPages[0].tradingDays.reverse();
    if (change === "receipt") capture.pages[0].samples[0].receivedAt--;
    expect(() => buildEodResearchContext(input, now)).toThrow(
      "EOD_CAPTURE_REVIEW_MISMATCH",
    );
  }
  const { input, now, capture } = eodFixture();
  const prior = buildEodResearchContext(input, now);
  capture.pages[0].samples[0].close = "102";
  // Explicit new isolated review, not something startup is allowed to do automatically.
  input.review.expectedCaptureHash = prepareLongbridgeHistoryCandidates(
    capture,
    input.review.history.instrument,
  ).captureHash;
  input.review.endpoint.evidenceId = "isolated-rereview-changed-capture";
  const reviewed = buildEodResearchContext(input, now);
  expect(reviewed.id).not.toBe(prior.id);
  expect(reviewed.captureHash).not.toBe(prior.captureHash);
});
