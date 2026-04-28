---
title: "03 — Frontend Security"
description: Adversarial security review of the veil-landing frontend, API routes, auth, and transaction logic.
---

# Frontend Security Audit

**Date:** 2026-04-28
**Scope:** Full adversarial security review of `veil-landing` frontend, API routes, auth, transaction logic
**Methodology:** Black-box + white-box source review, dependency analysis, attack path enumeration

---

## Executive Summary

The codebase is reasonably well-architected with strong admin auth (nonce + Ed25519 + RBAC). However, several exploitable attack vectors exist, primarily around **unauthenticated API endpoints**, **server-side request forgery via user-controlled RPC URLs**, **missing security headers**, and **supply chain vulnerabilities**. The on-chain transaction building is solid — no direct fund-draining vectors from the frontend alone, though oracle manipulation paths exist if the on-chain program doesn't gate mock instructions.

---

## CRITICAL Vulnerabilities

### C1. Server-Side Request Forgery (SSRF) via User-Controlled RPC URL

**Files:**

- `app/api/pools/sync/route.ts:16-19`
- `app/api/positions/sync/route.ts:19-22`

**Description:** Both `/api/pools/sync` and `/api/positions/sync` accept an `rpc` parameter in the POST body. The only validation is a weak regex: `/^https?:\/\//`. The server then creates a `new Connection(rpc)` and makes RPC calls to it.

**Attack:**

```bash
curl -X POST /api/pools/sync \
  -H 'Content-Type: application/json' \
  -d '{"pool_address":"<valid-pool>","rpc":"http://attacker.com/fake-rpc"}'
```

**Impact:**

1. **Data poisoning:** Attacker-controlled RPC returns fake pool state (manipulated oracle prices, LTV ratios, etc.) which gets written directly to your database via the UPSERT. This poisons the cache that the entire UI reads from.
2. **Internal network scanning:** Attacker can probe `http://169.254.169.254/` (cloud metadata), `http://localhost:*`, or internal services.
3. **Fake liquidation signals:** Attacker writes fake `health_factor_wad < 1.0` to positions, triggering false liquidation alerts in `/api/positions/unhealthy`.

**Severity:** CRITICAL — enables oracle price manipulation in the DB cache without touching the chain.

**Recommendation:** Remove the `rpc` parameter entirely. Server should ONLY use its own trusted RPC endpoint. If custom RPC is needed for development, gate it behind an env flag like `ALLOW_CUSTOM_RPC=true`.

## My comments user here: Why not have different db for each localnet, devnet and mainnet and remove custom rpc entirely.

### C2. Unauthenticated Database Cache Poisoning via `/api/pools/sync`

**File:** `app/api/pools/sync/route.ts:10` — comment says "Public — anyone can call this"

**Description:** Even without SSRF, this endpoint is publicly callable with no auth. An attacker can call it in a loop to force the server to make RPC calls and overwrite the DB cache. Combined with C1, this is a complete cache poisoning vector.

**Attack scenario:**

1. Attacker deploys a fake Solana program at a known address
2. Calls `/api/pools/sync` with `pool_address=<fake-program-account>` and their malicious RPC
3. DB now contains a fake pool entry with manipulated parameters
4. UI renders fake data to all users

**Recommendation:** Validate that `pool_address` is owned by `VEIL_PROGRAM_ID` before caching. Add rate limiting. Consider requiring admin auth for sync operations.

---

### C3. Transaction Log Injection — No Action Validation on POST

**File:** `app/api/transactions/route.ts:124-143`

**Description:** The GET endpoint validates actions against `VALID_ACTIONS` whitelist, but the POST endpoint accepts ANY string as `action`. There's also no verification that:

- The `signature` corresponds to an actual on-chain transaction
- The `wallet` actually signed the transaction
- The `amount` is within reasonable bounds

**Attack:**

```bash
curl -X POST /api/transactions \
  -H 'Content-Type: application/json' \
  -d '{"signature":"fake123","wallet":"<victim-pubkey>","action":"liquidate","pool_address":"...","amount":"999999999999"}'
```

