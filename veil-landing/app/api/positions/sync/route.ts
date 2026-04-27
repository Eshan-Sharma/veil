import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { sql } from "@/lib/db";
import { decodeUserPosition, healthFactor } from "@/lib/veil/state";
import { decodeLendingPool } from "@/lib/veil/state";
import { findPositionAddress } from "@/lib/veil/pda";

export const runtime = "nodejs";

/** Syncs a user's position for a given pool from on-chain state into the DB. */
export async function POST(req: Request) {
  let body: { pool_address?: string; user?: string; rpc?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { pool_address, user } = body;
  if (!pool_address || !user) {
    return NextResponse.json({ error: "pool_address and user required" }, { status: 400 });
  }

  const rpc = typeof body.rpc === "string" && /^https?:\/\//.test(body.rpc)
    ? body.rpc
    : process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");

  let poolPk: PublicKey;
  let userPk: PublicKey;
  try {
    poolPk = new PublicKey(pool_address);
    userPk = new PublicKey(user);
  } catch { return NextResponse.json({ error: "invalid pubkey" }, { status: 400 }); }

  const [positionAddr] = findPositionAddress(poolPk, userPk);

  const [posInfo, poolInfo] = await Promise.all([
    conn.getAccountInfo(positionAddr),
    conn.getAccountInfo(poolPk),
  ]);

  if (!posInfo) {
    // Position doesn't exist on-chain — remove from DB if present
    await sql`DELETE FROM positions WHERE position_address = ${positionAddr.toBase58()}`;
    return NextResponse.json({ ok: true, exists: false });
  }
  if (!poolInfo) {
    return NextResponse.json({ error: "pool account not found" }, { status: 404 });
  }

  const pos = decodeUserPosition(Buffer.from(posInfo.data));
  const pool = decodeLendingPool(Buffer.from(poolInfo.data));
  const hf = healthFactor(
    pos.depositShares, pool.supplyIndex,
    pos.borrowPrincipal, pool.borrowIndex,
    pos.borrowIndexSnapshot, pool.liquidationThreshold,
  );

  await sql`
    INSERT INTO positions (
      position_address, pool_address, owner,
      deposit_shares, borrow_principal,
      deposit_idx_snap, borrow_idx_snap,
      health_factor_wad, last_synced_at
    ) VALUES (
      ${positionAddr.toBase58()}, ${pool_address}, ${user},
      ${pos.depositShares.toString()}, ${pos.borrowPrincipal.toString()},
      ${pos.depositIndexSnapshot.toString()}, ${pos.borrowIndexSnapshot.toString()},
      ${hf.toString()}, now()
    )
    ON CONFLICT (position_address) DO UPDATE SET
      deposit_shares = EXCLUDED.deposit_shares,
      borrow_principal = EXCLUDED.borrow_principal,
      deposit_idx_snap = EXCLUDED.deposit_idx_snap,
      borrow_idx_snap = EXCLUDED.borrow_idx_snap,
      health_factor_wad = EXCLUDED.health_factor_wad,
      last_synced_at = now()
  `;
  return NextResponse.json({ ok: true, exists: true, position_address: positionAddr.toBase58() });
}
