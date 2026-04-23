"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

export interface ApiPool {
  pool_address: string;
  token_mint: string;
  symbol: string | null;
  authority: string;
  vault: string;
  pool_bump: number;
  authority_bump: number;
  vault_bump: number;
  paused: boolean;
  total_deposits: string;
  total_borrows: string;
  accumulated_fees: string;
  ltv_wad: string | null;
  liquidation_threshold_wad: string | null;
  liquidation_bonus_wad: string | null;
  protocol_liq_fee_wad: string | null;
  reserve_factor_wad: string | null;
  close_factor_wad: string | null;
  base_rate_wad: string | null;
  optimal_util_wad: string | null;
  slope1_wad: string | null;
  slope2_wad: string | null;
  flash_fee_bps: number | null;
  oracle_price: string | null;
  oracle_conf: string | null;
  oracle_expo: number | null;
  pyth_price_feed: string | null;
  last_synced_at: string;
  created_at: string;
}

export interface PoolView {
  /** Stable id used in URLs / pool ops. Falls back to mint when no symbol. */
  id: string;
  symbol: string;
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  paused: boolean;
  totalDeposits: bigint;
  totalBorrows: bigint;
  accumulatedFees: bigint;
  ltvWad: bigint | null;
  liquidationThresholdWad: bigint | null;
  flashFeeBps: number | null;
  source: "api" | "fallback";
}

const FALLBACK_POOLS: PoolView[] = []; // empty by default — surface real pools only

function toView(p: ApiPool): PoolView {
  const symbol = p.symbol?.toUpperCase() || p.token_mint.slice(0, 4);
  return {
    id: symbol.toLowerCase(),
    symbol,
    poolAddress: new PublicKey(p.pool_address),
    tokenMint: new PublicKey(p.token_mint),
    authority: new PublicKey(p.authority),
    vault: new PublicKey(p.vault),
    paused: p.paused,
    totalDeposits: BigInt(p.total_deposits ?? "0"),
    totalBorrows: BigInt(p.total_borrows ?? "0"),
    accumulatedFees: BigInt(p.accumulated_fees ?? "0"),
    ltvWad: p.ltv_wad ? BigInt(p.ltv_wad) : null,
    liquidationThresholdWad: p.liquidation_threshold_wad ? BigInt(p.liquidation_threshold_wad) : null,
    flashFeeBps: p.flash_fee_bps,
    source: "api",
  };
}

export function usePools(): {
  pools: PoolView[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [pools, setPools] = useState<PoolView[]>(FALLBACK_POOLS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/pools", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { pools: ApiPool[] }) => {
        if (cancelled) return;
        const views = (data.pools ?? []).map(toView);
        setPools(views.length > 0 ? views : FALLBACK_POOLS);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);

  return { pools, loading, error, refresh: () => setTick((t) => t + 1) };
}
