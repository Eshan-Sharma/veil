import { NextResponse } from "next/server";
import { sql, type AdminRow } from "@/lib/db";
import { verifyAdminRequest } from "@/lib/auth/admin";
import { expectedOrigin } from "@/lib/auth/signature";

export const runtime = "nodejs";

export async function GET() {
  const rows = await sql`
    SELECT pubkey, role, label, added_by, created_at, revoked_at
      FROM pool_admins
     WHERE revoked_at IS NULL
     ORDER BY created_at ASC
  ` as AdminRow[];
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

  const auth = await verifyAdminRequest({
    pubkey: actor, nonce, signature,
    action: `add_admin:${pubkey}:${role}`,
    origin: expectedOrigin(req),
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
    INSERT INTO audit_log (actor, action, target, details)
    VALUES (${actor}, 'add_admin', ${pubkey}, ${JSON.stringify({ role, label })}::jsonb)
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
  const auth = await verifyAdminRequest({
    pubkey: actor, nonce, signature,
    action: `revoke_admin:${pubkey}`,
    origin: expectedOrigin(req),
    requireRole: "super_admin",
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  await sql`UPDATE pool_admins SET revoked_at = now() WHERE pubkey = ${pubkey}`;
  await sql`
    INSERT INTO audit_log (actor, action, target, details)
    VALUES (${actor}, 'revoke_admin', ${pubkey}, '{}'::jsonb)
  `;
  return NextResponse.json({ ok: true });
}
