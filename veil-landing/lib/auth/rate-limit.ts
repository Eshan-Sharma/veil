import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

/**
 * Identify the requesting client. Trust order:
 *
 *  1. `x-vercel-forwarded-for` — set by Vercel's edge after stripping the
 *     incoming request's own `x-forwarded-for`, so an attacker cannot spoof it.
 *  2. `x-forwarded-for` — accepted only if Vercel's header is absent
 *     (e.g. local dev). Takes the FIRST hop, which is closest to the client.
 *  3. `x-real-ip` — single-value header set by some proxies.
 *  4. fallback "unknown" — counted as a single bucket so naked requests still
 *     get rate-limited as a group.
 */
export function clientIp(req: Request): string {
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

async function exceeds(bucket: string, max: number, windowSec: number): Promise<boolean> {
  const rows = await sql`
    SELECT count(*)::int AS n
      FROM rate_limit
     WHERE bucket = ${bucket}
       AND ts > now() - make_interval(secs => ${windowSec})
  ` as Array<{ n: number }>;
  return (rows[0]?.n ?? 0) >= max;
}

async function record(bucket: string) {
  await sql`INSERT INTO rate_limit (bucket) VALUES (${bucket})`;
}

export type RateLimitOpts = {
  /** Bucket prefix — typically the route name. Combined with the IP suffix. */
  key: string;
  /** Max requests in the rolling window. */
  max: number;
  /** Window in seconds. */
  windowSec: number;
};

/**
 * Per-IP rate limit gate. Returns a 429 response if the limit is exceeded,
 * otherwise records the hit and returns null so the caller can proceed.
 *
 * Caller pattern:
 *   const limited = await rateLimit(req, { key: "pools.get", max: 60, windowSec: 60 });
 *   if (limited) return limited;
 */
export async function rateLimit(req: Request, opts: RateLimitOpts): Promise<NextResponse | null> {
  const ip = clientIp(req);
  const bucket = `${opts.key}:${ip}`;
  if (await exceeds(bucket, opts.max, opts.windowSec)) {
    return NextResponse.json({ error: "rate limited" }, {
      status: 429,
      headers: { "Retry-After": String(opts.windowSec) },
    });
  }
  await record(bucket);
  return null;
}
