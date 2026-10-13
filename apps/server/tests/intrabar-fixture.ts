/** Synthetic provider contract for isolated tests only. Never imported by application startup. */
import type { IntrabarContract } from "../intrabar-contract.js";
import { ContractAdapter, OPEN } from "./closed-bar-fixture.js";
export const testIntrabarContract: IntrabarContract = {
  evidenceId: "isolated-test-evidence",
  protocolEvidenceId: "isolated-test-protocol",
  rawSampleSha256: "a".repeat(64),
  verifiedAt: OPEN - 1,
  validUntil: OPEN + 3600000,
  sequenceScope: "INSTRUMENT_SESSION",
  predecessor: "PROVIDER_EXPLICIT_PREDECESSOR",
  packetOrder: "PROVIDER_POSITION",
  coverage: "PROVIDER_CERTIFIED_INTERVAL",
  reconnect: "NEW_EPOCH_REQUIRES_RECOVERY",
  tradeTypes: "REGULAR_TRADES_ONLY_CORRECTIONS_INVALIDATE",
};
export class IntrabarContractAdapter extends ContractAdapter {
  constructor() {
    super();
    this.context.tickContract = structuredClone(testIntrabarContract);
    this.context.capability.sequenceContractVerified = true;
    this.context.capability.continuousTradesVerified = true;
  }
}
