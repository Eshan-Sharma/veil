"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeLendingPool, decodeUserPosition, sharesToTokens, borrowDebt, healthFactor, accountHealthFactor } from "@/lib/veil/state";
import type { CrossHFInput } from "@/lib/veil/state";
import { findPositionAddress } from "@/lib/veil/pda";

export type ChainPositionUpdate = {
  position_address: string;
  pool_address: string;
  deposit_shares: string;
  deposit_tokens: string;
  borrow_principal: string;
  borrow_debt: string;
  health_factor_wad: string;
  /** Account-level HF across all positions (Aave-style). Same value on every entry. */
  account_health_factor_wad: string;
};

/**
 * Polls on-chain pool + position accounts directly and returns fresh financial data.
 * Bypasses the DB entirely — source of truth is the chain.
 * Runs every `intervalMs` (default 10s).
 */
export function useChainPolling(
  endpoint: string,
  userKey: PublicKey | null,
  poolAddresses: string[],
  intervalMs = 10_000,
): ChainPositionUpdate[] {
  const [updates, setUpdates] = useState<ChainPositionUpdate[]>([]);
  // Stable ref for the address list to avoid re-triggering on array identity changes
  const poolsKey = poolAddresses.join(",");

  const poll = useCallback(async () => {
    if (!userKey || poolAddresses.length === 0) return;

    const conn = new Connection(endpoint, "confirmed");

    // Build account keys: for each pool, fetch [pool, user_position]
    const keys: PublicKey[] = [];
    const poolPks: PublicKey[] = [];
    for (const addr of poolAddresses) {
      const poolPk = new PublicKey(addr);
      const [posPk] = findPositionAddress(poolPk, userKey);
      poolPks.push(poolPk);
      keys.push(poolPk, posPk);
    }

    try {
      // Single RPC call for all accounts
      const infos = await conn.getMultipleAccountsInfo(keys);

      // First pass: decode all pools + positions, collect cross-HF inputs
      const decoded: { pool: ReturnType<typeof decodeLendingPool>; pos: ReturnType<typeof decodeUserPosition>; idx: number }[] = [];
      const crossInputs: CrossHFInput[] = [];

      for (let i = 0; i < poolAddresses.length; i++) {
        const poolInfo = infos[i * 2];
        const posInfo = infos[i * 2 + 1];
        if (!poolInfo || !posInfo) continue;

        const pool = decodeLendingPool(new Uint8Array(poolInfo.data));
        const pos = decodeUserPosition(new Uint8Array(posInfo.data));
        decoded.push({ pool, pos, idx: i });

        crossInputs.push({
          depositShares: pos.depositShares,
          borrowPrincipal: pos.borrowPrincipal,
          supplyIndex: pool.supplyIndex,
          borrowIndex: pool.borrowIndex,
          borrowIndexSnapshot: pos.borrowIndexSnapshot,
          liquidationThreshold: pool.liquidationThreshold,
          oraclePrice: pool.oraclePrice,
          oracleExpo: pool.oracleExpo,
          tokenDecimals: pool.tokenDecimals,
        });
      }

      // Compute account-level HF once across all positions
      const acctHF = accountHealthFactor(crossInputs);

      // Second pass: build results with both per-pool and account HF
      const results: ChainPositionUpdate[] = [];
      for (const { pool, pos, idx } of decoded) {
        const depTokens = sharesToTokens(pos.depositShares, pool.supplyIndex);
        const debt = borrowDebt(pos.borrowPrincipal, pool.borrowIndex, pos.borrowIndexSnapshot);
        const hf = healthFactor(
          pos.depositShares, pool.supplyIndex,
          pos.borrowPrincipal, pool.borrowIndex,
          pos.borrowIndexSnapshot, pool.liquidationThreshold,
        );

        results.push({
          position_address: findPositionAddress(poolPks[idx], userKey)[0].toBase58(),
          pool_address: poolAddresses[idx],
          deposit_shares: pos.depositShares.toString(),
          deposit_tokens: depTokens.toString(),
          borrow_principal: pos.borrowPrincipal.toString(),
          borrow_debt: debt.toString(),
          health_factor_wad: hf.toString(),
          account_health_factor_wad: acctHF.toString(),
        });
      }

      setUpdates(results);
    } catch (err) {
      console.warn("[veil] chain polling error:", err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, userKey?.toBase58(), poolsKey]);

  useEffect(() => {
    if (!userKey || poolAddresses.length === 0) return;
    // Poll immediately on mount, then on interval
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, intervalMs]);

  return updates;
}
