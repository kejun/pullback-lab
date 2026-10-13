import type { QuoteContext } from "longbridge";
import { OperationTimeout, withDeadline } from "./deadline.js";

/** Raw Node callback boundaries, not a supplier packet/sequence contract. */
export interface RawTradeSourcePacket {
  symbol: string;
  receivedAt: number;
  providerSequence: null;
  trades: Array<{
    timestamp: number;
    price: string;
    volume: string;
    tradeType: string;
    direction: number;
    tradeSession: number;
  }>;
}
export const TRADE_SOURCE_PACKET_LIMIT = 512;
export const TRADE_SOURCE_TRADE_LIMIT = 4096;
export type TradeSourceFailure =
  | "TRADE_SOURCE_SUBSCRIBE_FAILED"
  | "TRADE_SOURCE_TIMEOUT"
  | "TRADE_SOURCE_STREAM_ERROR"
  | "TRADE_SOURCE_SAMPLE_INVALID"
  | "TRADE_SOURCE_SAMPLE_LIMIT"
  | "TRADE_SOURCE_CLEANUP_FAILED";
export interface TradeSourceObservation {
  status: "SAMPLED" | "INCOMPLETE";
  startedAt: number;
  completedAt: number;
  packets: RawTradeSourcePacket[];
  failure?: TradeSourceFailure;
  cleanup: "COMPLETE" | "FAILED";
  /** An unresolved operation poisons this context; this is not a provider capability. */
  reusable: boolean;
}
const TRADE_SUBTYPE = 3; // Locked 5.2.0 SubType.Trade; avoids loading native code for pure tests.
const validAt = (at: number) => Number.isSafeInteger(at) && at >= 0;

/** Dedicated, bounded QuoteContext trade observation. No seed merge or candle subscription. */
export async function observeRawTradeSources(
  ctx: Pick<QuoteContext, "setOnTrades" | "subscribe" | "unsubscribe">,
  symbols: string[],
  durationMs: number,
  timeoutMs: number,
  clock: () => number,
): Promise<TradeSourceObservation> {
  if (
    symbols.length < 1 ||
    symbols.length > 2 ||
    new Set(symbols).size !== symbols.length ||
    symbols.some((symbol) => !/^\d{6}\.(SH|SZ)$/.test(symbol)) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 120_000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  )
    throw new Error("TRADE_SOURCE_BOUNDS_INVALID");
  const startedAt = clock();
  if (!validAt(startedAt)) throw new Error("TRADE_SOURCE_CLOCK_INVALID");
  const packets: RawTradeSourcePacket[] = [];
  let disposing = false;
  let active = true,
    attempted = false,
    unsettled = false,
    cleanupFailed = false;
  let tradeCount = 0;
  let failure: TradeSourceFailure | undefined;
  let endWait: (() => void) | undefined;
  const stop = (code: TradeSourceFailure) => {
    failure ??= code;
    active = false;
    endWait?.();
  };
  const unsubscribe = () =>
    withDeadline(() => ctx.unsubscribe(symbols, [TRADE_SUBTYPE]), timeoutMs);
  try {
    ctx.setOnTrades((err, event) => {
      if (!active) return;
      if (err) return stop("TRADE_SOURCE_STREAM_ERROR");
      try {
        if (!symbols.includes(event.symbol)) return;
        const raw = event.data.trades;
        if (
          packets.length >= TRADE_SOURCE_PACKET_LIMIT ||
          raw.length > TRADE_SOURCE_TRADE_LIMIT - tradeCount
        )
          return stop("TRADE_SOURCE_SAMPLE_LIMIT");
        const receivedAt = clock();
        if (!validAt(receivedAt) || receivedAt < startedAt)
          return stop("TRADE_SOURCE_SAMPLE_INVALID");
        // Validate the entire callback before appending: never keep a silently truncated packet.
        const trades = raw.map((trade) => {
          const price = trade.price.toString(),
            timestamp = trade.timestamp.getTime();
          if (
            !validAt(timestamp) ||
            !/^\d{1,40}(\.\d{1,20})?$/.test(price) ||
            !Number.isSafeInteger(trade.volume) ||
            trade.volume < 0 ||
            typeof trade.tradeType !== "string" ||
            trade.tradeType.length > 32 ||
            !Number.isSafeInteger(trade.direction) ||
            !Number.isSafeInteger(trade.tradeSession)
          )
            throw new Error("INVALID_TRADE");
          return {
            timestamp,
            price,
            volume: String(trade.volume),
            tradeType: trade.tradeType,
            direction: trade.direction,
            tradeSession: trade.tradeSession,
          };
        });
        packets.push({
          symbol: event.symbol,
          receivedAt,
          providerSequence: null,
          trades,
        });
        tradeCount += trades.length;
      } catch {
        stop("TRADE_SOURCE_SAMPLE_INVALID");
      }
    });
    attempted = true; // Even a failed native subscription may have taken effect remotely.
    await withDeadline(() => {
      const pending = ctx.subscribe(symbols, [TRADE_SUBTYPE]);
      void pending.then(
        () => {
          if (disposing) void unsubscribe().catch(() => {});
        },
        () => {},
      );
      return pending;
    }, timeoutMs);
    if (!failure)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          endWait = undefined;
          resolve();
        }, durationMs);
        endWait = () => {
          clearTimeout(timer);
          endWait = undefined;
          resolve();
        };
      });
  } catch (error) {
    unsettled = error instanceof OperationTimeout;
    stop(unsettled ? "TRADE_SOURCE_TIMEOUT" : "TRADE_SOURCE_SUBSCRIBE_FAILED");
  } finally {
    disposing = true;
    active = false;
    endWait?.();
    try {
      ctx.setOnTrades(() => {});
    } catch {
      cleanupFailed = true;
    }
    if (attempted) {
      try {
        await unsubscribe();
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) failure ??= "TRADE_SOURCE_CLEANUP_FAILED";
  const completedAt = clock();
  if (!validAt(completedAt) || completedAt < startedAt)
    failure ??= "TRADE_SOURCE_SAMPLE_INVALID";
  return {
    status: failure ? "INCOMPLETE" : "SAMPLED",
    startedAt,
    completedAt: validAt(completedAt) ? completedAt : startedAt,
    packets,
    ...(failure ? { failure } : {}),
    cleanup: cleanupFailed ? "FAILED" : "COMPLETE",
    reusable: !unsettled && !cleanupFailed,
  };
}
