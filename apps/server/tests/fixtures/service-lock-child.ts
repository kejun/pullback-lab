import { acquireServiceLock } from "../../runtime-safety.js";

try {
  const lock = acquireServiceLock(process.argv[2]);
  process.send?.({ kind: "acquired", databasePath: lock.databasePath });
  process.on("message", (message) => {
    if (message !== "release") return;
    lock.release();
    lock.release(); // Cleanup is safe when multiple shutdown paths converge.
    process.exit(0);
  });
} catch (error) {
  process.send?.({ kind: "rejected", code: (error as { code?: string }).code });
  process.exit(73);
}
