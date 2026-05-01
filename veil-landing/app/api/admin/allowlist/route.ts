import { NextResponse } from "next/server";
import { sql, type AdminRow } from "@/lib/db";
import { verifyAdminRequest } from "@/lib/auth/admin";
import { expectedOrigin } from "@/lib/auth/signature";
import { rateLimit } from "@/lib/auth/rate-limit";
import { IS_MAINNET, NETWORK } from "@/lib/network";

export const runtime = "nodejs";

/**
 * GET /api/admin/allowlist
 *
 * Mirrors what Aave's ACLManager exposes on-chain: admin pubkeys and roles
 * are public, since they're already discoverable via program logs / state.
 * Operational metadata (`label`, `added_by`, timestamps) is sensitive — it
 * leaks rotation patterns and human-attributable names — so on mainnet we
 * gate that behind an authenticated admin request via `x-veil-*` headers.
 *
 * On devnet/localnet the full record is returned to keep ops debugging easy.
 */
export async function GET(req: Request) {
  const limited = await rateLimit(req, { key: "admin.allowlist", max: 60, windowSec: 60 });
  if (limited) return limited;

  let isAdmin = false;
  if (IS_MAINNET) {
    const origin = expectedOrigin(req);
    const actor = req.headers.get("x-veil-actor");
    const nonce = req.headers.get("x-veil-nonce");
    const signature = req.headers.get("x-veil-signature");
    if (origin && actor && nonce && signature) {
      const auth = await verifyAdminRequest({
        pubkey: actor, nonce, signature, action: "allowlist:read", origin,
      });
      if (auth.ok) isAdmin = true;
    }
  }

  const rows = await sql`
    SELECT pubkey, role, label, added_by, created_at, revoked_at
      FROM pool_admins
     WHERE revoked_at IS NULL
     ORDER BY created_at ASC
  ` as AdminRow[];

  if (IS_MAINNET && !isAdmin) {
    // Strip metadata that an unauthenticated caller doesn't need.
    const redacted = rows.map((r) => ({ pubkey: r.pubkey, role: r.role }));
    return NextResponse.json({ admins: redacted, redacted: true });
  }
  return NextResponse.json({ admins: rows });
}

export async function POST(req: Request) {
  let body: {
    actor?: string; nonce?: string; signature?: string;
    pubkey?: string; role?: string; label?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { actor, nonce, signature, pubkey, role = "pool_admin", label } = body;
  if (!actor || !nonce || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (role !== "pool_admin" && role !== "super_admin") {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }
  const origin = expectedOrigin(req);
  if (!origin) return NextResponse.json({ error: "origin header required" }, { status: 400 });

  const auth = await verifyAdminRequest({
    pubkey: actor, nonce, signature,
    action: `add_admin:${pubkey}:${role}`,
    origin,
    requireRole: "super_admin",
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  await sql`
    INSERT INTO pool_admins (pubkey, role, label, added_by)
    VALUES (${pubkey}, ${role}, ${label ?? null}, ${actor})
    ON CONFLICT (pubkey) DO UPDATE
      SET role = EXCLUDED.role,
          label = EXCLUDED.label,
          revoked_at = NULL
  `;
  await sql`
    INSERT INTO audit_log (cluster, actor, action, target, details)
    VALUES (${NETWORK}, ${actor}, 'add_admin', ${pubkey}, ${JSON.stringify({ role, label })}::jsonb)
  `;
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  let body: { actor?: string; nonce?: string; signature?: string; pubkey?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { actor, nonce, signature, pubkey } = body;
  if (!actor || !nonce || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (actor === pubkey) {
    return NextResponse.json({ error: "cannot revoke yourself" }, { status: 400 });
  }
  const origin = expectedOrigin(req);
  if (!origin) return NextResponse.json({ error: "origin header required" }, { status: 400 });

  const auth = await verifyAdminRequest({
    pubkey: actor, nonce, signature,
    action: `revoke_admin:${pubkey}`,
    origin,
    requireRole: "super_admin",
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  await sql`UPDATE pool_admins SET revoked_at = now() WHERE pubkey = ${pubkey}`;
  await sql`
    INSERT INTO audit_log (cluster, actor, action, target, details)
    VALUES (${NETWORK}, ${actor}, 'revoke_admin', ${pubkey}, '{}'::jsonb)
  `;
  return NextResponse.json({ ok: true });
}
