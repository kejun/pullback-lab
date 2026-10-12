import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApp, type PullbackApp } from "../app.js";
import { Store } from "../store.js";
import { DATABASE_MIGRATIONS, runMigrations } from "../migrations.js";
import {
  BoundedEventWriter,
  EVENT_STREAM_MAX_BYTES,
  EVENT_STREAM_MAX_BLOCKED_MS,
} from "../events-feed.js";
import { demoInstruments } from "../../../packages/market-data/index.js";
import type {
  EventFeedBatch,
  EventPage,
  PlanInput,
} from "../../../packages/contracts/index.js";

const apps: PullbackApp[] = [];
const dirs: string[] = [];
const password = "test-private-feed";
const now = Date.parse("2026-10-12T11:00:00Z");
const marker = { "x-requested-with": "PullbackLab" };
const planInput: PlanInput = {
  instrumentId: "DEMO-US-A",
  anchorTime: null,
  primarySupport: "100",
  lower: "99.75",
  upper: "100.25",
  stop: "99",
  entryMin: "100.5",
  entryMax: "101.5",
  mode: "CLOSE_CONFIRM",
  sessionDate: "2026-10-09",
  reason: "fixture",
  backgroundConfirmed: true,
};
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function setup(databasePath?: string, restore = false) {
  const app = await createApp({
    databasePath,
    password,
    demo: true,
    now: () => now,
    restore,
  });
  apps.push(app);
  const logged = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: marker,
    payload: { password },
  });
  const cookie = logged.headers["set-cookie"]!.toString().split(";")[0];
  return { app, headers: { ...marker, cookie } };
}
function seed(store: Store, count: number, large = false) {
  store.putInstrument({
    instrument: demoInstruments[0],
    tags: [],
    note: "",
    manual: false,
  });
  const plan = store.createPlan(planInput, now);
  const ids: string[] = [];
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = `${plan.id}-${index}`;
      ids.push(id);
      const snapshot = {
        synthetic: true,
        plan,
        privateEvidence: large
          ? "sensitive-evidence".repeat(10_000)
          : "frozen-evidence",
      };
      const encoded = JSON.stringify(snapshot);
      const hash = createHash("sha256").update(encoded).digest("hex");
      store.db
        .prepare(
          "INSERT INTO decision_inputs SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM decision_inputs WHERE hash=?)",
        )
        .run(hash, encoded, hash);
      const event = {
        id,
        planId: plan.id,
        attemptId: `fixture-${id}`,
        type: "HISTORICAL_TRIGGERED",
        time: now,
        receivedAt: now,
        message: "合成历史事实",
        reasons: [],
        quantity: 1,
        historical: true,
        read: false,
        feedback: null,
        snapshot,
      };
      store.db
        .prepare(
          "INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES(?,?,?,?,?,?)",
        )
        .run(id, event.attemptId, event.type, id, hash, JSON.stringify(event));
      store.db.prepare("INSERT INTO notifications VALUES(?,?)").run(id, now);
    }
  });
  return ids;
}
async function streamFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let result = "";
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 3000);
  try {
    while (!result.includes("\ndata: ")) {
      const next = await reader.read();
      if (next.done) return result;
      result += new TextDecoder().decode(next.value);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
function batch(frame: string): EventFeedBatch {
  return JSON.parse(
    frame
      .split("\n")
      .find((line) => line.startsWith("data: "))!
      .slice(6),
  );
}

describe("bounded durable event feed", () => {
  it("pages immutable sequence in both directions, bounds bootstrap and loads evidence only by ID", async () => {
    const { app, headers } = await setup();
    const ids = seed(app.store, 123, true);
    const first = (
      await app.inject({ url: "/api/events?limit=50", headers })
    ).json<EventPage>();
    expect(first.events).toHaveLength(50);
    expect(first.events[0].id).toBe(ids.at(-1));
    expect(first.counts).toEqual({
      total: 123,
      unread: 123,
      pending: 123,
      taken: 0,
      skipped: 0,
    });
    expect(first.hasMore).toBe(true);
    expect(first.events[0]).toMatchObject({
      synthetic: true,
      recordable: true,
      feedbackRevisionId: null,
    });
    expect(first.events[0]).not.toHaveProperty("snapshot");
    expect(JSON.stringify(first)).not.toContain("privateEvidence");
    const second = (
      await app.inject({
        url: `/api/events?before=${first.beforeCursor}`,
        headers,
      })
    ).json<EventPage>();
    // Insertions after the first page cannot shift a before cursor or hide history.
    seed(app.store, 2);
    const third = (
      await app.inject({
        url: `/api/events?before=${second.beforeCursor}`,
        headers,
      })
    ).json<EventPage>();
    expect(third.events).toHaveLength(23);
    expect(third.hasMore).toBe(false);
    expect(
      new Set(
        [...first.events, ...second.events, ...third.events].map(
          (event) => event.id,
        ),
      ).size,
    ).toBe(123);
    const after = (
      await app.inject({
        url: `/api/events?after=${first.afterCursor}`,
        headers,
      })
    ).json<EventPage>();
    expect(after.events).toHaveLength(2);
    expect(after.events.map((event) => event.seq)).toEqual(
      [...after.events.map((event) => event.seq)].sort((a, b) => a - b),
    );
    const bootstrap = await app.inject({ url: "/api/bootstrap", headers });
    expect(bootstrap.json().events).toHaveLength(50);
    expect(Buffer.byteLength(bootstrap.body)).toBeLessThan(100_000);
    expect(bootstrap.body).not.toContain("privateEvidence");
    const detail = (
      await app.inject({ url: `/api/events/${ids[0]}`, headers })
    ).json();
    expect(detail.snapshot.privateEvidence).toHaveLength(180_000);
    expect(
      (await app.inject({ url: "/api/events?limit=51", headers })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/events?before=${first.beforeCursor}&after=${first.afterCursor}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/events?after=missing", headers }))
        .statusCode,
    ).toBe(409);
  });

  it("publishes read/feedback changes of old pages, preserves facts, and does not mark delivery read", async () => {
    const { app, headers } = await setup();
    const ids = seed(app.store, 60);
    const before = app.store.eventPage();
    const immutable = app.store.db
      .prepare("SELECT json FROM decision_events WHERE id=?")
      .get(ids[0]);
    const read = await app.inject({
      method: "POST",
      url: `/api/events/${ids[0]}/read`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    const feedback = await app.inject({
      method: "POST",
      url: `/api/events/${ids[0]}/feedback`,
      headers,
      payload: { kind: "TAKEN", note: "another tab", expectedRevisionId: null },
    });
    expect(feedback.statusCode).toBe(200);
    const update = app.store.eventFeed(before.feedCursor);
    expect(update.events).toHaveLength(1);
    expect(update.events[0]).toMatchObject({
      id: ids[0],
      feedback: "TAKEN",
      read: true,
    });
    expect(update.events[0].changeSeq).toBeGreaterThan(before.feedRevision);
    expect(update.counts).toEqual({
      total: 60,
      unread: 59,
      pending: 59,
      taken: 1,
      skipped: 0,
    });
    expect(
      app.store.db
        .prepare("SELECT json FROM decision_events WHERE id=?")
        .get(ids[0]),
    ).toEqual(immutable);
    expect(app.store.eventPage().counts.unread).toBe(59);
    expect(app.store.eventFeed(update.feedCursor).events).toEqual([]);
  });

  it("migrates legacy notifications once and preserves cursor epoch across normal reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-feed-"));
    dirs.push(dir);
    const path = join(dir, "feed.sqlite");
    const old = new Database(path);
    runMigrations(old, DATABASE_MIGRATIONS.slice(0, 3));
    old.prepare("INSERT INTO decision_inputs VALUES(?,?)").run("input", "{}");
    old
      .prepare(
        "INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "legacy",
        "legacy",
        "REPLAY_RESULT",
        "legacy",
        "input",
        JSON.stringify({
          id: "legacy",
          planId: "p",
          attemptId: "legacy",
          type: "REPLAY_RESULT",
          time: now,
          receivedAt: now,
          message: "legacy",
          reasons: [],
          historical: true,
          quantity: null,
          snapshot: {},
        }),
      );
    old.prepare("INSERT INTO notifications VALUES(?,?)").run("legacy", now);
    old.close();
    const store = new Store(path);
    const initial = store.eventPage();
    expect(initial.feedRevision).toBe(1);
    expect(initial.events[0].id).toBe("legacy");
    store.close();
    const reopened = new Store(path);
    expect(reopened.eventPage().feedCursor).toBe(initial.feedCursor);
    expect(reopened.eventFeed(initial.feedCursor).events).toEqual([]);
    reopened.close();
    const { app } = await setup(path, true);
    expect(app.store.eventPage().feedEpoch).not.toBe(initial.feedEpoch);
    expect(() => app.store.eventFeed(initial.feedCursor)).toThrow(
      "事件游标不可用",
    );
  });

  it("uses real HTTP SSE for bounded summary resume/reset, authentication expiry and disconnect", async () => {
    const { app, headers } = await setup();
    const ids = seed(app.store, 55, true);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect((await fetch(`${address}/api/events/stream`)).status).toBe(401);
    const invalid = await fetch(`${address}/api/events/stream?after=unknown`, {
      headers,
    });
    const reset = await invalid.text();
    expect(reset).toContain("event: reset");
    expect(reset).toContain("CURSOR_EXPIRED");
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events/stream`, {
      headers,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = batch(await streamFrame(reader));
    expect(first.events.length).toBeLessThanOrEqual(10);
    expect(first.hasMore).toBe(true);
    expect(JSON.stringify(first)).not.toContain("privateEvidence");
    expect(app.store.eventPage().counts.unread).toBe(55);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const latest = app.store.eventPage();
    const nextController = new AbortController();
    const secondResponse = await fetch(
      `${address}/api/events/stream?after=unknown`,
      {
        headers: { ...headers, "last-event-id": latest.feedCursor },
        signal: nextController.signal,
      },
    );
    const secondReader = secondResponse.body!.getReader();
    await app.inject({
      method: "POST",
      url: `/api/events/${ids[0]}/read`,
      headers,
    });
    const update = batch(await streamFrame(secondReader));
    expect(update.events[0]).toMatchObject({ id: ids[0], read: true });
    await app.inject({ method: "POST", url: "/api/logout", headers });
    expect(await streamFrame(secondReader)).toContain("event: auth-expired");
    nextController.abort();
    await secondReader.cancel().catch(() => undefined);
    const started = Date.now();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops real HTTP writes at backpressure and destroys a stalled slow reader", async () => {
    let timestamp = 0;
    let blocked = false;
    let destroyed = false;
    let server: Server;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const writer = new BoundedEventWriter(response, () => timestamp);
      for (let index = 0; index < 100; index++) {
        if (!writer.write(`data: ${"x".repeat(60_000)}\n\n`)) break;
        if (!writer.ready) {
          blocked = true;
          break;
        }
      }
      expect(response.writableLength).toBeLessThanOrEqual(
        EVENT_STREAM_MAX_BYTES,
      );
      const buffered = response.writableLength;
      expect(writer.write("data: must-not-queue\n\n")).toBe(false);
      expect(response.writableLength).toBe(buffered);
      timestamp += EVENT_STREAM_MAX_BLOCKED_MS;
      expect(writer.ready).toBe(false);
      destroyed = response.destroyed;
      finish();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = get(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      (response) => response.pause(),
    );
    client.on("error", () => undefined);
    try {
      await done;
      expect(blocked).toBe(true);
      expect(destroyed).toBe(true);
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
