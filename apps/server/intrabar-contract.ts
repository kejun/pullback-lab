import Decimal from "decimal.js";
import type { ClosedBarContext } from "./closed-bar-adapter.js";
import type { MarketSession } from "../../packages/market-data/calendar.js";
import { assessCapability } from "../../packages/market-data/capabilities.js";

/** Audited SERVER dependency, never accepted from HTTP, uploaded evidence or local counters.
 * An adapter must map actual provider protocol guarantees to every assertion below.
 * Longbridge 5.2.0 does not supply this contract. Sequence existence alone is insufficient. */
export interface IntrabarContract {
  evidenceId: string;
  protocolEvidenceId: string;
  rawSampleSha256: string;
  verifiedAt: number;
  validUntil: number;
  sequenceScope: "INSTRUMENT_SESSION";
  predecessor: "PROVIDER_EXPLICIT_PREDECESSOR";
  packetOrder: "PROVIDER_POSITION";
  coverage: "PROVIDER_CERTIFIED_INTERVAL";
  reconnect: "NEW_EPOCH_REQUIRES_RECOVERY";
  tradeTypes: "REGULAR_TRADES_ONLY_CORRECTIONS_INVALIDATE";
}
export interface TickPacket {
  instrumentId: string;
  sessionId: string;
  source: string;
  providerEpoch: string;
  providerSequence: string;
  previousProviderSequence: string | null;
  /** Provider-certified gap-free coverage, never inferred from first/last event times. */
  coverageFrom: number;
  coverageThrough: number;
  trades: {
    position: number;
    at: number;
    price: string;
    type: "REGULAR_TRADE";
  }[];
}
export interface TickCursor {
  providerEpoch: string;
  providerSequence: string;
  coverageFrom: number;
  coverageThrough: number;
  lastTradeAt: number | null;
  lastTradeToken: string | null;
}
const token = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
export function intrabarContractReason(
  context: ClosedBarContext,
  now: number,
): string | null {
  if (assessCapability(context.capability, now).level !== "LIVE_TICK")
    return "TICK_CAPABILITY_UNVERIFIED";
  const c = context.tickContract;
  if (
    !c ||
    !token(c.evidenceId) ||
    !token(c.protocolEvidenceId) ||
    !/^[a-f0-9]{64}$/.test(c.rawSampleSha256) ||
    !Number.isSafeInteger(c.verifiedAt) ||
    c.verifiedAt > now ||
    !Number.isSafeInteger(c.validUntil) ||
    c.validUntil < now ||
    c.validUntil < c.verifiedAt ||
    c.sequenceScope !== "INSTRUMENT_SESSION" ||
    c.predecessor !== "PROVIDER_EXPLICIT_PREDECESSOR" ||
    c.packetOrder !== "PROVIDER_POSITION" ||
    c.coverage !== "PROVIDER_CERTIFIED_INTERVAL" ||
    c.reconnect !== "NEW_EPOCH_REQUIRES_RECOVERY" ||
    c.tradeTypes !== "REGULAR_TRADES_ONLY_CORRECTIONS_INVALIDATE"
  )
    return "TICK_PROTOCOL_EVIDENCE_UNVERIFIED";
  return null;
}
/** Tokens retain the actual provider sequence and packet position, not ingest order. */
export const tickToken = (packet: TickPacket, position: number): string =>
  JSON.stringify([packet.providerEpoch, packet.providerSequence, position]);
export function validateTickPacket(
  packet: TickPacket,
  context: ClosedBarContext & { session: MarketSession },
  receivedAt: number,
  cursor: TickCursor | null,
): TickCursor {
  const fail = (reason: string): never => {
    throw new Error(reason);
  };
  if (intrabarContractReason(context, receivedAt))
    fail("TICK_PROTOCOL_EVIDENCE_UNVERIFIED");
  if (
    !packet ||
    packet.source !== context.source ||
    packet.instrumentId !== context.instrument.id ||
    packet.sessionId !== context.session.id ||
    !token(packet.providerEpoch) ||
    !token(packet.providerSequence) ||
    !(
      packet.previousProviderSequence === null ||
      token(packet.previousProviderSequence)
    ) ||
    !Number.isSafeInteger(packet.coverageFrom) ||
    !Number.isSafeInteger(packet.coverageThrough) ||
    packet.coverageThrough < packet.coverageFrom ||
    packet.coverageThrough > receivedAt ||
    !context.session.intervals.some(
      (i) => packet.coverageFrom >= i.start && packet.coverageThrough <= i.end,
    ) ||
    !Array.isArray(packet.trades) ||
    packet.trades.length > 500
  )
    fail("TICK_PACKET_INVALID");
  if (
    cursor &&
    (packet.providerEpoch !== cursor.providerEpoch ||
      packet.previousProviderSequence !== cursor.providerSequence ||
      packet.coverageFrom !== cursor.coverageThrough)
  )
    fail("TICK_CONTINUITY_GAP");
  if (!cursor && packet.previousProviderSequence !== null)
    fail("TICK_STREAM_ANCHOR_MISSING");
  let lastAt = cursor?.lastTradeAt ?? null;
  let lastToken = cursor?.lastTradeToken ?? null;
  for (const [position, trade] of packet.trades.entries()) {
    let validPrice = false;
    try {
      validPrice =
        typeof trade.price === "string" &&
        new Decimal(trade.price).isFinite() &&
        new Decimal(trade.price).gt(0);
    } catch {
      /* reject below */
    }
    if (
      trade.position !== position ||
      trade.type !== "REGULAR_TRADE" ||
      !validPrice ||
      !Number.isSafeInteger(trade.at) ||
      trade.at < packet.coverageFrom ||
      trade.at > packet.coverageThrough
    )
      fail("TICK_TRADE_INVALID");
    if (lastAt !== null && trade.at < lastAt) fail("TICK_EVENT_TIME_REGRESSED");
    if (receivedAt - trade.at > 3000) fail("TICK_TOO_OLD");
    lastAt = trade.at;
    lastToken = tickToken(packet, position);
  }
  // Empty packets are provider-certified coverage heartbeats, not manufactured trades.
  if (receivedAt - packet.coverageThrough > 3000) fail("TICK_COVERAGE_STALE");
  return {
    providerEpoch: packet.providerEpoch,
    providerSequence: packet.providerSequence,
    coverageFrom: cursor?.coverageFrom ?? packet.coverageFrom,
    coverageThrough: packet.coverageThrough,
    lastTradeAt: lastAt,
    lastTradeToken: lastToken,
  };
}
