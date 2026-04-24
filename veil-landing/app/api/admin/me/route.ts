import { NextResponse } from "next/server";
import { sql, type AdminRole } from "@/lib/db";

export const runtime = "nodejs";

/** Read-only: tells the UI what role (if any) a pubkey holds. Used purely for UX gating;
 *  authoritative checks happen server-side on every write endpoint via signed nonce. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const pubkey = searchParams.get("pubkey");
  if (!pubkey) return NextResponse.json({ role: null });
  const rows = await sql`
    SELECT role FROM pool_admins
     WHERE pubkey = ${pubkey} AND revoked_at IS NULL
     LIMIT 1
  ` as Array<{ role: AdminRole }>;
  return NextResponse.json({ role: rows[0]?.role ?? null });
}
