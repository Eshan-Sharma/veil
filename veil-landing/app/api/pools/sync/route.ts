import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { sql } from "@/lib/db";
import { decodeLendingPool } from "@/lib/veil/state";
import { PROGRAM_ID } from "@/lib/veil/constants";
import { NETWORK, serverRpcUrl } from "@/lib/network";
import { rateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

/** Pulls a pool's on-chain state and upserts it into the DB cache.
 *  Public — anyone can call this — but the RPC endpoint is fixed to the
 *  server's trusted cluster URL (see C1 in SECURITY_AUDIT.md). The pool
 *  account must also be owned by VEIL's program ID before we'll cache it,
 *  otherwise the endpoint becomes a write-anywhere primitive (C2). */
export async function POST(req: Request) {
  const limited = await rateLimit(req, { key: "pools.sync", max: 30, windowSec: 60 });
  if (limited) return limited;

  let body: { pool_address?: string; symbol?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const poolAddr = body.pool_address;
  if (!poolAddr) return NextResponse.json({ error: "pool_address required" }, { status: 400 });

  let poolPk: PublicKey;
  try { poolPk = new PublicKey(poolAddr); }
  catch { return NextResponse.json({ error: "invalid pubkey" }, { status: 400 }); }

  const conn = new Connection(serverRpcUrl(), "confirmed");
  const info = await conn.getAccountInfo(poolPk);
  if (!info) return NextResponse.json({ error: "pool account not found" }, { status: 404 });

  // Refuse to cache state from accounts not owned by Veil — otherwise an
  // attacker could craft a fake program that returns a buffer matching
  // POOL_SIZE and poison the DB with chosen oracle prices / LTV ratios.
  if (!info.owner.equals(PROGRAM_ID)) {
    return NextResponse.json({ error: "account not owned by veil program" }, { status: 400 });
  }

  const p = decodeLendingPool(Buffer.from(info.data));
  const pythFeed = p.pythPriceFeed.toBase58();
  const hasOracle = pythFeed !== "11111111111111111111111111111111";
  await sql`
    INSERT INTO pools (
      cluster, pool_address, token_mint, symbol, authority, vault,
      pool_bump, authority_bump, vault_bump, paused,
      total_deposits, total_borrows, accumulated_fees,
      supply_index, borrow_index,
      ltv_wad, liquidation_threshold_wad, liquidation_bonus_wad, protocol_liq_fee_wad,
      reserve_factor_wad, close_factor_wad,
      base_rate_wad, optimal_util_wad, slope1_wad, slope2_wad,
      flash_fee_bps,
      oracle_price, oracle_conf, oracle_expo, pyth_price_feed,
      last_synced_at
    ) VALUES (
      ${NETWORK}, ${poolAddr}, ${p.tokenMint.toBase58()}, ${body.symbol ?? null},
      ${p.authority.toBase58()}, ${p.vault.toBase58()},
      ${p.poolBump}, ${p.authorityBump}, ${p.vaultBump},
      ${p.paused},
      ${p.totalDeposits.toString()}, ${p.totalBorrows.toString()}, ${p.accumulatedFees.toString()},
      ${p.supplyIndex.toString()}, ${p.borrowIndex.toString()},
      ${p.ltv.toString()}, ${p.liquidationThreshold.toString()}, ${p.liquidationBonus.toString()}, ${p.protocolLiqFee.toString()},
      ${p.reserveFactor.toString()}, ${p.closeFactor.toString()},
      ${p.baseRate.toString()}, ${p.optimalUtilization.toString()}, ${p.slope1.toString()}, ${p.slope2.toString()},
      ${Number(p.flashFeeBps)},
      ${p.oraclePrice.toString()}, ${p.oracleConf.toString()}, ${p.oracleExpo},
      ${hasOracle ? pythFeed : null},
      now()
    )
    ON CONFLICT (cluster, pool_address) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, pools.symbol),
      authority = EXCLUDED.authority,
      vault = EXCLUDED.vault,
      pool_bump = EXCLUDED.pool_bump,
      authority_bump = EXCLUDED.authority_bump,
      vault_bump = EXCLUDED.vault_bump,
      paused = EXCLUDED.paused,
      total_deposits = EXCLUDED.total_deposits,
      total_borrows = EXCLUDED.total_borrows,
      accumulated_fees = EXCLUDED.accumulated_fees,
      supply_index = EXCLUDED.supply_index,
      borrow_index = EXCLUDED.borrow_index,
      ltv_wad = EXCLUDED.ltv_wad,
      liquidation_threshold_wad = EXCLUDED.liquidation_threshold_wad,
      liquidation_bonus_wad = EXCLUDED.liquidation_bonus_wad,
      protocol_liq_fee_wad = EXCLUDED.protocol_liq_fee_wad,
      reserve_factor_wad = EXCLUDED.reserve_factor_wad,
      close_factor_wad = EXCLUDED.close_factor_wad,
      base_rate_wad = EXCLUDED.base_rate_wad,
      optimal_util_wad = EXCLUDED.optimal_util_wad,
      slope1_wad = EXCLUDED.slope1_wad,
      slope2_wad = EXCLUDED.slope2_wad,
      flash_fee_bps = EXCLUDED.flash_fee_bps,
      oracle_price = EXCLUDED.oracle_price,
      oracle_conf = EXCLUDED.oracle_conf,
      oracle_expo = EXCLUDED.oracle_expo,
      pyth_price_feed = EXCLUDED.pyth_price_feed,
      last_synced_at = now()
  `;
  return NextResponse.json({ ok: true, pool_address: poolAddr });
}
