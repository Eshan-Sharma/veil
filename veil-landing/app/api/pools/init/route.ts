import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { verifyAdminRequest } from "@/lib/auth/admin";
import { expectedOrigin } from "@/lib/auth/signature";

export const runtime = "nodejs";

/**
 * Records that an authorized admin successfully sent an Initialize transaction.
 * Authorization is enforced server-side: only wallets in `pool_admins` with role
 * `pool_admin` (or `super_admin`) can register a pool, and they must prove
 * ownership of the actor pubkey by signing a single-use nonce.
 */
export async function POST(req: Request) {
  let body: {
    actor?: string; nonce?: string; signature?: string;
    pool_address?: string; token_mint?: string; symbol?: string;
    authority?: string; vault?: string;
    pool_bump?: number; authority_bump?: number; vault_bump?: number;
    decimals?: number;
    init_signature?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const {
    actor, nonce, signature,
    pool_address, token_mint, symbol,
    authority, vault,
    pool_bump, authority_bump, vault_bump,
    decimals,
    init_signature,
  } = body;

  if (!actor || !nonce || !signature) return NextResponse.json({ error: "missing auth fields" }, { status: 400 });
  if (!pool_address || !token_mint || !authority || !vault) {
    return NextResponse.json({ error: "missing pool fields" }, { status: 400 });
  }

  const origin = expectedOrigin(req);
  if (!origin) return NextResponse.json({ error: "origin header required" }, { status: 400 });

  const auth = await verifyAdminRequest({
    pubkey: actor, nonce, signature,
    action: `init_pool:${token_mint}`,
    origin,
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  await sql`
    INSERT INTO pools (
      pool_address, token_mint, symbol, authority, vault,
      pool_bump, authority_bump, vault_bump, decimals,
      created_by, init_signature
    ) VALUES (
      ${pool_address}, ${token_mint}, ${symbol ?? null}, ${authority}, ${vault},
      ${pool_bump ?? 0}, ${authority_bump ?? 0}, ${vault_bump ?? 0}, ${decimals ?? 9},
      ${actor}, ${init_signature ?? null}
    )
    ON CONFLICT (pool_address) DO NOTHING
  `;
  await sql`
    INSERT INTO audit_log (actor, action, target, details)
    VALUES (${actor}, 'init_pool', ${pool_address},
            ${JSON.stringify({ token_mint, symbol, init_signature })}::jsonb)
  `;
  return NextResponse.json({ ok: true });
}
