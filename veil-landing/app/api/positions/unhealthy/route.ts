import { NextResponse } from "next/server";
import { sql, type PositionRow } from "@/lib/db";

export const runtime = "nodejs";

const WAD = "1000000000000000000"; // u128 WAD threshold; positions with HF < WAD are liquidatable

/**
 * Return the indexer-cached positions whose health factor is below 1.0 WAD —
 * i.e., currently liquidatable. Sorted ascending by HF (most underwater first).
 *
 * The indexer (`scripts/indexer.ts`) populates `positions.health_factor_wad`
 * by subscribing to UserPosition account changes and recomputing HF against
 * the latest pool state. Without the indexer running this returns an empty
 * list — that's the operational expectation, not a bug.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const pool = searchParams.get("pool");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  let rows: PositionRow[];
  if (pool) {
    rows = await sql`
      SELECT * FROM positions
       WHERE borrow_principal > 0
         AND health_factor_wad IS NOT NULL
         AND health_factor_wad::numeric < ${WAD}::numeric
         AND pool_address = ${pool}
       ORDER BY health_factor_wad::numeric ASC
       LIMIT ${limit}
    ` as PositionRow[];
  } else {
    rows = await sql`
      SELECT * FROM positions
       WHERE borrow_principal > 0
         AND health_factor_wad IS NOT NULL
         AND health_factor_wad::numeric < ${WAD}::numeric
       ORDER BY health_factor_wad::numeric ASC
       LIMIT ${limit}
    ` as PositionRow[];
  }
  return NextResponse.json({ positions: rows });
}
