import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import { NETWORK } from "@/lib/network";

export const runtime = "nodejs";

const WAD = BigInt("1000000000000000000");

function wadToPct(v: string | null): number {
  if (!v) return 0;

  return Number((BigInt(v) * 10000n) / WAD) / 100;
}

function computeBorrowRate(baseRate: number, slope1: number, slope2: number, optimalUtil: number, util: number): number {
  if (optimalUtil === 0) return baseRate;
  if (util <= optimalUtil) return baseRate + (slope1 * util) / optimalUtil;
  const denom = 100 - optimalUtil;
  if (denom <= 0) return baseRate + slope1;

  return baseRate + slope1 + (slope2 * (util - optimalUtil)) / denom;
}

/** Recompute health factor from current indices (matches on-chain formula). */
function computeHF(
  depositShares: bigint,
  supplyIndex: bigint,
  borrowPrincipal: bigint,
  borrowIndex: bigint,
  borrowIdxSnap: bigint,
  liqThresholdWad: bigint,
): string {
  const collateral = (depositShares * supplyIndex) / WAD;
  const debt = borrowIdxSnap > 0n ? (borrowPrincipal * borrowIndex) / borrowIdxSnap : 0n;
  if (debt === 0n) return WAD.toString();

  return ((collateral * liqThresholdWad) / debt).toString();
}

