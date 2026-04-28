import { NextResponse, type NextRequest } from "next/server";

/**
 * Global security headers. Applied to every response except Next.js internals
 * and static assets (matched out below) so they don't get rewritten by the CDN.
 *
 * CSP notes:
 * - `'unsafe-inline'` for script/style is required by Next.js's runtime
 *   hydration injector and our inline styles in app/dapp/page.tsx; tightening
 *   this requires migrating to nonces.
 * - `connect-src` whitelists the Solana RPC clusters (mainnet/devnet/localnet)
 *   and Pyth's price service. Custom RPCs are not allowed — the SolanaProvider
 *   whitelist enforces the same on the client side.
 * - `frame-ancestors 'none'` blocks clickjacking. Belt-and-braces with
 *   X-Frame-Options for older browsers.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    "https://api.mainnet-beta.solana.com",
    "https://api.devnet.solana.com",
    "http://127.0.0.1:8899",
    "ws://127.0.0.1:8900",
    "https://hermes.pyth.network",
    "wss://api.mainnet-beta.solana.com",
    "wss://api.devnet.solana.com",
  ].join(" "),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function middleware(_req: NextRequest) {
  const res = NextResponse.next();

  res.headers.set("Content-Security-Policy", CSP);
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS — only meaningful on HTTPS, but harmless to set unconditionally.
  res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  return res;
}

export const config = {
  // Skip Next.js internals and static assets so we don't rewrite their headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
