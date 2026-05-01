import { NextResponse } from "next/server";
import { sql, type PoolRow } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import { NETWORK } from "@/lib/network";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const limited = await rateLimit(req, { key: "pools.get", max: 120, windowSec: 60 });
  if (limited) return limited;

  const rows = await sql`
    SELECT * FROM pools
     WHERE cluster = ${NETWORK}
     ORDER BY created_at DESC
  ` as PoolRow[];
  return NextResponse.json({ pools: rows });
}