/**
 * Enriched position endpoint — joins positions + pools + tx_log.
 * Computes deposit token value, borrow debt, interest, and APYs server-side.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ user: string }> },
) {
  const limited = await rateLimit(req, { key: "positions.detail", max: 60, windowSec: 60 });
  if (limited) return limited;

  const { user } = await ctx.params;
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });

  const posRows = await sql`
    SELECT
      p.position_address,
      p.pool_address,
      p.owner,
      p.deposit_shares,
      p.borrow_principal,
      p.deposit_idx_snap,
      p.borrow_idx_snap,
      p.health_factor_wad,
      p.last_synced_at,
      pl.symbol,
      pl.decimals,
      pl.supply_index,
      pl.borrow_index,
      pl.total_deposits   AS pool_total_deposits,
      pl.total_borrows    AS pool_total_borrows,
      pl.ltv_wad          AS pool_ltv_wad,
      pl.liquidation_threshold_wad AS pool_liq_threshold_wad,
      pl.base_rate_wad    AS pool_base_rate_wad,
      pl.optimal_util_wad AS pool_optimal_util_wad,
      pl.slope1_wad       AS pool_slope1_wad,
      pl.slope2_wad       AS pool_slope2_wad,
      pl.reserve_factor_wad AS pool_reserve_factor_wad,
      pl.oracle_price,
      pl.oracle_expo
    FROM positions p
    JOIN pools pl ON pl.cluster = p.cluster AND pl.pool_address = p.pool_address
    WHERE p.cluster = ${NETWORK} AND p.owner = ${user}
    ORDER BY p.last_synced_at DESC
  `;

  const txRows = await sql`
    SELECT signature, pool_address, action, amount, status, created_at
    FROM tx_log
    WHERE cluster = ${NETWORK}
      AND wallet = ${user}
      AND status = 'confirmed'
    ORDER BY created_at DESC
    LIMIT 200
  `;

  const txByPool: Record<string, typeof txRows> = {};
  for (const tx of txRows) {
    const pool = tx.pool_address as string;
    if (!pool) continue;
    (txByPool[pool] ??= []).push(tx);
  }

  // ── Compute account-level (cross-collateral) health factor ───────────────
  // Mirrors Aave: HF = Σ(deposit_usd × liq_threshold) / Σ(debt_usd)
  let weightedCollateralUsd = 0n;
  let totalDebtUsd = 0n;

  for (const r of posRows) {
    const shares = BigInt(r.deposit_shares || "0");
    const principal = BigInt(r.borrow_principal || "0");
    const sIdx = BigInt(r.supply_index || WAD.toString());
    const bIdx = BigInt(r.borrow_index || WAD.toString());
    const bSnap = BigInt(r.borrow_idx_snap || WAD.toString());
    const liqT = BigInt(r.pool_liq_threshold_wad || WAD.toString());
    const decimals = Number(r.decimals ?? 9);
    const oraclePrice = BigInt(r.oracle_price ?? "0");
    const oracleExpo = Number(r.oracle_expo ?? -8);

    const depTokens = (shares * sIdx) / WAD;
    const debtTokens = bSnap > 0n ? (principal * bIdx) / bSnap : 0n;

    // tokenToUsdWad: amount × |price| × 10^(18 + expo - decimals)
    const scaleExp = 18 + oracleExpo - decimals;
    const factor = scaleExp >= 0 ? 10n ** BigInt(scaleExp) : 1n;
    const divisor = scaleExp < 0 ? 10n ** BigInt(-scaleExp) : 1n;
    const price = oraclePrice < 0n ? -oraclePrice : oraclePrice;

    const depUsd = scaleExp >= 0 ? depTokens * price * factor : (depTokens * price) / divisor;
    const debtUsd = scaleExp >= 0 ? debtTokens * price * factor : (debtTokens * price) / divisor;

    weightedCollateralUsd += (depUsd * liqT) / WAD;
    totalDebtUsd += debtUsd;
  }

  const accountHF = totalDebtUsd === 0n ? WAD : (weightedCollateralUsd * WAD) / totalDebtUsd;

  const positions = posRows.map((r) => {
    const depositShares = BigInt(r.deposit_shares || "0");
    const borrowPrincipal = BigInt(r.borrow_principal || "0");
    const supplyIndex = BigInt(r.supply_index || WAD.toString());
    const borrowIndex = BigInt(r.borrow_index || WAD.toString());
    const depositIdxSnap = BigInt(r.deposit_idx_snap || WAD.toString());
    const borrowIdxSnap = BigInt(r.borrow_idx_snap || WAD.toString());

    const depositTokens = (depositShares * supplyIndex) / WAD;
    const originalDeposit = (depositShares * depositIdxSnap) / WAD;
    const interestEarned = depositTokens > originalDeposit ? depositTokens - originalDeposit : 0n;

    const borrowDebt = borrowIdxSnap > 0n
      ? (borrowPrincipal * borrowIndex) / borrowIdxSnap
      : 0n;
    const interestOwed = borrowDebt > borrowPrincipal ? borrowDebt - borrowPrincipal : 0n;

    // Recompute health factor from current pool indices (not stale DB cache)
    const liqThresholdWad = BigInt(r.pool_liq_threshold_wad || WAD.toString());
    const freshHF = computeHF(depositShares, supplyIndex, borrowPrincipal, borrowIndex, borrowIdxSnap, liqThresholdWad);

    // Compute APYs from pool params
    const totalDep = BigInt(r.pool_total_deposits || "0");
    const totalBor = BigInt(r.pool_total_borrows || "0");
    const utilPct = totalDep > 0n ? Number(totalBor * 10000n / totalDep) / 100 : 0;

    const baseRate = wadToPct(r.pool_base_rate_wad as string | null);
    const slope1 = wadToPct(r.pool_slope1_wad as string | null);
    const slope2 = wadToPct(r.pool_slope2_wad as string | null);
    const optimalUtil = wadToPct(r.pool_optimal_util_wad as string | null) || 80;
    const reserveFactor = wadToPct(r.pool_reserve_factor_wad as string | null);

    const borrowApy = computeBorrowRate(baseRate, slope1, slope2, optimalUtil, utilPct);
    const supplyApy = borrowApy * (utilPct / 100) * (1 - reserveFactor / 100);

    const poolTxs = txByPool[r.pool_address as string] ?? [];
    const SUPPLY_ACTIONS = new Set(["deposit", "withdraw", "cross_withdraw"]);
    const BORROW_ACTIONS = new Set(["borrow", "repay", "cross_borrow", "cross_repay", "cross_liquidate", "liquidate"]);
    const supplyTxs = poolTxs.filter((t) => SUPPLY_ACTIONS.has(t.action as string));
    const borrowTxs = poolTxs.filter((t) => BORROW_ACTIONS.has(t.action as string));

    return {
      position_address: r.position_address,
      pool_address: r.pool_address,
      owner: r.owner,
      symbol: r.symbol,
      decimals: r.decimals ?? 9,
      health_factor_wad: freshHF,
      account_health_factor_wad: accountHF.toString(),
      last_synced_at: r.last_synced_at,
      deposit_shares: r.deposit_shares,
      borrow_principal: r.borrow_principal,
      deposit_tokens: depositTokens.toString(),
      original_deposit: originalDeposit.toString(),
      interest_earned: interestEarned.toString(),
      borrow_debt: borrowDebt.toString(),
      interest_owed: interestOwed.toString(),
      // Pool params
      pool_ltv_pct: wadToPct(r.pool_ltv_wad as string | null),
      pool_liq_threshold_pct: wadToPct(r.pool_liq_threshold_wad as string | null),
      supply_apy: Math.round(supplyApy * 100) / 100,
      borrow_apy: Math.round(borrowApy * 100) / 100,
      utilization_pct: Math.round(utilPct * 10) / 10,
      // Transactions
      supply_txs: supplyTxs.map((t) => ({
        signature: t.signature,
        action: t.action,
        amount: t.amount,
        created_at: t.created_at,
      })),
      borrow_txs: borrowTxs.map((t) => ({
        signature: t.signature,
        action: t.action,
        amount: t.amount,
        created_at: t.created_at,
      })),
    };
  });

  return NextResponse.json({ positions });
}
