import { sql, type AdminRole } from "@/lib/db";
import { buildAuthMessage, verifyEd25519Signature } from "./signature";

export type AdminAuthResult = {
  ok: boolean;
  role?: AdminRole;
  error?: string;
};

/**
 * Verify an authenticated admin request:
 *
 *   1. The signature over `buildAuthMessage(nonce, action, origin)` is valid for `pubkey`.
 *   2. The nonce was issued to this pubkey, has not expired, and is consumed (single-use).
 *   3. The pubkey is in `pool_admins` with the required role (and not revoked).
 *
 * Steps 2 and 3 are performed in a single SQL statement (CTE + DELETE … WHERE EXISTS)
 * to close the time-of-check / time-of-use window between consume and role read.
 *
 * On success returns the admin's role. On failure returns ok=false with a redacted reason.
 */
export async function verifyAdminRequest(params: {
  pubkey: string;
  nonce: string;
  signature: string;
  action: string;
  origin: string;
  requireRole?: AdminRole;
}): Promise<AdminAuthResult> {
  const { pubkey, nonce, signature, action, origin, requireRole } = params;
  if (!pubkey || !nonce || !signature || !action || !origin) {
    return { ok: false, error: "missing fields" };
  }

  // 1. Signature
  const message = buildAuthMessage(nonce, action, origin);
  if (!verifyEd25519Signature(pubkey, message, signature)) {
    return { ok: false, error: "bad signature" };
  }

  // 2 + 3 atomically: consume the nonce IFF the actor is an active admin
  //                   meeting the required role. If the role check fails, the
  //                   nonce is NOT consumed — the requester can retry from step 1
  //                   after being granted privilege.
  const minRole = requireRole ?? "pool_admin";
  const rows = await sql`
    WITH role_check AS (
      SELECT role
        FROM pool_admins
       WHERE pubkey = ${pubkey}
         AND revoked_at IS NULL
         AND (
           ${minRole}::text = 'pool_admin'
           OR (${minRole}::text = 'super_admin' AND role = 'super_admin')
         )
    ),
    consumed AS (
      DELETE FROM auth_nonces
       WHERE pubkey = ${pubkey}
         AND nonce  = ${nonce}
         AND expires_at > now()
         AND EXISTS (SELECT 1 FROM role_check)
       RETURNING nonce
    )
    SELECT
      (SELECT role FROM role_check) AS role,
      (SELECT count(*)::int FROM consumed) AS consumed_count
  ` as Array<{ role: AdminRole | null; consumed_count: number }>;

  const row = rows[0];
  if (!row || !row.role) {
    return { ok: false, error: requireRole === "super_admin" ? "super_admin required" : "not authorized" };
  }
  if (row.consumed_count === 0) {
    // Either nonce missing/expired, or the EXISTS guard rejected it (role insufficient).
    // Distinguish: re-check whether nonce row exists at all.
    const noncesLeft = await sql`
      SELECT 1 FROM auth_nonces WHERE pubkey = ${pubkey} AND nonce = ${nonce} LIMIT 1
    ` as Array<{ "?column?": number }>;
    return { ok: false, error: noncesLeft.length === 0 ? "nonce invalid or expired" : "not authorized" };
  }
  return { ok: true, role: row.role };
}
