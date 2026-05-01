import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import { verifyAdminRequest } from "@/lib/auth/admin";
import { expectedOrigin } from "@/lib/auth/signature";
import { IS_MAINNET, NETWORK } from "@/lib/network";

export const runtime = "nodejs";

type AuditRow = {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  details: unknown;
  created_at: string;
};

/**
 * Public read of the admin audit log on devnet/localnet — useful for
 * transparency and ops debugging in non-production. On mainnet the log can
 * leak admin rotation patterns and addresses, so we require a signed admin
 * request (auth params come via headers to keep GET semantics).
 *
 * Auth headers (mainnet only):
 *   x-veil-actor       — admin pubkey
 *   x-veil-nonce       — nonce from /api/auth/nonce (action="audit:read")
 *   x-veil-signature   — base58 ed25519 signature
 */
export async function GET(req: Request) {
  const limited = await rateLimit(req, { key: "admin.audit", max: 30, windowSec: 60 });
  if (limited) return limited;

  if (IS_MAINNET) {
    const origin = expectedOrigin(req);
    if (!origin) return NextResponse.json({ error: "origin header required" }, { status: 400 });
    const actor = req.headers.get("x-veil-actor");
    const nonce = req.headers.get("x-veil-nonce");
    const signature = req.headers.get("x-veil-signature");
    if (!actor || !nonce || !signature) {
      return NextResponse.json({ error: "admin auth required" }, { status: 401 });
    }
    const auth = await verifyAdminRequest({
      pubkey: actor, nonce, signature, action: "audit:read", origin,
    });
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const actor = searchParams.get("actor");
  const action = searchParams.get("action");
  const rawLimit = Number(searchParams.get("limit") ?? 50);
  const limit = Math.min(Number.isFinite(rawLimit) ? Math.max(rawLimit, 1) : 50, 500);

  let rows: AuditRow[];
  if (actor && action) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE cluster = ${NETWORK} AND actor = ${actor} AND action = ${action}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else if (actor) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE cluster = ${NETWORK} AND actor = ${actor}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else if (action) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE cluster = ${NETWORK} AND action = ${action}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE cluster = ${NETWORK}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  }
  return NextResponse.json({ entries: rows });
}
