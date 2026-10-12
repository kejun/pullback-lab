import type { Market } from "../../../packages/contracts/index";
import { normalizeUniverseSymbol } from "../../../packages/domain/universe-symbol";

export type ImportRow = { symbol: string; market: Market; name?: string };
export type PreviewRow = {
  line: number;
  input: string;
  value: ImportRow | null;
  status: "valid" | "existing" | "duplicate" | "error";
  message: string;
};

// A bounded, single-line CSV parser. Quoted names may contain commas.
function cells(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (!value.trim() && !closed) quoted = true;
      else throw new Error("引号位置无效，请检查 CSV 格式");
    } else if ((char === "," || char === "\t") && !quoted) {
      values.push(value.trim());
      value = "";
      closed = false;
    } else if (closed && char.trim()) {
      throw new Error("引号后的内容必须以逗号分隔");
    } else value += char;
  }
  if (quoted) throw new Error("名称的双引号未闭合");
  values.push(value.trim());
  return values;
}

export function previewUniverseImport(
  source: string,
  defaultMarket: Market,
  existingSymbols: ReadonlySet<string>,
): PreviewRow[] {
  const seen = new Map<string, number>();
  return source.split(/\r?\n/).flatMap((input, index): PreviewRow[] => {
    if (!input.trim()) return [];
    const line = index + 1;
    try {
      const parts = cells(input);
      let market = defaultMarket;
      if (parts[0]?.toUpperCase() === "US" || parts[0]?.toUpperCase() === "CN")
        market = parts.shift()!.toUpperCase() as Market;
      if (parts.length < 1 || parts.length > 2)
        throw new Error("每行填写代码、名称；混合市场时在最前面填写 US 或 CN");
      const symbol = normalizeUniverseSymbol(parts[0], market);
      const name = parts[1] || undefined;
      if (name && name.length > 100) throw new Error("名称不能超过 100 个字符");
      const key = `${market}:${symbol}`;
      const duplicate = seen.get(key);
      seen.set(key, duplicate ?? line);
      const status = duplicate
        ? "duplicate"
        : existingSymbols.has(key)
          ? "existing"
          : "valid";
      return [
        {
          line,
          input,
          value: { market, symbol, ...(name ? { name } : {}) },
          status,
          message: duplicate
            ? `与第 ${duplicate} 行重复，将跳过`
            : status === "existing"
              ? "已在观察列表，将保留原标签与笔记"
              : "待加入人工观察列表",
        },
      ];
    } catch (error) {
      return [
        {
          line,
          input,
          value: null,
          status: "error",
          message: error instanceof Error ? error.message : "格式无效",
        },
      ];
    }
  });
}
