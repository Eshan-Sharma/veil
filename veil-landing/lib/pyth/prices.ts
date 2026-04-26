/**
 * Pyth Hermes REST API price fetcher.
 *
 * Uses the v2 endpoint directly — no npm package dependency required.
 * Prices are returned as plain USD numbers (float).
 */

export type PythPrices = Record<string, number | null>;

/** Pyth price feed IDs for each Veil pool (hex, no 0x prefix internally). */
const FEED_IDS: Record<string, string> = {
  sol: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  btc: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  eth: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  xau: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
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

/** Format a live USD price for display (mirrors the hardcoded strings in POOLS). */
export function formatPrice(usd: number | null | undefined, fallback: string): string {
  if (usd == null) return fallback;
  if (usd >= 10_000) return `$${Math.round(usd).toLocaleString()}`;
  if (usd >= 1_000)  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (usd >= 1)      return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}
