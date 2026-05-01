import { NextResponse } from "next/server";
import { sql, type PositionRow } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import { NETWORK } from "@/lib/network";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ user: string }> },
) {
  const limited = await rateLimit(req, { key: "positions.byuser", max: 120, windowSec: 60 });
  if (limited) return limited;

  const { user } = await ctx.params;
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  const rows = await sql`
    SELECT * FROM positions
     WHERE cluster = ${NETWORK} AND owner = ${user}
     ORDER BY last_synced_at DESC
  ` as PositionRow[];
  return NextResponse.json({ positions: rows });
}
