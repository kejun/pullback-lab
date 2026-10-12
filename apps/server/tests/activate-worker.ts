import { Store } from "../store.js";
const store = new Store(process.argv[2]);
process.send?.({ ready: true });
process.once("message", () => {
  try {
    const result = store.activate(process.argv[3], 1, Number(process.argv[4]));
    process.send?.({ passed: true, quantity: result.risk.quantity });
  } catch (error) {
    process.send?.({ passed: false, code: (error as { code?: string }).code });
  } finally {
    store.close();
    process.disconnect?.();
  }
});
