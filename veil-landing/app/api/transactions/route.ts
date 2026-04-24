import { NextResponse } from "next/server";
import { sql, type TxLogRow } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet");
  const pool = searchParams.get("pool");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  let rows: TxLogRow[];
  if (wallet) {
    rows = await sql`
      SELECT * FROM tx_log
       WHERE wallet = ${wallet}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as TxLogRow[];
  } else if (pool) {
    rows = await sql`
      SELECT * FROM tx_log
       WHERE pool_address = ${pool}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as TxLogRow[];
  } else {
    rows = await sql`
      SELECT * FROM tx_log
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as TxLogRow[];
  }
  return NextResponse.json({ transactions: rows });
}

export async function POST(req: Request) {
  let body: {
    signature?: string; wallet?: string; action?: string;
    pool_address?: string; amount?: string | number; status?: string; error_msg?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { signature, wallet, action, pool_address, amount, status = "confirmed", error_msg } = body;
  if (!signature || !wallet || !action) {
    return NextResponse.json({ error: "signature, wallet, action required" }, { status: 400 });
  }
  await sql`
    INSERT INTO tx_log (signature, wallet, action, pool_address, amount, status, error_msg)
    VALUES (${signature}, ${wallet}, ${action}, ${pool_address ?? null},
            ${amount != null ? String(amount) : null}, ${status}, ${error_msg ?? null})
    ON CONFLICT (signature) DO UPDATE SET
      status = EXCLUDED.status,
      error_msg = EXCLUDED.error_msg
  `;
  return NextResponse.json({ ok: true });
}
