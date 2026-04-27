/**
 * Pyth Hermes REST API price fetcher.
 *
 * Uses the v2 endpoint directly — no npm package dependency required.
 * Prices are returned as plain USD numbers (float).
 */

export type PythPrices = Record<string, number | null>;

/** Pyth price feed IDs for each Veil pool (hex, no 0x prefix internally). */
const FEED_IDS: Record<string, string> = {
  sol:  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  btc:  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  eth:  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  xau:  "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  usdc: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  usdt: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
};

const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";

type HermesEntry = {
  id: string;
  price: { price: string; expo: number };
};

export async function fetchPythPrices(): Promise<PythPrices> {
  const params = Object.values(FEED_IDS)
    .map((id) => `ids[]=${id}`)
    .join("&");

  const res = await fetch(`${HERMES}?${params}&parsed=true`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) throw new Error(`Pyth Hermes ${res.status}`);

  const json = await res.json();
  const entries: HermesEntry[] = json.parsed ?? [];

  const out: PythPrices = { usdc: 1.0 };

  for (const [poolId, feedId] of Object.entries(FEED_IDS)) {
    const entry = entries.find((e) => e.id === feedId);
    if (!entry) {
      out[poolId] = null;
      continue;
    }
    const raw = Number(entry.price.price);
    const exp = entry.price.expo;
    out[poolId] = raw * Math.pow(10, exp);
  }
  return out;
}

/** Format a live USD price for display. */
export function formatPrice(usd: number | null | undefined, fallback: string): string {
  if (usd == null) return fallback;
  if (usd >= 10_000) return `$${Math.round(usd).toLocaleString()}`;
  if (usd >= 1_000)  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (usd >= 1)      return `$${usd.toFixed(2)}`;

  return `$${usd.toFixed(4)}`;
}

/** Convert a bigint token amount to USD. Returns null when price is unavailable. */
export function tokenToUsd(
  amount: bigint,
  decimals: number,
  priceUsd: number | null | undefined,
): number | null {
  if (priceUsd == null || amount === 0n) return null;
  const divisor = 10 ** decimals;

  return (Number(amount) / divisor) * priceUsd;
}

/** Format a USD value for display — compact for large numbers, precise for small. */
export function formatUsd(usd: number | null | undefined, fallback = "—"): string {
  if (usd == null) return fallback;
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${Math.round(usd).toLocaleString()}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd > 0) return `$${usd.toFixed(4)}`;

  return "$0.00";
}