**Impact:** Pollutes transaction history with fake entries. Could create false audit trails showing users performed actions they didn't. If the frontend relies on tx_log for position tracking, this could display incorrect balances.

**Recommendation:** Validate `action` against `VALID_ACTIONS`. Verify `signature` exists on-chain before logging. Consider requiring wallet signature auth.

---

## HIGH Vulnerabilities

### H1. Origin Header Fallback Enables Signature Replay

**File:** `lib/auth/signature.ts:42-48`

```typescript
export function expectedOrigin(req: Request): string {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const fallback = process.env.PUBLIC_ORIGIN ?? "http://localhost:4321";
  return fallback;
}
```

**Description:** If the Origin header is missing (e.g., requests from curl, proxies that strip headers, or server-to-server calls), the server uses a fallback origin. The nonce response at `/api/auth/nonce` also returns this origin in the `message` field.

**Attack scenario:**

1. Attacker makes server-to-server requests (no Origin header)
2. Server uses fallback `http://localhost:4321`
3. If attacker can trick an admin into signing a message with origin `http://localhost:4321`, it replays against the server

**Severity:** HIGH — mitigated by the fact that wallet signatures are domain-bound, but the fallback weakens the SIWE-style protection.

**Recommendation:** Require the Origin header. Return 400 if missing. Never fall back.

---

### H2. No Auth on Position Data Endpoints — Privacy Leak

**Files:**

- `app/api/positions/[user]/route.ts:6-18`
- `app/api/positions/[user]/detail/route.ts`

**Description:** Anyone can query any wallet's positions by supplying the wallet address in the URL. No authentication required. This exposes:

- Deposit amounts and shares
- Borrow principal and debt
- Health factors (liquidation proximity)
- Interest earned/owed
- Transaction history
- Supply/borrow APYs

**Attack:** `GET /api/positions/<any-wallet-address>`

**Impact:** Complete financial position disclosure for any user. In DeFi, knowing someone's exact health factor enables targeted liquidation strategies (monitoring when they become liquidatable).

**Recommendation:** This may be intentional (all data is on-chain anyway), but consider at minimum requiring the user to sign a message proving they own the wallet, or rate-limit these endpoints.

## User comments: yes it is intentional but add rate limit

### H3. No Rate Limiting on Public Endpoints

**Affected endpoints:**

- `GET /api/pools` — no rate limit
- `GET /api/positions/[user]` — no rate limit
- `GET /api/positions/[user]/detail` — no rate limit
- `GET /api/positions/unhealthy` — no rate limit
- `GET /api/admin/audit` — no rate limit (public!)
- `GET /api/transactions` — no rate limit
- `POST /api/pools/sync` — no rate limit
- `POST /api/positions/sync` — no rate limit
- `POST /api/transactions` — no rate limit

Only `/api/auth/nonce` has rate limiting (12/pubkey/min, 30/ip/min).

**Impact:** DoS, scraping of all user positions, spam of sync endpoints, transaction log flooding.

**Recommendation:** Add rate limiting to all public endpoints, especially the sync and POST endpoints.

---

### H4. Audit Log is Publicly Readable

**File:** `app/api/admin/audit/route.ts:17`

**Description:** The audit log is completely public. Anyone can query all admin actions including:

- Who was added/revoked as admin
- When pools were initialized
- Admin wallet addresses
- Details of all admin operations (JSONB)

**Impact:** Operational intelligence disclosure. Attacker learns admin wallet addresses, admin rotation patterns, and operational timing.

**Recommendation:** Require admin auth to read audit logs, or at minimum redact sensitive details.

User comments: This is only for localnet and devnet and should not be for mainnet

---

### H5. No Content Security Policy or Security Headers

**File:** `next.config.ts` — completely empty

**Missing headers:**

