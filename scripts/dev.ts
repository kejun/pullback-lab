import { spawn } from "node:child_process";
const children = [
  spawn("node", ["--import", "tsx", "apps/server/main.ts"], {
    stdio: "inherit",
  }),
  spawn("node", ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
let exiting = false;
function stop(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const c of children) c.kill("SIGTERM");
  process.exitCode = code;
}
for (const c of children) c.on("exit", (code) => stop(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop());
