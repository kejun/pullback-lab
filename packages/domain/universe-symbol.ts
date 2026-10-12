import type { Market } from "../contracts/index.js";

export class UniverseSymbolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Shared preview/server normalization; CN exchanges are never guessed. */
export function normalizeUniverseSymbol(
  symbol: string,
  market: Market,
): string {
  const normalized = symbol.trim().toUpperCase();
  if (market === "CN") {
    if (!/^\d{6}\.(SH|SZ)$/.test(normalized))
      throw new UniverseSymbolError(
        "SYMBOL_MARKET_MISMATCH",
        "A 股须使用六位代码及 .SH 或 .SZ 后缀，不推测交易所",
      );
    return normalized;
  }
  if (/\.(SH|SZ|HK)$/.test(normalized))
    throw new UniverseSymbolError(
      "SYMBOL_MARKET_MISMATCH",
      "美股代码不能使用其他市场后缀",
    );
  const base = normalized.endsWith(".US")
    ? normalized.slice(0, -3)
    : normalized;
  if (
    !/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(base) ||
    /\.(US|SH|SZ|HK)$/.test(base) ||
    base.length > 29
  )
    throw new UniverseSymbolError(
      "INVALID_SYMBOL",
      "美股须使用有效代码，可省略 .US 后缀",
    );
  return `${base}.US`;
}