- `Content-Security-Policy` — no script/style/connect-src restrictions
- `X-Frame-Options` / `frame-ancestors` — clickjacking possible
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security`
- `Referrer-Policy`
- `Permissions-Policy`

**Impact:** XSS attacks have no CSP barrier. Page can be iframed for clickjacking. No HSTS enforcement.

**Recommendation:** Add a `middleware.ts` with security headers:

```typescript
response.headers.set(
  "Content-Security-Policy",
  "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://hermes.pyth.network https://*.solana.com",
);
response.headers.set("X-Frame-Options", "DENY");
response.headers.set("X-Content-Type-Options", "nosniff");
```

---

### H6. Supply Chain — 97 npm Vulnerabilities Including 4 Critical

**Source:** `npm audit`

**Critical:**

- `bigint-buffer` — buffer overflow (GHSA-3gc7-fjrx-p6mg), used by `@solana/spl-token`

**High:**

- `elliptic` — cryptographic implementation flaws (GHSA-848j-6mx2-7j84), used by `@toruslabs` → wallet adapters

**67 Moderate:** uuid, various @solana dependencies

**Recommendation:** Run `npm audit fix`. Consider removing unused wallet adapters (Torus, Keystone, etc.) to reduce attack surface.

---

## MEDIUM Vulnerabilities

### M1. localStorage RPC Poisoning

**File:** `app/providers/SolanaProvider.tsx:43-56`

**Description:** RPC endpoint config is persisted in localStorage and loaded on mount. A malicious browser extension or XSS attack can modify `localStorage['veil:rpc']` to redirect ALL Solana RPC calls to an attacker-controlled endpoint.

**Impact:** All on-chain reads return attacker-controlled data. Transaction simulation returns fake success. User sees fake balances, fake health factors.

**Recommendation:** Validate loaded RPC against a whitelist of known-good endpoints. At minimum, warn the user if RPC has been changed from default.

User comments: whitelist only mainnet, devnet and localnet on solana

---

### M2. Float Precision Loss in Amount Calculations

**File:** `app/dapp/page.tsx:2200-2259`

```typescript
const parsed = parseFloat(amount); // JS float — 53 bits of mantissa
```

**Description:** User-entered amounts go through `parseFloat()` → arithmetic → `toFixed()` → string split → `BigInt()`. For tokens with high decimal counts (e.g., 18 decimals like wrapped ETH), amounts above ~9007 tokens lose precision in the float step.

**Example:** User enters `9007199254740993` (> 2^53), parseFloat returns `9007199254740992`. The 1 lamport difference could matter for exact-repay scenarios.

**Impact:** Low practical impact (most amounts are small), but could cause dust accounting errors.

**Recommendation:** Parse amounts directly as string → BigInt without float intermediary. Or use a decimal library.

---

### M3. Mock Oracle/Fee Instructions Shipped in Production

**File:** `lib/veil/instructions.ts:479-528`

```typescript
/** ONLY FOR TESTING: Set oracle price/expo directly on a pool. */
export function mockOracleIx(authority, pool, price, expo); // discriminator 0xFD

