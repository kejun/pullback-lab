import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PullbackApp } from "../app.js";
import { RECEIPT_PAYLOAD_MAX_BYTES } from "../provider-receipt-query.js";
import type {
  ProviderReceiptDetail,
  ProviderReceiptPage,
} from "../../../packages/contracts/provider-receipts.js";

const apps: PullbackApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const app = await createApp({ password: "receipt-query-test" });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "receipt-query-test" },
  });
  const headers = {
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
    "x-requested-with": "PullbackLab",
  };
  const base = "/api/instruments/US:TEST.US/provider-receipts";
  app.store.db.exec(
    "INSERT INTO market_worker_epochs(epoch,started_at) VALUES(1,1000)",
  );
  function insert(
    payload: Record<string, unknown> = {},
    meta: {
      id?: string;
      source?: string;
      requested?: string | null;
      raw?: string;
      hash?: string;
    } = {},
  ) {
    const value = {
      symbol: "TEST.US",
      period: "1m",
      timestamp: 1000,
      receivedAt: 2000,
      open: "100",
      high: "102",
      low: "99",
      close: "101",
      volume: "1000",
      ...payload,
    };
    const { receivedAt: _time, ...hashed } = value;
    return Number(
      app.store.db
        .prepare(
          `INSERT INTO market_provider_receipts(epoch,instrument_id,source,received_at,observed_at,provider_timestamp,historical,payload_hash,payload_json,status,reason,requested_period)
      VALUES(1,?,?,?,2000,?,1,?,?,'QUARANTINED','MINUTE_EVIDENCE_UNVERIFIED',?)`,
        )
        .run(
          meta.id ?? "US:TEST.US",
          meta.source ?? "synthetic-provider",
          value.receivedAt,
          value.timestamp,
          meta.hash ??
            createHash("sha256").update(JSON.stringify(hashed)).digest("hex"),
          meta.raw ?? JSON.stringify(value),
          meta.requested === undefined ? "1m" : meta.requested,
        ).lastInsertRowid,
    );
  }
  const read = (query = "period=1m", suffix = "", prefix = base) =>
    app.inject({ url: `${prefix}${suffix}?${query}`, headers });
  const list = async (period = "1m") =>
    (await read(`period=${period}`)).json<ProviderReceiptPage>();
  const detail = async (seq: number, page: ProviderReceiptPage) =>
    (
      await read(
        new URLSearchParams({
          period: page.period,
          snapshot: page.snapshot,
        }).toString(),
        `/${seq}`,
      )
    ).json<ProviderReceiptDetail>();
  return { app, headers, base, insert, read, list, detail };
}

