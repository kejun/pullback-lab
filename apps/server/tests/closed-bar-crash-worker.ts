/** Separate process for real WAL/transaction death boundaries in contract acceptance. */
import { OPEN, setupClosed } from "./closed-bar-fixture.js";

const [path, boundary] = process.argv.slice(2);
const fixture = await setupClosed({ path, autoDrain: false });
fixture.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
fixture.runner.drain();
fixture.setNow(OPEN + 120_000);
fixture.adapter.quote(fixture.now(), "101");
fixture.runner.drain();
fixture.adapter.sink.minute(
  fixture.adapter.bar(1, {
    open: "100.5",
    high: "101.2",
    low: "100.4",
    close: "101",
  }),
);
function crash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not stop the fixture");
}
if (boundary === "ingress") crash();
if (boundary === "before_notification") {
  fixture.store.db.function("crash_closed_notification", crash);
  fixture.store.db.exec(
    "CREATE TEMP TRIGGER crash_closed_notification BEFORE INSERT ON notifications BEGIN SELECT crash_closed_notification(); END",
  );
}
fixture.runner.drain();
crash();
