import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newNonce, buildAuthMessage, expectedOrigin } from "@/lib/auth/signature";
import { logSafe } from "@/lib/log";

export const runtime = "nodejs";

const TTL_SECONDS = 300;        // 5-minute single-use nonce
const RATE_LIMIT_WINDOW = 60;   // seconds
const RATE_LIMIT_PER_PUBKEY = 12;
const RATE_LIMIT_PER_IP     = 30;

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

async function exceedsRateLimit(bucket: string, max: number): Promise<boolean> {
  const rows = await sql`
    SELECT count(*)::int AS n
      FROM rate_limit
     WHERE bucket = ${bucket}
       AND ts > now() - make_interval(secs => ${RATE_LIMIT_WINDOW})
  ` as Array<{ n: number }>;

  return (rows[0]?.n ?? 0) >= max;
}

async function recordRequest(bucket: string) {
  await sql`INSERT INTO rate_limit (bucket) VALUES (${bucket})`;
}

export async function POST(req: Request) {
  let body: { pubkey?: string; action?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const pubkey = body.pubkey?.trim();
  const action = body.action?.trim();
  if (!pubkey || !action) return NextResponse.json({ error: "pubkey and action required" }, { status: 400 });
  if (pubkey.length < 32 || pubkey.length > 44) return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });

  const ip = clientIp(req);

  // ── Rate limit (per pubkey AND per IP) ─────────────────────────────────
  const [bypub, byip] = await Promise.all([
    exceedsRateLimit(`pubkey:${pubkey}`, RATE_LIMIT_PER_PUBKEY),
    exceedsRateLimit(`ip:${ip}`,         RATE_LIMIT_PER_IP),
  ]);
  if (bypub || byip) {
    logSafe("warn", "auth.nonce.rate_limited", { pubkey, ip, bypub, byip });
    return NextResponse.json({ error: "rate limited" }, {
      status: 429,
      headers: { "Retry-After": String(RATE_LIMIT_WINDOW) },
    });
  }

  // ── GC expired nonces and stale rate-limit windows ─────────────────────
  await sql`DELETE FROM auth_nonces WHERE expires_at < now()`;
  await sql`DELETE FROM rate_limit  WHERE ts < now() - make_interval(secs => ${RATE_LIMIT_WINDOW * 2})`;

  // ── Issue nonce ────────────────────────────────────────────────────────
  const nonce = newNonce();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
  const origin = expectedOrigin(req);

  await sql`
    INSERT INTO auth_nonces (pubkey, nonce, expires_at)
    VALUES (${pubkey}, ${nonce}, ${expiresAt.toISOString()})
  `;
  // Charge the rate-limit window for this request
  await Promise.all([
    recordRequest(`pubkey:${pubkey}`),
    recordRequest(`ip:${ip}`),
  ]);
  return NextResponse.json({
    nonce,
    message: buildAuthMessage(nonce, action, origin),
    origin,
    expiresAt: expiresAt.toISOString(),
  });
}
