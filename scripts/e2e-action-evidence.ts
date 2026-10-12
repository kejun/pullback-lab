import { Store } from "../apps/server/store.js";
import { demoInstruments } from "../packages/market-data/fixtures.js";
import {
  actionTestManifest,
  ACTION_TEST_NOW,
} from "../packages/market-data/action-evidence-fixture.js";
import { evidenceHash } from "../packages/market-data/action-evidence.js";

/** Offline seeding before the service starts. Never registered as an HTTP mutation. */
export function seedActionEvidence(databasePath: string) {
  const store = new Store(databasePath);
  try {
    for (const instrument of demoInstruments.slice(0, 2))
      store.putInstrument({
        instrument,
        tags: [],
        note: "合成资料测试",
        manual: false,
      });
    const m = actionTestManifest();
    for (let i = 1; i <= 22; i++) {
      m.source = `synthetic-fixture-v${i}`;
      m.actions[0].revision = i;
      if (i === 22) {
        m.coverage.status = "UNKNOWN";
        m.coverage.reason = "合成测试：待核验修订";
        m.removedActionIds = ["split"];
        m.actions = [
          {
            id: "cash",
            revision: 1,
            kind: "CASH_DIVIDEND",
            effectiveAt: 2_000_000,
            publishedAt: 1_500_000,
            documentIds: ["doc"],
          },
        ];
        m.documents[0].content =
          "SYNTHETIC TEST ONLY: <script>window.evidenceExecuted = true</script> 资料原文保持纯文本。";
        m.documents[0].sha256 = evidenceHash(m.documents[0].content);
      }
      m.expectedVersion = store.importActionEvidence(
        m,
        ACTION_TEST_NOW,
      ).version;
    }
  } finally {
    store.close();
  }
}