/** ONLY FOR TESTING: Inject 100 tokens of fees into the pool state. */
export function mockFeesIx(authority, pool); // discriminator 0xFE
```

**Description:** Testing-only instruction builders are exported from the production SDK. While the on-chain program MUST gate these (authority check + feature flag), having them in the frontend code means:

1. They can be called by anyone who imports the SDK
2. They document the exact discriminators for on-chain attack attempts

**Impact:** If the on-chain program doesn't properly gate these instructions, an attacker can set arbitrary oracle prices and inject fake fees.

**Recommendation:** Remove mock instructions from production build. Use build-time tree-shaking or separate test-only exports.

user comments: these should only not be there anymore, remove

---

### M4. IP Spoofing Bypasses Rate Limiting

**File:** `app/api/auth/nonce/route.ts:13-19`

```typescript
function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
```

**Description:** Trusts `x-forwarded-for` without verifying the proxy chain. If the app is not behind a trusted reverse proxy (or the proxy doesn't strip incoming `x-forwarded-for`), an attacker can spoof their IP to bypass rate limiting.

**Impact:** Rate limit bypass on nonce issuance. Enables brute-force admin auth attempts.

**Recommendation:** Only trust `x-forwarded-for` from known proxy IPs. Use Vercel's `req.headers.get('x-vercel-forwarded-for')` if deployed on Vercel.

User comments: yes deployed on vercel

---

### M5. NaN Handling in Limit/Offset Parameters

**File:** `app/api/transactions/route.ts:45-51`

```typescript
const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);
limit = Math.min(
  Math.max(Number(searchParams.get("limit") ?? DEFAULT_LIMIT), 1),
  MAX_LIMIT,
);
```

**Description:** `Number("abc")` returns `NaN`. `Math.max(NaN, 0)` returns `NaN`. This `NaN` is then passed to PostgreSQL as a LIMIT/OFFSET parameter, which may cause unpredictable behavior.

**Recommendation:** Default to fallback value if `isNaN()`: `const offset = Number(x) || 0;`

---

## LOW Vulnerabilities

### L1. No CORS Configuration

**Impact:** API routes are callable from any origin. Any website can make fetch requests to your API and read responses (for GET endpoints without credentials, this is the browser default).

### L2. Admin Allowlist is Publicly Readable

**File:** `app/api/admin/allowlist/route.ts:8-16` — `GET` has no auth.

**Impact:** Anyone can enumerate all admin wallet addresses, their roles, and when they were added.

User comments: How is it done for a aave or other big defi? Follow that approach

### L3. Exposed Solana Explorer Links with Custom RPC

**File:** `app/dapp/page.tsx` — Explorer links include `customUrl=<user-rpc>` parameter.

**Impact:** If user has set a custom RPC, clicking explorer links reveals their RPC endpoint to Solana Explorer.

### L4. Empty Catch Blocks Suppress Errors

**Files:** `SolanaProvider.tsx:57,63`, `AllowlistPanel.tsx:55,80`, `useVeilActions.ts:36,44,51`, `page.tsx:2444`

**Impact:** Errors are silently swallowed, making debugging difficult and potentially hiding security-relevant failures.

### L5. Unvalidated Date Parameters in Transaction Filter

**File:** `app/api/transactions/route.ts:82-89` — `from` and `to` params passed directly to PostgreSQL.

**Impact:** Malformed dates could cause query errors. PostgreSQL handles type coercion safely for the tagged template, but no validation that `from <= to`.

## User comments: add a date check

## Dead Code

### D1. Placeholder Program ID Fallback

**File:** `lib/veil/constants.ts:10`

```typescript
"11111111111111111111111111111111"; // placeholder until deployed
```

Falls back to System Program ID if env var is missing. Should throw an error instead.

User comments: add mainnet, devnet and localnet where mainnet and devnet will be hardcoded and localnet in env. Currently devnet and mainnet some default placeholder

### D2. Mock Oracle Instruction Builder

**File:** `lib/veil/instructions.ts:479-511`

```typescript
export function mockOracleIx(...)  // discriminator 0xFD
```

Testing-only function shipped in production.

User comment: remove

### D3. Mock Fees Instruction Builder

**File:** `lib/veil/instructions.ts:513-528`

```typescript
export function mockFeesIx(...)  // discriminator 0xFE
```

Testing-only function shipped in production.

User comment: remove

### D4. Set Pool Decimals Instruction

**File:** `lib/veil/instructions.ts` — discriminator `0x15`
Referenced in code but likely only used during setup, not runtime.

### D5. Unused Connection Import

**File:** `lib/veil/state.ts:1`

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
```

`Connection` is used in `fetchPool` and `fetchPosition` — these functions exist but are not called from any React component (the UI uses API routes instead). These utility functions are dead code in the frontend context.

user comments: should these not be used to fetch all the positions and active pool in the program?

---

## Mock / Test Code in Production

### T1. Test Scripts in Repository

**Files:**

- `scripts/test-cross-borrow.ts` — cross-collateral test
- `scripts/test-repay.ts` — repay test
- `scripts/test-withdraw.ts` — withdraw test
- `scripts/e2e-test.ts` — end-to-end test scenario
- `scripts/setup-localnet.ts` — local validator setup

**Impact:** Not served to users (not in `app/` directory), but increase attack surface if the deployment includes the `scripts/` directory.

user comments: remove from git keep local

### T2. Test Ledger Data

