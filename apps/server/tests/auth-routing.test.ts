import { afterEach, describe, expect, it } from "vitest";
import fastifyStatic from "@fastify/static";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type PullbackApp } from "../app.js";

const password = "auth-routing-test-password";
const marker = { "x-requested-with": "PullbackLab" };
const prefixes = ["/api", "/%61pi", "/a%70i", "/ap%69", "/%61%70%69"];
const apps: PullbackApp[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function setup(configured = true, origin?: string) {
  const app = await createApp({
    password: configured ? password : undefined,
    origin,
  });
  apps.push(app);
  return app;
}
async function login(app: PullbackApp, url = "/api/login") {
  const response = await app.inject({
    method: "POST",
    url,
    headers: marker,
    payload: { password },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return {
    ...marker,
    cookie: response.headers["set-cookie"]!.toString().split(";")[0],
  };
}

describe("API security follows the matched route", () => {
  it.each(prefixes)(
    "rejects anonymous reads and SSE through %s",
    async (prefix) => {
      const app = await setup();
      for (const suffix of [
        "/bootstrap?source=security-test",
        "/universe",
        "/operations/status",
        "/market/status",
        "/events",
        "/events/stream",
        "/instruments/US%3ATEST.US/provider-receipts?period=1m",
        "/instruments/US%3ATEST.US/provider-receipts/1?period=1m",
        "/instruments/US%3ATEST.US/action-evidence",
      ]) {
        const response = await app.inject(`${prefix}${suffix}`);
        expect(response.statusCode, suffix).toBe(401);
        expect(response.json().code, suffix).toBe("UNAUTHENTICATED");
        expect(response.headers["cache-control"], suffix).toBe("no-store");
        expect(response.headers["content-type"], suffix).not.toContain(
          "text/event-stream",
        );
      }
      const head = await app.inject({
        method: "HEAD",
        url: `${prefix}/bootstrap`,
      });
      expect(head.statusCode).toBe(401);
      expect(head.body).toBe("");
      expect(head.headers["cache-control"]).toBe("no-store");
    },
  );

  it.each(prefixes)(
    "rejects anonymous writes through %s without changing research data",
    async (prefix) => {
      const app = await setup();
      const headers = await login(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/universe",
        headers,
        payload: {
          symbol: "PRIVATE.US",
          market: "US",
          note: "private research note",
        },
      });
      expect(created.statusCode).toBe(200);
      const id = encodeURIComponent(created.json().id);
      const before = app.store.listInstruments();
      for (const request of [
        {
          method: "POST" as const,
          url: `${prefix}/universe`,
          payload: { symbol: "UNAUTHORIZED.US", market: "US" },
        },
        {
          method: "PATCH" as const,
          url: `${prefix}/universe/${id}`,
          payload: { note: "unauthorized edit" },
        },
        { method: "DELETE" as const, url: `${prefix}/universe/${id}` },
      ]) {
        const response = await app.inject({ ...request, headers: marker });
        expect(response.statusCode, request.method).toBe(401);
        expect(response.json().code).toBe("UNAUTHENTICATED");
        expect(app.store.listInstruments()).toEqual(before);
      }
    },
  );

  it.each(prefixes)(
    "allows tunnel origins while enforcing sessions and CSRF through %s",
    async (prefix) => {
      const app = await setup(true, "https://configured.example");
      const headers = {
        ...(await login(app)),
        host: "127.0.0.1:3000",
        origin: "https://research.trycloudflare.com",
      };
      const before = app.store.listInstruments();
      for (const suffix of [
        "/bootstrap",
        "/events/stream?after=invalid-cursor",
      ]) {
        const response = await app.inject({
          url: `${prefix}${suffix}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        if (suffix.startsWith("/events/stream")) {
          expect(response.headers["content-type"]).toBe("text/event-stream");
          expect(response.body).toContain("event: reset");
        }
        const anonymous = await app.inject({
          url: `${prefix}${suffix}`,
          headers: { origin: headers.origin, host: headers.host },
        });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.json().code).toBe("UNAUTHENTICATED");
      }
      for (const [requestHeaders, code] of [
        [{ cookie: headers.cookie }, "CSRF_REJECTED"],
        [{ cookie: headers.cookie, origin: headers.origin }, "CSRF_REJECTED"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `${prefix}/universe`,
          headers: requestHeaders,
          payload: { symbol: "UNAUTHORIZED.US", market: "US" },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe(code);
        expect(app.store.listInstruments()).toEqual(before);
      }
      const write = await app.inject({
        method: "POST",
        url: `${prefix}/universe`,
        headers,
        payload: { symbol: "TUNNEL.US", market: "US" },
      });
      expect(write.statusCode).toBe(200);
      expect(app.store.listInstruments()).toHaveLength(1);
      expect(write.headers["access-control-allow-origin"]).toBeUndefined();
    },
  );

  it.each(prefixes)(
    "fails closed without a password through %s",
    async (prefix) => {
      const app = await setup(false);
      for (const suffix of [
        "/bootstrap",
        "/events/stream",
        "/operations/status",
      ]) {
        const response = await app.inject(`${prefix}${suffix}`);
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe("PASSWORD_NOT_CONFIGURED");
      }
      const write = await app.inject({
        method: "POST",
        url: `${prefix}/universe`,
        headers: marker,
        payload: { symbol: "UNAUTHORIZED.US", market: "US" },
      });
      expect(write.statusCode).toBe(503);
      expect(app.store.listInstruments()).toEqual([]);
    },
  );

  it.each(prefixes)(
    "keeps only the existing public routes public through %s",
    async (prefix) => {
      const app = await setup();
      for (const [suffix, expected] of [
        ["/%68ealth?probe=1", { ok: true }],
        ["/%73ession?probe=1", { configured: true, authenticated: false }],
      ] as const) {
        const response = await app.inject(`${prefix}${suffix}`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject(expected);
        expect(response.headers["cache-control"]).toBe("no-store");
        const foreign = await app.inject({
          url: `${prefix}${suffix}`,
          headers: { origin: "https://research.trycloudflare.com" },
        });
        expect(foreign.statusCode).toBe(200);
        expect(foreign.json()).toMatchObject(expected);
      }
      const loginUrl = `${prefix}/%6cogin?source=security-test`;
      const noMarker = await app.inject({
        method: "POST",
        url: loginUrl,
        payload: { password },
      });
      expect(noMarker.statusCode).toBe(403);
      expect(noMarker.json().code).toBe("CSRF_REJECTED");
      const foreign = await app.inject({
        method: "POST",
        url: loginUrl,
        headers: { ...marker, origin: "https://research.trycloudflare.com" },
        payload: { password },
      });
      expect(foreign.statusCode).toBe(200);
      const headers = await login(app, loginUrl);
      const session = await app.inject({ url: `${prefix}/session`, headers });
      expect(session.json().authenticated).toBe(true);
      const read = await app.inject({ url: `${prefix}/bootstrap`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      const write = await app.inject({
        method: "POST",
        url: `${prefix}/universe`,
        headers,
        payload: { symbol: "ALLOWED.US", market: "US" },
      });
      expect(write.statusCode).toBe(200);
      expect(app.store.listInstruments()).toHaveLength(1);
      // A rejected cursor closes the authorized stream immediately, keeping this
      // regression bounded while exercising the real SSE handler and response.
      const stream = await app.inject({
        url: `${prefix}/events/stream?after=invalid-cursor`,
        headers,
      });
      expect(stream.statusCode).toBe(200);
      expect(stream.headers["content-type"]).toBe("text/event-stream");
      expect(stream.body).toContain("event: reset");
      const logout = await app.inject({
        method: "POST",
        url: `${prefix}/logout`,
        headers,
      });
      expect(logout.statusCode).toBe(200);
      expect(
        (await app.inject({ url: `${prefix}/bootstrap`, headers })).statusCode,
      ).toBe(401);
    },
  );

  it("leaves public static assets available without exempting matched private routes", async () => {
    const app = await setup();
    const directory = mkdtempSync(join(tmpdir(), "pullback-auth-static-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "index.html"),
      "<title>Public login shell</title>",
    );
    writeFileSync(join(directory, "app.js"), "/* public login asset */");
    await app.register(fastifyStatic, { root: directory, prefix: "/" });
    expect((await app.inject("/")).body).toContain("Public login shell");
    expect((await app.inject("/app.js")).statusCode).toBe(200);
    expect((await app.inject("/%61pi/bootstrap")).statusCode).toBe(401);
    expect((await app.inject("/api/unknown")).statusCode).toBe(401);
    expect((await app.inject("/api/health/private")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/session",
          headers: marker,
        })
      ).statusCode,
    ).toBe(401);
  });
});
