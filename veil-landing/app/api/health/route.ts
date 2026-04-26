import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

type Check = { ok: boolean; ms: number; detail?: string };

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; detail?: string; result?: T }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - start, result };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const [db, rpc, counts] = await Promise.all([
    timed(async (): Promise<Check> => {
      const rows = await sql`SELECT 1 AS ok` as Array<{ ok: number }>;
      return { ok: rows[0]?.ok === 1, ms: 0 };
    }),
    timed(async () => {
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
      const conn = new Connection(rpcUrl, "confirmed");
      const slot = await conn.getSlot();
      return { slot };
    }),
    timed(async () => {
      const [pools, admins, txs] = await Promise.all([
        sql`SELECT count(*)::int AS n FROM pools`,
        sql`SELECT count(*)::int AS n FROM pool_admins WHERE revoked_at IS NULL`,
        sql`SELECT count(*)::int AS n FROM tx_log`,
      ]) as unknown as [Array<{ n: number }>, Array<{ n: number }>, Array<{ n: number }>];
      const lastSync = await sql`
        SELECT MAX(last_synced_at) AS ts FROM pools
      ` as unknown as Array<{ ts: string | null }>;
      return {
        pools: pools[0]?.n ?? 0,
        admins: admins[0]?.n ?? 0,
        transactions: txs[0]?.n ?? 0,
        last_pool_sync: lastSync[0]?.ts,
      };
    }),
  ]);

  const overall = db.ok && rpc.ok && counts.ok;
  const status = overall ? 200 : 503;

  return NextResponse.json({
    status: overall ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks: {
      database: { ok: db.ok, latency_ms: db.ms, detail: db.detail },
      rpc:      { ok: rpc.ok, latency_ms: rpc.ms, slot: rpc.result?.slot, detail: rpc.detail },
      counts:   { ok: counts.ok, latency_ms: counts.ms, ...(counts.result ?? {}), detail: counts.detail },
    },
  }, { status });
}
