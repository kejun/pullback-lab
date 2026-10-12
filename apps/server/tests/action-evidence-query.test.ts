import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PullbackApp } from "../app.js";
import { demoInstruments } from "../../../packages/market-data/fixtures.js";
import {
  actionTestManifest,
  ACTION_TEST_NOW,
} from "../../../packages/market-data/action-evidence-fixture.js";
import { evidenceHash } from "../../../packages/market-data/action-evidence.js";
import type {
  EvidenceDetail,
  EvidenceHistory,
} from "../../../packages/contracts/action-evidence.js";
import { universeRevision } from "../universe-service.js";

const apps: PullbackApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const app = await createApp({ password: "evidence-query-test" });
  apps.push(app);
  for (const instrument of demoInstruments)
    app.store.putInstrument({
      instrument,
      tags: [],
      note: "synthetic",
      manual: false,
    });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "evidence-query-test" },
  });
  const headers = {
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
    "x-requested-with": "PullbackLab",
  };
  const base = "/api/instruments/DEMO-US-A/action-evidence";
  const read = (suffix = "", prefix = base) =>
    app.inject({ url: `${prefix}${suffix}`, headers });
  return { app, headers, read, base };
}

describe("private read-only evidence workbench", () => {
  it("requires authentication for list, detail and documents; known empty instruments stay unknown", async () => {
    const { app, read, base } = await setup();
    const m = actionTestManifest(),
      v = app.store.importActionEvidence(m, ACTION_TEST_NOW).version;
    for (const suffix of ["", `/${v}`, `/${v}/documents/doc`]) {
      const response = await app.inject(`${base}${suffix}`);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("synthetic-fixture");
    }
    const empty = await read("", "/api/instruments/DEMO-US-B/action-evidence");
    expect(empty.json()).toMatchObject({
      versions: [],
      nextBefore: null,
      liveEligible: false,
    });
    expect(
      (await read("", "/api/instruments/missing/action-evidence")).statusCode,
    ).toBe(404);
  });
  it("bounds history without loading document content, keeps stable pages across new imports and orders equal timestamps by sequence", async () => {
    const { app, read } = await setup();
    const m = actionTestManifest();
    m.documents[0].content = "X".repeat(500_000);
    m.documents[0].sha256 = evidenceHash(m.documents[0].content);
    const versions: string[] = [];
    for (let i = 0; i < 23; i++) {
      m.source = `synthetic-${i}`;
      m.actions[0].revision = i + 1;
      const result = app.store.importActionEvidence(m, ACTION_TEST_NOW);
      versions.push(result.version);
      m.expectedVersion = result.version;
    }
    const response = await read();
    const page = response.json<EvidenceHistory>();
    expect(page.versions.map((v) => v.version)).toEqual(
      versions.slice(3).reverse(),
    );
    expect(response.body.length).toBeLessThan(20_000);
    expect(response.body).not.toContain("XXXXX");
    expect(response.headers["cache-control"]).toBe("no-store");
    m.source = "concurrent-new-version";
    m.actions[0].revision++;
    app.store.importActionEvidence(m, ACTION_TEST_NOW);
    const older = (
      await read(`?before=${page.nextBefore}`)
    ).json<EvidenceHistory>();
    expect(older.versions.map((v) => v.version)).toEqual(
      versions.slice(0, 3).reverse(),
    );
    expect(older.nextBefore).toBeNull();
  });
  it.each([
    "?before=-1",
    "?before=0",
    "?before=1.1",
    "?before=1e3",
    "?before=9007199254740992",
    "?before=1&before=2",
    "?limit=100000",
  ])("rejects invalid pagination %s", async (suffix) => {
    const { read } = await setup();
    expect((await read(suffix)).statusCode).toBe(400);
  });
  it("compares the exact predecessor for corrections, additions, removals and source changes without exposing document bodies", async () => {
    const { app, read } = await setup();
    const m = actionTestManifest(),
      v1 = app.store.importActionEvidence(m, ACTION_TEST_NOW).version;
    m.expectedVersion = v1;
    m.actions[0].revision = 2;
    m.actions[0].sharesAfter = "3";
    const v2 = app.store.importActionEvidence(m, ACTION_TEST_NOW).version;
    m.expectedVersion = v2;
    m.coverage.status = "UNKNOWN";
    m.source = "corrected-source";
    m.review.reviewer = "second-reviewer";
    m.removedActionIds = ["split"];
    m.actions = [
      {
        id: "cash",
        revision: 1,
        kind: "CASH_DIVIDEND",
        effectiveAt: 2_000_000,
        publishedAt: 1_500_000,
        documentIds: ["doc"],
      },
    ];
    m.documents[0].content =
      "<script>document.body.remove()</script> synthetic raw text";
    m.documents[0].sha256 = evidenceHash(m.documents[0].content);
    const v3 = app.store.importActionEvidence(m, ACTION_TEST_NOW).version;
    const old = (await read(`/${v1}`)).json<EvidenceDetail>();
    expect(old).toMatchObject({
      currentVersion: v3,
      comparison: null,
      actions: [{ sharesAfter: "2" }],
      liveEligible: false,
    });
    const correction = (await read(`/${v2}`)).json<EvidenceDetail>();
    expect(correction.comparison).toMatchObject({
      previous: { version: v1 },
      actions: [
        {
          id: "split",
          before: { revision: 1, sharesAfter: "2" },
          after: { revision: 2, sharesAfter: "3" },
        },
      ],
    });
    const response = await read(`/${v3}`),
      detail = response.json<EvidenceDetail>();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("document.body.remove");
    expect(detail.comparison).toMatchObject({
      previous: { version: v2 },
      sourceChanged: true,
      coverageChanged: true,
      reviewChanged: true,
      actions: [
        { id: "cash", before: null, after: { kind: "CASH_DIVIDEND" } },
        { id: "split", before: { revision: 2 }, after: null },
      ],
      documents: [
        {
          id: "doc",
          before: {
            sha256: evidenceHash(actionTestManifest().documents[0].content),
          },
          after: { sha256: m.documents[0].sha256 },
        },
      ],
    });
    const doc = await read(`/${v3}/documents/doc`);
    expect(doc.headers["cache-control"]).toBe("no-store");
    expect(doc.headers["content-type"]).toContain("application/json");
    expect(doc.json()).toMatchObject({
      version: v3,
      content: m.documents[0].content,
    });
    expect((await read(`/${v1}/documents/doc`)).json().content).toBe(
      actionTestManifest().documents[0].content,
    );
  });
  it("scopes versions and documents to their instrument and rejects forged identifiers", async () => {
    const { app, read } = await setup();
    const v = app.store.importActionEvidence(
      actionTestManifest(),
      ACTION_TEST_NOW,
    ).version;
    for (const suffix of [`/${v}`, `/${v}/documents/doc`])
      expect(
        (await read(suffix, "/api/instruments/DEMO-US-B/action-evidence"))
          .statusCode,
      ).toBe(404);
    expect((await read(`/${v}/documents/missing`)).statusCode).toBe(404);
    expect((await read("/garbage")).statusCode).toBe(400);
    expect(
      (await read(`/action-evidence-v1:${"f".repeat(64)}`)).statusCode,
    ).toBe(404);
  });
  it("all reads have zero database writes and deletion preserves evidence and universe revision with a clear conflict", async () => {
    const { app, read, base, headers } = await setup();
    const v = app.store.importActionEvidence(
      actionTestManifest(),
      ACTION_TEST_NOW,
    ).version;
    const revision = universeRevision(app.store);
    const before = app.store.db.prepare("SELECT total_changes() n").get();
    for (const suffix of ["", `/${v}`, `/${v}/documents/doc`])
      expect((await read(suffix)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: actionTestManifest(),
        })
      ).statusCode,
    ).toBe(404);
    const deletion = await app.inject({
      method: "DELETE",
      url: "/api/universe/DEMO-US-A",
      headers,
      payload: { expectedRevision: revision },
    });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json().code).toBe("INSTRUMENT_HAS_ACTION_EVIDENCE");
    expect(universeRevision(app.store)).toBe(revision);
    expect(app.store.db.prepare("SELECT total_changes() n").get()).toEqual(
      before,
    );
    expect((await read(`/${v}`)).statusCode).toBe(200);
  });
});