describe("provider receipt archive", () => {
  it("scopes detail lookups even with a valid local checkpoint and validates receipt numbers", async () => {
    const { insert, list, read, detail } = await setup();
    const seq = insert();
    const other = insert({}, { id: "US:OTHER.US" });
    const otherPeriod = insert({}, { requested: "5m" });
    insert();
    const page = await list();
    const query = `period=1m&snapshot=${page.snapshot}`;
    for (const id of [other, otherPeriod])
      expect((await read(query, `/${id}`)).statusCode).toBe(404);
    for (const id of ["0", "-1", "1.1", "1e3", "9007199254740992"])
      expect((await read(query, `/${id}`)).statusCode).toBe(400);
    expect((await read("period=1m", `/${seq}`)).statusCode).toBe(400);
    expect((await detail(seq, page)).selected.sequence).toBe(seq);
  });
  it("authenticates every GET, excludes payloads from lists and leaves missing archives empty", async () => {
    const { app, insert, base, list, read } = await setup();
    insert({ note: "raw-only-secret-text" });
    for (const suffix of ["", "/1"])
      expect((await app.inject(`${base}${suffix}?period=1m`)).statusCode).toBe(
        401,
      );
    const response = await read();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("raw-only-secret-text");
    expect(response.json()).toMatchObject({
      liveEligible: false,
      receipts: [{ requestedPeriod: "1m", status: "QUARANTINED" }],
    });
    expect((await list("5m")).receipts).toEqual([]);
    expect(
      (await read("period=1m", "", base.replace("TEST", "MISSING"))).json()
        .receipts,
    ).toEqual([]);
  });
  it("freezes 20-row pages and details while new receipts arrive, ordering equal times by sequence", async () => {
    const { insert, list, read, detail } = await setup();
    for (let i = 0; i < 23; i++) insert();
    const first = await list();
    expect(first.receipts.map((x) => x.sequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => 23 - i),
    );
    expect(first.nextBefore).toBe(4);
    insert({ close: "999" });
    const next = (
      await read(
        `period=1m&snapshot=${first.snapshot}&before=${first.nextBefore}`,
      )
    ).json<ProviderReceiptPage>();
    expect(next.receipts.map((x) => x.sequence)).toEqual([3, 2, 1]);
    expect(next.snapshot).toBe(first.snapshot);
    expect(next.nextBefore).toBeNull();
    expect((await detail(23, first)).selected.payloadJson).toContain(
      '"close":"101"',
    );
    expect(
      (await read(`period=1m&snapshot=${first.snapshot}`, "/24")).statusCode,
    ).toBe(404);
    expect((await list()).throughSequence).toBe(24);
  });
  it("preserves request identity independently from returned period and keeps legacy identity unknown", async () => {
    const { insert, list, detail } = await setup();
    const mismatch = insert({ period: "5m" });
    const legacy = insert({ period: "1m" }, { requested: null });
    expect((await list("5m")).receipts).toEqual([]);
    expect((await list()).receipts.map((x) => x.sequence)).toEqual([mismatch]);
    const unknown = await list("unknown");
    expect(unknown.receipts).toMatchObject([
      { sequence: legacy, requestedPeriod: null },
    ]);
    expect(
      JSON.parse((await detail(mismatch, await list())).selected.payloadJson!)
        .period,
    ).toBe("5m");
  });
  it("compares the exact prior source, instrument, provider symbol, returned period and timestamp, including unknown request periods", async () => {
    const { insert, list, detail } = await setup();
    const first = insert({}, { requested: null });
    const second = insert({ receivedAt: 2100 });
    insert({ close: "900" }, { source: "other-provider" });
    insert({ close: "901" }, { id: "US:OTHER.US" });
    insert({ close: "902", symbol: "OTHER.US" });
    insert({ close: "903", period: "5m" });
    insert({ close: "904", timestamp: 999 });
    const latest = insert({ close: "102", receivedAt: 2200 });
    const page = await list();
    expect(await detail(second, page)).toMatchObject({
      comparison: "UNCHANGED",
      previous: { sequence: first },
      changes: [],
    });
    expect(await detail(latest, page)).toMatchObject({
      comparison: "CHANGED",
      selected: { integrity: "MATCH" },
      previous: { sequence: second, integrity: "MATCH" },
      changes: [{ field: "close", before: "101", after: "102" }],
    });
    expect((await detail(first, await list("unknown"))).comparison).toBe(
      "FIRST_SEEN",
    );
  });
  it("exposes invalid, mismatched and oversized archives without claiming a trustworthy comparison", async () => {
    const { insert, list, detail } = await setup();
    const corrupt = insert({}, { hash: "f".repeat(64) });
    const goodAfterCorrupt = insert();
    const malformed = insert({}, { raw: "not-json" });
    const oversized = insert({ note: "X".repeat(RECEIPT_PAYLOAD_MAX_BYTES) });
    const page = await list();
    expect(await detail(corrupt, page)).toMatchObject({
      selected: { integrity: "MISMATCH" },
      comparison: "UNAVAILABLE",
    });
    expect(await detail(goodAfterCorrupt, page)).toMatchObject({
      previous: { sequence: corrupt, integrity: "MISMATCH" },
      comparison: "UNAVAILABLE",
    });
    expect(await detail(malformed, page)).toMatchObject({
      selected: { integrity: "INVALID_JSON", payloadJson: "not-json" },
      comparison: "UNAVAILABLE",
    });
    const large = await detail(oversized, page);
    expect(large).toMatchObject({
      selected: {
        integrity: "TOO_LARGE",
        payloadJson: null,
        computedHash: null,
      },
      comparison: "UNAVAILABLE",
    });
    expect(JSON.stringify(large).length).toBeLessThan(2000);
  });
  it("keeps the original payload bytes and rejects cross-scope cursors, restored datasets and future checkpoints", async () => {
    const { app, insert, list, read, base, detail } = await setup();
    const seq = insert({
      note: "<script>document.body.remove()</script> 中文",
    });
    const page = await list();
    const response = await read(
      `period=1m&snapshot=${page.snapshot}`,
      `/${seq}`,
    );
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await detail(seq, page)).selected.payloadJson).toBe(
      (
        app.store.db
          .prepare("SELECT payload_json AS raw FROM market_provider_receipts")
          .get() as { raw: string }
      ).raw,
    );
    expect((await read(`period=5m&snapshot=${page.snapshot}`)).statusCode).toBe(
      400,
    );
    expect(
      (
        await read(
          `period=1m&snapshot=${page.snapshot}`,
          "/1",
          base.replace("TEST", "OTHER"),
        )
      ).statusCode,
    ).toBe(400);
    const future = JSON.parse(
      Buffer.from(page.snapshot, "base64url").toString(),
    );
    future.through++;
    expect(
      (
        await read(
          `period=1m&snapshot=${Buffer.from(JSON.stringify(future)).toString("base64url")}`,
        )
      ).statusCode,
    ).toBe(409);
    app.store.setSetting("event_feed_epoch", "restored-dataset");
    expect((await read(`period=1m&snapshot=${page.snapshot}`)).statusCode).toBe(
      409,
    );
    expect(
      (await read(`period=1m&snapshot=${page.snapshot}`, "/1")).statusCode,
    ).toBe(409);
  });
  it.each([
    "",
    "period=1h",
    "period=1m&period=5m",
    "period=1m&before=1",
    "period=1m&before=-1",
    "period=1m&snapshot=bad",
    "period=1m&limit=999999",
    "period=1m&snapshot=a&before=1e3",
  ])("rejects malformed query %s", async (query) => {
    const { read } = await setup();
    expect((await read(query)).statusCode).toBe(400);
  });
  it("performs zero writes, offers no mutation endpoint, and can read retained evidence without a current universe entry", async () => {
    const { app, insert, list, detail, headers, base } = await setup();
    const seq = insert();
    const before = app.store.db.prepare("SELECT total_changes() n").get();
    const page = await list();
    expect((await detail(seq, page)).selected.sequence).toBe(seq);
    expect(
      (await app.inject({ method: "POST", url: base, headers, payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(app.store.db.prepare("SELECT total_changes() n").get()).toEqual(
      before,
    );
    expect(
      app.store.db.prepare("SELECT count(*) n FROM market_raw_inputs").get(),
    ).toEqual({ n: 0 });
    expect(
      app.store.db.prepare("SELECT count(*) n FROM notifications").get(),
    ).toEqual({ n: 0 });
  });
});
