import { NextResponse } from "next/server";
import { sql, type TxLogRow } from "@/lib/db";

export const runtime = "nodejs";

/* ── Valid actions (whitelist to prevent injection via string concat) ── */
const VALID_ACTIONS = new Set([
  "deposit", "withdraw", "borrow", "repay", "liquidate",
  "flash", "flash_borrow", "flash_repay",
  "init", "update_pool", "pause", "resume",
  "collect_fees", "update_oracle",
]);

/* ── Limits ── */
const DEFAULT_LIMIT = 200;  // initial cap — keeps first load fast
const MAX_LIMIT = 5000;     // hard ceiling even when `all=true`

/**
 * GET /api/transactions
 *
 * Filters (all optional, combinable):
 *   wallet  – base58 pubkey
 *   pool    – pool_address
 *   action  – one of VALID_ACTIONS (or comma-separated list)
 *   from    – ISO date / datetime lower bound (inclusive)
 *   to      – ISO date / datetime upper bound (inclusive)
 *
 * Pagination:
 *   limit   – page size (default 200, max 5000)
 *   offset  – skip N rows
 *   all     – if "true", raises limit to MAX_LIMIT (user explicitly wants everything)
 *
 * Response: { transactions, total, limit, offset, hasMore, capped }
 *   capped = true when total > limit on the first page without `all`, hinting
 *   the client to offer a "Load all" button.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet")?.trim() || null;
  const pool = searchParams.get("pool")?.trim() || null;
  const actionParam = searchParams.get("action")?.trim() || null;
  const from = searchParams.get("from")?.trim() || null;
  const to = searchParams.get("to")?.trim() || null;
  const fetchAll = searchParams.get("all") === "true";
  const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);

  let limit: number;
  if (fetchAll) {
    limit = MAX_LIMIT;
  } else {
    limit = Math.min(Math.max(Number(searchParams.get("limit") ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  }

  // Parse action filter — supports single action or comma-separated list
  let actions: string[] | null = null;
  if (actionParam) {
    actions = actionParam.split(",").map(a => a.trim().toLowerCase()).filter(a => VALID_ACTIONS.has(a));
    if (actions.length === 0) actions = null;
  }

  // ── Build dynamic query with numbered params ──
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (wallet) {
    conditions.push(`wallet = $${idx++}`);
    params.push(wallet);
  }
  if (pool) {
    conditions.push(`pool_address = $${idx++}`);
    params.push(pool);
  }
  if (actions && actions.length === 1) {
    conditions.push(`action = $${idx++}`);
    params.push(actions[0]);
  } else if (actions && actions.length > 1) {
    const placeholders = actions.map(() => `$${idx++}`).join(", ");
    conditions.push(`action IN (${placeholders})`);
    params.push(...actions);
  }
  if (from) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Use COUNT(*) OVER() window function — single query, no second round-trip.
  // When the result set is empty the window fn returns nothing, so we fall back to 0.
  const limitParam = `$${idx++}`;
  const offsetParam = `$${idx++}`;
  params.push(limit, offset);

  const query = `
    SELECT *, COUNT(*) OVER() AS _total
    FROM tx_log
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  type RowWithTotal = TxLogRow & { _total: number };

  const rows = await sql.query(query, params) as RowWithTotal[];

  const total = rows.length > 0 ? Number(rows[0]._total) : 0;
  const hasMore = offset + rows.length < total;

  // Strip internal _total field from response
  const transactions = rows.map(({ _total, ...row }) => row);

  // `capped` tells the client: "there are more rows than the default cap;
  // offer a Load All button". Only relevant on the first uncapped request.
  const capped = !fetchAll && offset === 0 && total > limit;

  return NextResponse.json({ transactions, total, limit, offset, hasMore, capped });
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