**Directory:** `test-ledger/`
Contains local validator keypairs, snapshots, and RocksDB data. Properly `.gitignore`d.

### T3. Mock Instruction Discriminators

**File:** `lib/veil/instructions.ts`

- `0xFD` — Mock oracle price
- `0xFE` — Mock fees

These are test-only on-chain instructions whose client-side builders are included in the production bundle.

user comments: keep till testing

---

## Console Statements in Production

| File                 | Line | Level | Message                   |
| -------------------- | ---- | ----- | ------------------------- |
| `useVeilActions.ts`  | 84   | error | Simulation failed         |
| `useVeilActions.ts`  | 91   | warn  | Simulation skipped        |
| `useVeilActions.ts`  | 114  | error | Action failed (with logs) |
| `useVeilActions.ts`  | 118  | error | Action failed             |
| `useChainPolling.ts` | 109  | warn  | Chain polling error       |

---

## Positive Security Findings

The following are done well:

1. **Admin auth is solid:** Nonce + Ed25519 signature + atomic role-check-and-consume in a single SQL CTE. TOCTOU-safe.
2. **Parameterized SQL everywhere:** No string concatenation in queries. Tagged template literals with Neon's `sql` function handle escaping.
3. **Transaction simulation before signing:** Catches program errors before the wallet prompt.
4. **SIWE-style origin binding:** Admin signatures include the origin, preventing cross-site replay.
5. **Self-revocation prevention:** Admins cannot revoke themselves (`actor === pubkey` check).
6. **Log redaction:** `lib/log.ts` redacts sensitive fields before logging.
7. **Env leak detection:** `scripts/check-env-leak.ts` catches `NEXT_PUBLIC_` misuse at build time.
8. **BigInt math for on-chain values:** No float precision issues in state decoding or health factor calculations (uses `BigInt` throughout `lib/veil/state.ts`).
9. **Single-use nonces with TTL:** 5-minute expiry, consumed atomically, rate-limited per pubkey and IP.

---

## Attack Path Summary

| Attack                     | Entry Point                       | Impact                                               | Feasibility |
| -------------------------- | --------------------------------- | ---------------------------------------------------- | ----------- |
| SSRF + DB cache poisoning  | `/api/pools/sync` with custom RPC | Fake oracle prices in DB, false liquidation triggers | **Easy**    |
| Tx log pollution           | `POST /api/transactions`          | False audit trail, fake activity                     | **Easy**    |
| Position surveillance      | `GET /api/positions/<wallet>`     | Financial intelligence on any user                   | **Easy**    |
| Admin enumeration          | `GET /api/admin/allowlist`        | Know all admin wallets                               | **Easy**    |
| localStorage RPC hijack    | XSS or malicious extension        | Redirect all RPC calls                               | **Medium**  |
| IP spoof rate limit bypass | `x-forwarded-for` header          | Brute-force nonce issuance                           | **Medium**  |
| Origin header stripping    | Proxy misconfiguration            | Signature replay with fallback origin                | **Medium**  |
| Supply chain exploit       | npm dependency vulnerability      | Code execution via compromised package               | **Hard**    |

---

## Priority Recommendations

### Immediate (Do Now)

1. **Remove `rpc` parameter from sync endpoints** — use server's own trusted RPC only
2. **Add action validation on `POST /api/transactions`** — whitelist actions like GET does
3. **Add security headers** via `middleware.ts` (CSP, X-Frame-Options, HSTS)
4. **Rotate DATABASE_URL password** as a precaution

### Short-term (This Sprint)

5. **Add rate limiting** to all public endpoints
6. **Require Origin header** in `expectedOrigin()` — no fallback
7. **Remove mock instructions** from production bundle (`mockOracleIx`, `mockFeesIx`)
8. **Validate pool ownership** before writing to DB in sync endpoints
9. **Run `npm audit fix`** and remove unused wallet adapters

### Medium-term

10. Add signature-based auth to position detail endpoints
11. Move audit log behind admin auth
12. Replace `parseFloat` with string-based BigInt parsing for amounts
13. Add input validation middleware for all API routes
14. Implement proper CORS policy
