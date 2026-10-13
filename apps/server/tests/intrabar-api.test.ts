import { expect, it } from "vitest";
import { createApp } from "../app.js";
import { IntrabarContractAdapter } from "./intrabar-fixture.js";
import { OPEN, planInput, testFunds } from "./closed-bar-fixture.js";
it.each([false, true])(
  "only enables an explicit intrabar plan with server protocol evidence=%s, never an uploaded claim",
  async (verified) => {
    const adapter = new IntrabarContractAdapter();
    if (!verified) adapter.context.tickContract = undefined;
    const now = OPEN - 1;
    const app = await createApp({
      password: "intrabar-api-test-password",
      demo: false,
      now: () => now,
      closedBarAdapter: adapter,
    });
    try {
      app.store.putInstrument({
        instrument: adapter.context.instrument,
        manual: true,
        tags: [],
        note: "isolated contract",
      });
      await app.monitor.start();
      app.store.confirmScreening(undefined, 0, now);
      app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
      const plan = app.store.createPlan(
        { ...planInput, mode: "INTRABAR_CROSS" },
        now,
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-requested-with": "PullbackLab" },
        payload: { password: "intrabar-api-test-password" },
      });
      const headers = {
        "x-requested-with": "PullbackLab",
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      };
      const boot = await app.inject({ url: "/api/bootstrap", headers });
      expect(boot.json().intrabarEligibleInstrumentIds).toEqual(
        verified ? [plan.instrumentId] : [],
      );
      const activate = await app.inject({
        method: "POST",
        url: `/api/plans/${plan.id}/activate`,
        headers,
        payload: {
          expectedVersion: plan.version,
          expectedAttemptId: null,
          capability: "LIVE_TICK",
          tickContract: { sequenceScope: "INSTRUMENT_SESSION", verified: true },
        },
      });
      expect(activate.statusCode, activate.body).toBe(verified ? 200 : 422);
      if (verified)
        expect(activate.json().monitor).toMatchObject({
          mode: "INTRABAR_CROSS",
          status: "WAIT_RETEST",
        });
      else
        expect(activate.json().code).toBe("TICK_PROTOCOL_EVIDENCE_UNVERIFIED");
      const upload = await app.inject({
        method: "POST",
        url: `/api/plans/${plan.id}/monitor/tick`,
        headers,
        payload: { providerSequence: "1" },
      });
      expect(upload.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  },
);
