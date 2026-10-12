import { normalizeUniverseSymbol } from "../domain/universe-symbol.js";

/** Explicit, bounded opt-in. Configuration alone never adds a research instrument. */
export function parseMinuteSymbols(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const invalid = () => new Error("INVALID_MINUTE_SYMBOLS");
  if (value.length > 512) throw invalid();
  const symbols = value.split(",").map((part) => part.trim().toUpperCase());
  if (symbols.length > 10) throw invalid();
  try {
    for (const symbol of symbols) {
      if (!/\.(US|SH|SZ)$/.test(symbol) || symbol.startsWith("DEMO-"))
        throw invalid();
      if (
        normalizeUniverseSymbol(
          symbol,
          symbol.endsWith(".US") ? "US" : "CN",
        ) !== symbol
      )
        throw invalid();
    }
  } catch {
    throw invalid();
  }
  if (new Set(symbols).size !== symbols.length) throw invalid();
  return symbols.sort();
}
