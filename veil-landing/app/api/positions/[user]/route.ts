import { NextResponse } from "next/server";
import { sql, type PositionRow } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ user: string }> },
) {
  const { user } = await ctx.params;
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  const rows = await sql`
    SELECT * FROM positions
     WHERE owner = ${user}
     ORDER BY last_synced_at DESC
  ` as PositionRow[];
  return NextResponse.json({ positions: rows });
}
