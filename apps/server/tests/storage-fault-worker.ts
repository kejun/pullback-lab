import { Store } from "../store.js";
import { replayPlan } from "../replay.js";

const [path, planId, clock, boundary] = process.argv.slice(2);
const store = new Store(path);
if (boundary === "before") {
  store.db.function("crash_before_notification", () => {
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not stop the process");
  });
  store.db
    .exec(`CREATE TEMP TRIGGER crash_notification BEFORE INSERT ON notifications
    BEGIN SELECT crash_before_notification(); END;`);
}
replayPlan(store, planId, Number(clock));
// Returning from replayPlan is after the real SQLite transaction commits.
process.kill(process.pid, "SIGKILL");
