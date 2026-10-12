import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store.js";
import { createApp, type PullbackApp } from "../app.js";
import {
  importUniverse,
  normalizeUniverseSymbol,
  readUniverse,
  universeRevision,
} from "../universe-service.js";

const stores: Store[] = [];
const apps: PullbackApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(path?: string) {
  const store = new Store(path);
  stores.push(store);
  return store;
}
function add(store: Store, rows: unknown[]) {
  return importUniverse(store, {
    rows,
    expectedRevision: universeRevision(store),
  });
}
async function api() {
  const app = await createApp({ password: "universe-test-password" });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "universe-test-password" },
  });
  const headers = {
    "x-requested-with": "PullbackLab",
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
  };
  return { app, headers };
}

describe("atomic, versioned research universe", () => {
  it("normalizes explicit market symbols and reports repeats without overwriting existing evidence or metadata", () => {
    const store = setup();
    add(store, [
      {
        symbol: "aapl",
        market: "US",
        name: "Apple",
        tags: ["关注"],
        note: "保留原始研究",
      },
    ]);
    const old = store.instrument("US:AAPL.US");
    old.instrument.rulesVerified = true;
    old.instrument.tick = "0.05";
    old.manual = false;
    store.putInstrument(old);
    const before = structuredClone(old);
    const result = add(store, [
      { symbol: " AApL.us ", market: "US", tags: ["覆盖"], note: "不应覆盖" },
      { symbol: "aapl", market: "US" },
      { symbol: " 600000.sh ", market: "CN", tags: [" 周期 ", "周期"] },
      { symbol: "msft", market: "US" },
    ]);
    expect(result.results.map((row) => row.status)).toEqual([
      "existing",
      "duplicate",
      "imported",
      "imported",
    ]);
    expect(result.results[1].duplicateOf).toBe(1);
    expect(store.instrument("US:AAPL.US")).toEqual(before);
    expect(store.instrument("CN:600000.SH").tags).toEqual(["周期"]);
    expect(store.instrument("US:MSFT.US").instrument.rulesVerified).toBe(false);
    const revision = result.universeRevision;
    expect(
      add(store, [{ symbol: "msft", market: "US" }]).universeRevision,
    ).toBe(revision);
    expect(result.limits.provider).toEqual({
      verified: false,
      researchSymbols: null,
      simultaneousSubscriptions: null,
      monthlyUniqueSymbols: null,
      requestsPerSecond: null,
    });
  });
  it("validates every row before any write and rejects forged rules, missing CN exchanges, and mismatched suffixes", () => {
    const store = setup();
    const before = store.db.serialize();
    try {
      add(store, [
        { symbol: "aapl", market: "US" },
        { symbol: "600000", market: "CN" },
        { symbol: "AAPL.US", market: "CN" },
        { symbol: "600000.SH", market: "US" },
        { symbol: "MSFT", market: "US", rulesVerified: true, tick: "1" },
      ]);
      expect.fail("invalid import must fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_UNIVERSE_ROWS",
        statusCode: 422,
        details: {
          results: [
            { row: 2, code: "SYMBOL_MARKET_MISMATCH" },
            { row: 3, code: "SYMBOL_MARKET_MISMATCH" },
            { row: 4, code: "SYMBOL_MARKET_MISMATCH" },
            { row: 5, code: "INVALID_UNIVERSE_ROW" },
          ],
        },
      });
    }
    expect(store.db.serialize()).toEqual(before);
    expect(normalizeUniverseSymbol(" brk.b ", "US")).toBe("BRK.B.US");
    expect(() => normalizeUniverseSymbol("AAPL.US.US", "US")).toThrow();
    expect(() => normalizeUniverseSymbol("AAPL.HK.US", "US")).toThrow();
  });
  it("recognizes legacy bare US symbols without replacing IDs referenced by history", () => {
    const store = setup();
    add(store, [{ symbol: "AAPL", market: "US", note: "已有研究" }]);
    const legacy = store.instrument("US:AAPL.US");
    store.deleteInstrument("US:AAPL.US");
    legacy.instrument.id = "US:AAPL";
    legacy.instrument.symbol = "AAPL";
    store.putInstrument(legacy);
    store.db
      .prepare("INSERT INTO plans VALUES(?,?,?)")
      .run(
        "legacy-plan",
        1,
        JSON.stringify({ id: "legacy-plan", instrumentId: "US:AAPL" }),
      );
    const before = universeRevision(store);
    const result = add(store, [
      { symbol: "aapl.us", market: "US" },
      { symbol: "AAPL", market: "US" },
    ]);
    expect(result.results).toMatchObject([
      { id: "US:AAPL", status: "existing" },
      { id: "US:AAPL", status: "duplicate", duplicateOf: 1 },
    ]);
    expect(result.universeRevision).toBe(before);
    expect(store.listInstruments()).toEqual([legacy]);
  });
  it("deduplicates before enforcing 100, then rolls back the entire over-capacity batch", () => {
    const store = setup();
    add(
      store,
      Array.from({ length: 99 }, (_, index) => ({
        symbol: `S${index}`,
        market: "US",
      })),
    );
    const before = store.db.serialize();
    expect(() =>
      add(store, [
        { symbol: "last", market: "US" },
        { symbol: "overflow", market: "US" },
      ]),
    ).toThrow(expect.objectContaining({ code: "UNIVERSE_LIMIT" }));
    expect(store.db.serialize()).toEqual(before);
    const result = add(store, [
      { symbol: "S0.US", market: "US" },
      { symbol: "last", market: "US" },
      { symbol: "LAST.US", market: "US" },
    ]);
    expect(result).toMatchObject({
      imported: 1,
      existing: 1,
      duplicates: 1,
      limits: { researchUsed: 100, localResearchRemaining: 0 },
    });
    expect(add(store, [{ symbol: "last", market: "US" }]).imported).toBe(0);
    expect(() =>
      add(
        store,
        Array.from({ length: 101 }, () => ({ symbol: "last", market: "US" })),
      ),
    ).toThrow();
  });
  it("uses smaller verified server-owned provider limits and never trusts unknown quota numbers", () => {
    const store = setup();
    const quota = {
      verified: true,
      researchSymbols: 1,
      simultaneousSubscriptions: 2,
      monthlyUniqueSymbols: 10,
      requestsPerSecond: 3,
    };
    expect(
      readUniverse(store, { providerQuota: () => quota }).limits
        .effectiveResearchMax,
    ).toBe(1);
    expect(() =>
      importUniverse(
        store,
        {
          rows: [
            { symbol: "AAPL", market: "US" },
            { symbol: "MSFT", market: "US" },
          ],
          expectedRevision: universeRevision(store),
        },
        { providerQuota: () => quota },
      ),
    ).toThrow(expect.objectContaining({ code: "UNIVERSE_LIMIT" }));
    expect(store.listInstruments()).toEqual([]);
    expect(
      readUniverse(store, {
        providerQuota: () => ({ ...quota, verified: false }),
      }).limits,
    ).toMatchObject({
      effectiveResearchMax: 100,
      provider: { verified: false, researchSymbols: null },
    });
    expect(
      readUniverse(store, {
        providerQuota: () => ({ ...quota, requestsPerSecond: null }),
      }).limits.provider.researchSymbols,
    ).toBeNull();
  });
  it("rolls back an interrupted batch after an earlier insert and bounds the total serialized input", () => {
    const store = setup();
    const put = store.putInstrument.bind(store);
    let writes = 0;
    store.putInstrument = (row) => {
      if (++writes === 2) throw new Error("simulated disk write failure");
      put(row);
    };
    const revision = universeRevision(store);
    expect(() =>
      add(store, [
        { symbol: "AAPL", market: "US" },
        { symbol: "MSFT", market: "US" },
      ]),
    ).toThrow("simulated disk write failure");
    expect(store.listInstruments()).toEqual([]);
    expect(universeRevision(store)).toBe(revision);
    expect(() =>
      add(
        store,
        Array.from({ length: 100 }, (_, index) => ({
          symbol: `S${index}`,
          market: "US",
          note: "文".repeat(1000),
        })),
      ),
    ).toThrow(expect.objectContaining({ code: "UNIVERSE_IMPORT_TOO_LARGE" }));
  });
  it("returns row errors and protects POST, metadata, and delete through the current revision and private API hooks", async () => {
    const { app, headers } = await api();
    expect((await app.inject("/api/universe")).statusCode).toBe(401);
    const revision = universeRevision(app.store);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/universe/import",
      headers,
      payload: {
        expectedRevision: revision,
        rows: [
          { symbol: "AAPL", market: "US" },
          { symbol: "600000", market: "CN" },
        ],
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      code: "INVALID_UNIVERSE_ROWS",
      results: [{ row: 2 }],
      universeRevision: revision,
    });
    const missingRevision = await app.inject({
      method: "POST",
      url: "/api/universe/import",
      headers,
      payload: { rows: [{ symbol: "AAPL", market: "US" }] },
    });
    expect(missingRevision.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/api/universe",
      headers,
      payload: { symbol: " aapl ", market: "US", expectedRevision: revision },
    });
    expect(created.json()).toMatchObject({
      id: "US:AAPL.US",
      symbol: "AAPL.US",
      rulesVerified: false,
    });
    const current = created.json().universeRevision;
    const staleAdd = await app.inject({
      method: "POST",
      url: "/api/universe",
      headers,
      payload: { symbol: "MSFT", market: "US", expectedRevision: revision },
    });
    expect(staleAdd.json()).toMatchObject({
      code: "UNIVERSE_VERSION_CONFLICT",
      universeRevision: current,
    });
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/universe/US:AAPL.US",
      headers,
      payload: { tags: ["保留"], note: "研究草稿", expectedRevision: current },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().universeRevision).not.toBe(current);
    const stalePatch = await app.inject({
      method: "PATCH",
      url: "/api/universe/US:AAPL.US",
      headers,
      payload: { tags: [], note: "过期覆盖", expectedRevision: current },
    });
    expect(stalePatch.statusCode).toBe(409);
    const staleDelete = await app.inject({
      method: "DELETE",
      url: "/api/universe/US:AAPL.US",
      headers,
      payload: { expectedRevision: current },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(app.store.instrument("US:AAPL.US").note).toBe("研究草稿");
    app.store.db
      .prepare("INSERT INTO plans VALUES(?,?,?)")
      .run(
        "preserved",
        1,
        JSON.stringify({ id: "preserved", instrumentId: "US:AAPL.US" }),
      );
    const protectedDelete = await app.inject({
      method: "DELETE",
      url: "/api/universe/US:AAPL.US",
      headers,
      payload: { expectedRevision: patch.json().universeRevision },
    });
    expect(protectedDelete.json().code).toBe("INSTRUMENT_HAS_PLANS");
  });
  it("keeps a shared 100-symbol cap when two processes race with the same revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-universe-race-"));
    dirs.push(dir);
    const path = join(dir, "pool.db");
    const store = setup(path);
    add(
      store,
      Array.from({ length: 99 }, (_, index) => ({
        symbol: `S${index}`,
        market: "US",
      })),
    );
    const revision = universeRevision(store);
    const source = `
      import { Store } from './apps/server/store.ts';
      import { importUniverse } from './apps/server/universe-service.ts';
      const store = new Store(process.env.UNIVERSE_TEST_DB);
      process.stdout.write('READY\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try {
        const result = importUniverse(store, { rows: [{symbol: process.env.UNIVERSE_TEST_SYMBOL, market:'US'}], expectedRevision: process.env.UNIVERSE_TEST_REVISION });
        process.stdout.write(JSON.stringify({imported:result.imported})+'\\n');
      } catch (error) { process.stdout.write(JSON.stringify({code:error.code})+'\\n'); }
      store.close(); process.stdin.destroy();
    `;
    const runners = ["WINNERA", "WINNERB"].map((symbol) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            UNIVERSE_TEST_DB: path,
            UNIVERSE_TEST_SYMBOL: symbol,
            UNIVERSE_TEST_REVISION: revision,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("READY\n")) resolve();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (!output.includes("READY\n"))
            reject(new Error(`child ${code}: ${stderr}`));
        });
      });
      const exited = once(child, "exit");
      return {
        child,
        ready,
        exited,
        output: () => output,
        stderr: () => stderr,
      };
    });
    try {
      await Promise.all(runners.map((runner) => runner.ready));
      runners.forEach((runner) => runner.child.stdin.write("GO\n"));
      const exits = await Promise.all(runners.map((runner) => runner.exited));
      expect(exits.map(([code]) => code)).toEqual([0, 0]);
      const results = runners.map((runner) =>
        JSON.parse(runner.output().trim().split("\n").at(-1)!),
      );
      expect(results.filter((result) => result.imported === 1)).toHaveLength(1);
      expect(
        results.filter((result) => result.code === "UNIVERSE_VERSION_CONFLICT"),
      ).toHaveLength(1);
      expect(store.listInstruments()).toHaveLength(100);
      expect(() => add(store, [{ symbol: "RETRY", market: "US" }])).toThrow(
        expect.objectContaining({ code: "UNIVERSE_LIMIT" }),
      );
    } finally {
      runners.forEach((runner) => {
        if (runner.child.exitCode === null) runner.child.kill();
      });
    }
  });
});
