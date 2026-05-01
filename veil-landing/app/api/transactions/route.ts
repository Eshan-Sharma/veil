import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { sql, type TxLogRow } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import { logSafe } from "@/lib/log";
import { NETWORK, serverRpcUrl } from "@/lib/network";

export const runtime = "nodejs";

/* ── Valid actions (whitelist to prevent injection via string concat) ── */
const VALID_ACTIONS = new Set([
  "deposit", "withdraw", "borrow", "repay", "liquidate",
  "cross_borrow", "cross_withdraw", "cross_repay", "cross_liquidate",
  "flash", "flash_borrow", "flash_repay",
  "init", "init_position", "update_pool", "pause", "resume",
  "collect_fees", "update_oracle", "set_pool_decimals",
]);

/* ── Limits ── */
const DEFAULT_LIMIT = 200;  // initial cap — keeps first load fast
const MAX_LIMIT = 5000;     // hard ceiling even when `all=true`

/** Coerce a query-string number with a fallback. `Number("abc")` → NaN, and
 *  NaN reaches PostgreSQL as "NaN" which raises an error or worse, so we
 *  always normalise here. */
function safeNum(v: string | null, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse an ISO date string. Returns null when invalid so callers can 400. */
function parseIsoDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/transactions
 *
 * Filters (all optional, combinable):
 *   wallet  – base58 pubkey
 *   pool    – pool_address
 *   action  – one of VALID_ACTIONS (or comma-separated list)
 *   from    – ISO date / datetime lower bound (inclusive)
 *   to      – ISO date / datetime upper bound (inclusive); must be >= from
 *
 * Pagination:
 *   limit   – page size (default 200, max 5000)
 *   offset  – skip N rows
 *   all     – if "true", raises limit to MAX_LIMIT (user explicitly wants everything)
 *
 * Response: { transactions, total, limit, offset, hasMore, capped }
 */
export async function GET(req: Request) {
  const limited = await rateLimit(req, { key: "transactions.get", max: 120, windowSec: 60 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet")?.trim() || null;
  const pool = searchParams.get("pool")?.trim() || null;
  const actionParam = searchParams.get("action")?.trim() || null;
  const fromRaw = searchParams.get("from")?.trim() || null;
  const toRaw = searchParams.get("to")?.trim() || null;
  const fetchAll = searchParams.get("all") === "true";

  const offset = Math.max(safeNum(searchParams.get("offset"), 0), 0);
  const limit = fetchAll
    ? MAX_LIMIT
    : Math.min(Math.max(safeNum(searchParams.get("limit"), DEFAULT_LIMIT), 1), MAX_LIMIT);

  // Validate date range. Mostly defends against typos in client code, but also
  // saves a round-trip when callers pass nonsense like `from=tomorrow`.
  const fromDate = parseIsoDate(fromRaw);
  const toDate = parseIsoDate(toRaw);
  if (fromRaw && !fromDate) return NextResponse.json({ error: "invalid 'from' date" }, { status: 400 });
  if (toRaw && !toDate) return NextResponse.json({ error: "invalid 'to' date" }, { status: 400 });
  if (fromDate && toDate && fromDate > toDate) {
    return NextResponse.json({ error: "'from' must be <= 'to'" }, { status: 400 });
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

  conditions.push(`cluster = $${idx++}`);
  params.push(NETWORK);

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
  if (fromDate) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(fromDate.toISOString());
  }
  if (toDate) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(toDate.toISOString());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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

  const transactions = rows.map(({ _total, ...row }) => row);

  const capped = !fetchAll && offset === 0 && total > limit;

  return NextResponse.json({ transactions, total, limit, offset, hasMore, capped });
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * POST /api/transactions — append-only optimistic record of a wallet-signed tx.
 *
 * NOTE: this endpoint is intentionally not authenticated; it serves as a UX
 * cache so wallets that confirm slowly still show the user their pending tx.
 * The trust model is "the wallet submitted this and we'll flip status to
 * confirmed/failed once the indexer catches up". To keep the cache from
 * becoming a propaganda channel we:
 *   - whitelist the action enum (no `liquidate-everyone`),
 *   - reject obviously malformed signature/wallet strings,
 *   - rate-limit per IP,
 *   - bound the amount field to 26 digits (u128 max ≈ 39 digits, but no
 *     legitimate single deposit comes anywhere close).
 *
 * The indexer keeper is the source of truth — it backfills/overwrites these
 * rows by signature. Anything in-flight is therefore a hint, not a fact.
 */
export async function POST(req: Request) {
  const limited = await rateLimit(req, { key: "transactions.post", max: 30, windowSec: 60 });
  if (limited) return limited;

  let body: {
    signature?: string; wallet?: string; action?: string;
    pool_address?: string; amount?: string | number; status?: string; error_msg?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { signature, wallet, action, pool_address, amount, status = "confirmed", error_msg } = body;

  if (!signature || !wallet || !action) {
    return NextResponse.json({ error: "signature, wallet, action required" }, { status: 400 });
  }
  // Solana signatures are 64-byte, base58-encoded → 64..88 chars in practice.
  // Accept the common range and reject anything else as a typo / injection.
  if (typeof signature !== "string" || signature.length < 64 || signature.length > 128 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }
  if (typeof wallet !== "string" || !BASE58_RE.test(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  if (pool_address != null && (typeof pool_address !== "string" || !BASE58_RE.test(pool_address))) {
    return NextResponse.json({ error: "invalid pool_address" }, { status: 400 });
  }
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  if (status !== "pending" && status !== "confirmed" && status !== "failed") {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  let amountStr: string | null = null;
  if (amount != null) {
    amountStr = String(amount);
    // Allow positive integers only — protocol amounts are always raw u64/u128.
    if (!/^\d{1,26}$/.test(amountStr)) {
      return NextResponse.json({ error: "invalid amount" }, { status: 400 });
    }
  }

  // ── On-chain signature verification ───────────────────────────────────────
  // For any non-pending record, require the signature to actually exist on the
  // chain. Without this, anyone can POST an arbitrary base58 string with a
  // chosen action and pollute the audit trail. Pending rows are allowed to
  // skip the check so wallets can optimistically post before the cluster has
  // propagated the tx.
  if (status !== "pending") {
    try {
      const conn = new Connection(serverRpcUrl(), "confirmed");
      const sigStatus = await conn.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      if (!sigStatus || !sigStatus.value) {
        return NextResponse.json(
          { error: "signature not found on-chain" },
          { status: 400 },
        );
      }
      // Confirm the wallet was actually a signer of this tx, otherwise an
      // attacker could attach someone else's signature to their own claim.
      const tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) {
        const signers = tx.transaction.message
          .getAccountKeys()
          .staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures)
          .map((k) => k.toBase58());
        if (!signers.includes(wallet)) {
          return NextResponse.json(
            { error: "wallet did not sign this transaction" },
            { status: 400 },
          );
        }
      }
    } catch (e) {
      logSafe("warn", "tx.sigverify_failed", { err: String(e) });
      return NextResponse.json(
        { error: "signature verification failed" },
        { status: 502 },
      );
    }
  }

  await sql`
    INSERT INTO tx_log (cluster, signature, wallet, action, pool_address, amount, status, error_msg)
    VALUES (${NETWORK}, ${signature}, ${wallet}, ${action}, ${pool_address ?? null},
            ${amountStr}, ${status}, ${error_msg ?? null})
    ON CONFLICT (cluster, signature) DO UPDATE SET
      status = EXCLUDED.status,
      error_msg = EXCLUDED.error_msg
  `;
  return NextResponse.json({ ok: true });
}
