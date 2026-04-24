import { NextResponse } from "next/server";
import { sql, type PoolRow } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await sql`
    SELECT * FROM pools
     ORDER BY created_at DESC
  ` as PoolRow[];
  return NextResponse.json({ pools: rows });
}
