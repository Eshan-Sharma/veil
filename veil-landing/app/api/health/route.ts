import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { sql } from "@/lib/db";
import { logSafe } from "@/lib/log";
import { NETWORK, serverRpcUrl } from "@/lib/network";

export const runtime = "nodejs";

type Check = { ok: boolean; ms: number; detail?: string };

async function timed<T>(fn: () => Promise<T>, tag: string): Promise<{ ok: boolean; ms: number; detail?: string; result?: T }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - start, result };
  } catch (e) {
    logSafe("warn", `health.${tag}.failed`, { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, ms: Date.now() - start, detail: "check failed" };
  }
}

export async function GET() {
  const [db, rpc, counts] = await Promise.all([
    timed(async (): Promise<Check> => {
      const rows = await sql`SELECT 1 AS ok` as Array<{ ok: number }>;
      return { ok: rows[0]?.ok === 1, ms: 0 };
    }, "db"),
    timed(async () => {
      const conn = new Connection(serverRpcUrl(), "confirmed");
      const slot = await conn.getSlot();
      return { slot };
    }, "rpc"),
    timed(async () => {
      const [pools, admins, txs] = await Promise.all([
        sql`SELECT count(*)::int AS n FROM pools WHERE cluster = ${NETWORK}`,
        sql`SELECT count(*)::int AS n FROM pool_admins WHERE revoked_at IS NULL`,
        sql`SELECT count(*)::int AS n FROM tx_log WHERE cluster = ${NETWORK}`,
      ]) as unknown as [Array<{ n: number }>, Array<{ n: number }>, Array<{ n: number }>];
      const lastSync = await sql`
        SELECT MAX(last_synced_at) AS ts FROM pools WHERE cluster = ${NETWORK}
      ` as unknown as Array<{ ts: string | null }>;
      return {
        pools: pools[0]?.n ?? 0,
        admins: admins[0]?.n ?? 0,
        transactions: txs[0]?.n ?? 0,
        last_pool_sync: lastSync[0]?.ts,
      };
    }, "counts"),
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
