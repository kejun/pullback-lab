import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PullbackApp } from "../app.js";
import { normalizePriceProposal } from "../price-proposal.js";
import { demoInstruments } from "../../../packages/market-data/fixtures.js";

const instrument = demoInstruments[0];
const apps: PullbackApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
describe("server-owned chart price proposals", () => {
  it("quantizes drawing proposals in decimal at the half-tick boundary", () => {
    expect(
      normalizePriceProposal(instrument, {
        kind: "POINT",
        displayPrice: "100.614999999999",
      }).price,
    ).toBe("100.61");
    expect(
      normalizePriceProposal(instrument, {
        kind: "POINT",
        displayPrice: "100.615",
      }).price,
    ).toBe("100.62");
    expect(
      normalizePriceProposal(
        { ...instrument, tick: "0.05" },
        { kind: "POINT", displayPrice: "100.025" },
      ),
    ).toMatchObject({ price: "100.05", tick: "0.05", rounded: true });
  });
  it("keeps exact keyboard steps at prices that cannot safely be drawn", () => {
    expect(
      normalizePriceProposal(instrument, {
        kind: "STEP",
        price: "9007199254740993.01",
        steps: -1,
      }).price,
    ).toBe("9007199254740993");
    expect(() =>
      normalizePriceProposal(instrument, {
        kind: "POINT",
        displayPrice: "9007199254740993.01",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CHART_RESOLUTION_UNSAFE" }),
    );
    expect(
      normalizePriceProposal(
        { ...instrument, tick: "0.00000001" },
        { kind: "STEP", price: "0.00000002", steps: 1 },
      ).price,
    ).toBe("0.00000003");
  });
  it("rejects unknown rules, off-grid starts, nonpositive results and nondecimal input", () => {
    expect(() =>
      normalizePriceProposal(
        { ...instrument, rulesVerified: false },
        { kind: "STEP", price: "100", steps: 1 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INSTRUMENT_RULES_UNVERIFIED" }),
    );
    expect(() =>
      normalizePriceProposal(instrument, {
        kind: "STEP",
        price: "100.005",
        steps: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "PRICE_NOT_ON_TICK" }));
    for (const displayPrice of [
      "0",
      "-1",
      "1e2",
      "NaN",
      "Infinity",
      " 100",
      "100 ",
    ])
      expect(() =>
        normalizePriceProposal(instrument, { kind: "POINT", displayPrice }),
      ).toThrow();
    expect(() =>
      normalizePriceProposal(instrument, {
        kind: "STEP",
        price: "0.01",
        steps: -1,
      }),
    ).toThrow();
    expect(() =>
      normalizePriceProposal(instrument, {
        kind: "STEP",
        price: "1" + "0".repeat(63),
        steps: 1,
      }),
    ).toThrow();
  });
  it("uses stored rules, requires authentication/CSRF, and writes no plan", async () => {
    const app = await createApp({
      password: "proposal-test-password",
      demo: true,
    });
    apps.push(app);
    app.store.putInstrument({ instrument, manual: false, tags: [], note: "" });
    const url = `/api/instruments/${instrument.id}/price-proposal`;
    const payload = { kind: "POINT", displayPrice: "100.615" };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "x-requested-with": "PullbackLab" },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "proposal-test-password" },
    });
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
    expect(
      (await app.inject({ method: "POST", url, headers: { cookie }, payload }))
        .statusCode,
    ).toBe(403);
    const headers = { cookie, "x-requested-with": "PullbackLab" };
    const before = app.store.db.serialize();
    const result = await app.inject({ method: "POST", url, headers, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      price: "100.62",
      tick: "0.01",
      basis: "DISPLAY_PROPOSAL",
    });
    expect(app.store.db.serialize()).toEqual(before);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, tick: "10" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { kind: "STEP", price: "100", steps: 0.5 },
        })
      ).statusCode,
    ).toBe(400);
  });
});
