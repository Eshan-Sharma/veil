// ─── Pool symbol metadata ───────────────────────────────────────────────────

type SymbolMeta = { icon: string; color: string };

const SYMBOL_MAP: Record<string, SymbolMeta> = {
  SOL:  { icon: "◎", color: "#7c3aed" },
  BTC:  { icon: "₿", color: "#f97316" },
  ETH:  { icon: "Ξ", color: "#6366f1" },
  XAU:  { icon: "◈", color: "#ca8a04" },
  USDC: { icon: "$", color: "#2563eb" },
  USDT: { icon: "₮", color: "#059669" },
};

const DEFAULT_META: SymbolMeta = { icon: "●", color: "#6b7280" };

export function getPoolMeta(symbol: string): SymbolMeta {
  return SYMBOL_MAP[symbol.toUpperCase()] ?? DEFAULT_META;
}

export function getPoolIcon(symbol: string): string {
  return getPoolMeta(symbol).icon;
}

export function getPoolColor(symbol: string): string {
  return getPoolMeta(symbol).color;
}

// ─── Pool type classification ───────────────────────────────────────────────

export type PoolType = "native" | "ika" | "oro" | "enc";

export function getPoolType(symbol: string): PoolType {
  const s = symbol.toUpperCase();
  if (s === "BTC" || s === "ETH") return "ika";
  if (s === "XAU") return "oro";
  if (s === "USDC" || s === "USDT") return "enc";

  return "native";
}
