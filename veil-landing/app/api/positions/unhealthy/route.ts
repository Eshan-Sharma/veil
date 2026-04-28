import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

const WAD = BigInt("1000000000000000000");

/**
 * Return positions whose **account-level** (cross-collateral) health factor
 * is below 1.0 WAD — i.e., the owner is liquidatable.
 *
 * Account HF = Σ(deposit_usd × liq_threshold) / Σ(debt_usd)
 * This mirrors Aave: a user can borrow from pool A using collateral in pool B,
 * so per-pool HF is meaningless. We compute account HF across all positions.
 */
export async function GET(req: Request) {
  const limited = await rateLimit(req, { key: "positions.unhealthy", max: 60, windowSec: 60 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const poolFilter = searchParams.get("pool");
  const rawLimit = Number(searchParams.get("limit") ?? 50);
  const limit = Math.min(Number.isFinite(rawLimit) ? Math.max(rawLimit, 1) : 50, 200);

  // Fetch ALL positions that have borrows, joined with pool data for HF calc
  const rows = await sql`
    SELECT
      p.position_address,
      p.pool_address,
      p.owner,
      p.deposit_shares,
      p.borrow_principal,
      p.borrow_idx_snap,
      pl.supply_index,
      pl.borrow_index,
      pl.liquidation_threshold_wad,
      pl.oracle_price,
      pl.oracle_expo,
      pl.decimals
    FROM positions p
    JOIN pools pl ON pl.pool_address = p.pool_address
    WHERE p.borrow_principal > 0 OR p.deposit_shares > 0
  `;

  // Group by owner, compute account-level HF
  const byOwner: Record<string, typeof rows> = {};
  for (const r of rows) {
    const owner = r.owner as string;
    (byOwner[owner] ??= []).push(r);
  }

  type Result = {
    position_address: string;
    pool_address: string;
    owner: string;
    deposit_shares: string;
    borrow_principal: string;
    health_factor_wad: string;
    account_health_factor_wad: string;
  };

  const unhealthy: Result[] = [];

  for (const [owner, positions] of Object.entries(byOwner)) {
    let weightedCollateralUsd = 0n;
    let totalDebtUsd = 0n;

    for (const r of positions) {
      const shares = BigInt(r.deposit_shares || "0");
      const principal = BigInt(r.borrow_principal || "0");
      const sIdx = BigInt(r.supply_index || WAD.toString());
      const bIdx = BigInt(r.borrow_index || WAD.toString());
      const bSnap = BigInt(r.borrow_idx_snap || WAD.toString());
      const liqT = BigInt(r.liquidation_threshold_wad || WAD.toString());
      const decimals = Number(r.decimals ?? 9);
      const oraclePrice = BigInt(r.oracle_price ?? "0");
      const oracleExpo = Number(r.oracle_expo ?? -8);

      const depTokens = (shares * sIdx) / WAD;
      const debtTokens = bSnap > 0n ? (principal * bIdx) / bSnap : 0n;

      const price = oraclePrice < 0n ? -oraclePrice : oraclePrice;
      const scaleExp = 18 + oracleExpo - decimals;
      const factor = scaleExp >= 0 ? 10n ** BigInt(scaleExp) : 1n;
      const divisor = scaleExp < 0 ? 10n ** BigInt(-scaleExp) : 1n;

      const depUsd = scaleExp >= 0 ? depTokens * price * factor : (depTokens * price) / divisor;
      const debtUsd = scaleExp >= 0 ? debtTokens * price * factor : (debtTokens * price) / divisor;

      weightedCollateralUsd += (depUsd * liqT) / WAD;
      totalDebtUsd += debtUsd;
    }

    if (totalDebtUsd === 0n) continue;

    const accountHF = (weightedCollateralUsd * WAD) / totalDebtUsd;
    if (accountHF >= WAD) continue; // healthy — skip

    // This owner is underwater — include their borrow positions
    for (const r of positions) {
      const principal = BigInt(r.borrow_principal || "0");
      if (principal === 0n && poolFilter) continue; // skip deposit-only if filtering by pool
      if (poolFilter && r.pool_address !== poolFilter) continue;

      unhealthy.push({
        position_address: r.position_address as string,
        pool_address: r.pool_address as string,
        owner,
        deposit_shares: (r.deposit_shares ?? "0").toString(),
        borrow_principal: (r.borrow_principal ?? "0").toString(),
        health_factor_wad: accountHF.toString(),
        account_health_factor_wad: accountHF.toString(),
      });
    }
  }

  // Sort by account HF ascending (most underwater first), limit results
  unhealthy.sort((a, b) => {
    const ha = BigInt(a.account_health_factor_wad);
    const hb = BigInt(b.account_health_factor_wad);
    if (ha < hb) return -1;
    if (ha > hb) return 1;
    return 0;
  });

  return NextResponse.json({ positions: unhealthy.slice(0, limit) });
}
