import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "./app.js";

const app = await createApp({
  databasePath: process.env.PULLBACK_DB ?? "./data/pullback.sqlite",
  password: process.env.PULLBACK_PASSWORD,
  demo: process.env.PULLBACK_DEMO === "1",
  origin: process.env.PULLBACK_ORIGIN,
  secureCookies: process.env.NODE_ENV === "production",
  logger: true,
  restore: process.env.PULLBACK_RESTORED === "1",
});
const staticRoot = resolve("dist/web");
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "找不到接口", code: "NOT_FOUND" })
      : reply.sendFile("index.html"),
  );
}
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
