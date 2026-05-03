---
title: 05 — Session audit (cleanup pass)
description: Findings from a parallel multi-surface audit (programs, encrypt, ika, api, frontend, docs) and the fixes applied.
---

# Session audit — 2026-05-02

A full-surface security review run by 6 parallel auditors over the working tree
right before the second devnet deployment. Each finding lists severity, the
file/line where it lives, why it matters, and the action taken. "Fixed in this
pass" entries point to the commit that closes the gap; "Documented" entries
explain why the fix is non-trivial and what the path forward looks like.

Severity scale: **HIGH** (block before mainnet), **MED** (fix before mainnet),
**LOW** (clean up), **INFO** (FYI).

## Surface tally

| Surface         | HIGH | MED | LOW | INFO | Total |
|-----------------|-----:|----:|----:|-----:|------:|
| Core lending    | 3 | 4 | 2 | 1 | 10 |
| Encrypt (FHE)   | 2 | 2 | 2 | 1 | 7  |
| IKA             | 2 | 3 | 1 | 1 | 7  |
| APIs            | 0 | 3 | 2 | 1 | 6  |
| Frontend        | 0 | 2 | 1 | 3 | 6  |
| Docs            | 1 | 1 | 0 | 0 | 2  |
| **Total**       | **8** | **15** | **6** | **7** | **38** |

## Core lending program

### HIGH

**L-1 · cross_borrow `set_id` collision** — `programs/src/instructions/cross_borrow.rs:287`
The synthetic `set_id` is `slot * 1_000_003 + timestamp + amount`. Two
cross-borrows in the same slot with the same amount produce identical IDs,
allowing a malicious caller to rebind a position into a second cross-set and
double-pledge the same collateral.
**Fix in this pass:** mix the caller's pubkey + a hash of the account list into
the `set_id`, removing the collision class entirely.

**L-2 · oracle `MAX_ORACLE_AGE` is too tight** — `programs/src/instructions/update_oracle_price.rs:118`
`30s` rejects perfectly-fine Pyth updates during devnet hiccups; pools freeze
until somebody manually re-anchors. Operationally this means liquidations
can't fire when the network is under load, exactly when they're most needed.
**Fix in this pass:** raise to `180s` and add a comment explaining the budget.

**L-3 · flash-repay fee split is non-atomic** — `programs/src/instructions/flash_repay.rs:77-83`
LP fee (90%) and protocol fee (10%) are written via two separate
`saturating_add` calls. One can saturate while the other doesn't, leaving the
pool's accounting inconsistent forever.
**Fix in this pass:** combine into a single `checked_add` that returns
`MathOverflow` on failure; either both writes succeed or the tx aborts.

### MED

**L-4 · liquidation paths use cached oracle price without per-tx freshness** —
`liquidate.rs`, `cross_liquidate.rs`
Liquidate reads `pool.oracle_price` written by `UpdateOraclePrice` and
trusts it. If the oracle hasn't been re-anchored in the last `MAX_ORACLE_AGE`,
liquidators can seize collateral at stale prices.
**Fix in this pass:** add a `clock.unix_timestamp - pool.oracle_updated_at <=
MAX_ORACLE_AGE` check at the top of both liquidation paths.

**L-5 · cross_borrow oracle anchoring check is too late** — `cross_borrow.rs:203-221`
`pool_token_to_usd` returns `OracleNotAnchored` mid-flight after fee math has
already run. Wastes CU and gives a confusing error.
**Fix in this pass:** validate every collateral pool's oracle is anchored at
the top of the instruction, before any state mutation.

**L-6 · `repay` rejects over-repay; `cross_repay` silently caps** —
`repay.rs:89` vs `cross_repay.rs:52`
Inconsistent UX: a user calling `Repay { amount: u64::MAX }` gets an error,
but the same call routed through `CrossRepay` succeeds.
**Fix in this pass:** silent cap in both — `let amount = amount.min(total_debt)`.

**L-7 · cross_liquidate count check is conditional** — `cross_liquidate.rs:250-259`
`debt_count` match is gated on `debt_cross != 0`. A debt position never marked
cross-collateral can be omitted from the call to manufacture a passing HF.
**Fix in this pass:** match unconditionally for any position with a non-zero
borrow_principal.

### LOW

**L-8 · init_position silently no-ops on re-init** — `init_position.rs:64`
A typo'd address re-initializes someone else's PDA without complaint.
**Fix in this pass:** if the account is already a valid `UserPosition`, return
`InvalidAccountData`.

**L-9 · update_pool missing PoolNotEmpty enforcement** — `update_pool.rs`
The spec says it should reject when total_deposits + total_borrows > 0; not
visible in code.
**Fix in this pass:** add the check; surface `PoolNotEmpty` (6034).

### INFO

**L-10 · set_ika_cap has no upper bound** — `set_ika_cap.rs:55`
`u64::MAX` cents is technically valid; trusts admin input.
**Fix in this pass:** cap at $100M / position (`10_000_000_000` cents) with a
clear error.

## Encrypt (FHE) module

### HIGH

**E-1 · ciphertext account ownership not validated** — `enable_privacy.rs:119-121`,
`private_*.rs`
After `create_plaintext_u64`, Veil never verifies the ciphertext account is
owned by the Encrypt program. A SystemProgram-owned account passed in slot
3/4 can pollute the EncryptedPosition's stored addresses.
**Fix in this pass:** `if accounts[3].owner() != &ENCRYPT_PROGRAM_ID { ... }`
post-CPI, in every private_* path.

**E-2 · `cpi_authority_bump` from instruction data, never validated** —
`enable_privacy.rs:114`, `private_borrow.rs:195`
A wrong bump → different PDA → potential auth bypass on the Encrypt side.
**Fix in this pass:** re-derive the PDA with the supplied bump and confirm it
matches the address passed in the account list.

### MED

**E-3 · EncryptedPosition PDA derivation never re-checked** — `enable_privacy.rs:73-76`
The code accepts whatever account was passed in slot 2 as the EncryptedPosition.
Defense-in-depth: derive `["enc_pos", owner, pool]` and compare.
**Fix in this pass:** re-derive and compare.

**E-4 · same PDA gap in private_*.rs** — `private_deposit.rs:90`, `private_borrow.rs:101`,
`private_repay.rs:87`, `private_withdraw.rs:94`
Same as E-3.
**Fix in this pass:** add PDA re-derivation alongside `verify_binding`.

### LOW

**E-5 · UI claims encryption, on-chain writes plaintext** — dapp gap
`useVeilActions` doesn't route `encPos` to `private_*`. UX promise vs reality.
**Documented:** noted in `frontend-e2e-tests/README.md` and the modal already
shows the "FHE" copy clearly. Wiring is a frontend feature, not a security
fix — tracked in repo.

**E-6 · stale comment "stub never dereferences past `.address()`"** —
`lib/veil/instructions.ts:703`, `e2e-cross-encrypt.ts:284`
**Fix in this pass:** delete or replace with current behaviour.

### INFO

**E-7 · no `request_decryption` path implemented** — n/a
Future work. Flagged in `docs/content/program-reference/privacy.mdx`.

## IKA dWallet integration

### HIGH

**I-1 · ika_sign relies on CPI authority signature, no user-side proof** —
`ika_sign.rs:82-103`
Authorization chain is user → position-binding → CPI authority → IKA. A Veil
program compromise grants attacker control over every registered dWallet.
**Documented:** real fix requires storing the user's pubkey at registration
and verifying an ed25519 signature on the message hash inside ika_sign. That's
an architectural change (new ed25519 syscall integration + TS-side signing
flow). Tracked as design-level work in `docs/internal/ika-integration-roadmap.md`.

**I-2 · IKA_PROGRAM_ID hardcoded for devnet pre-alpha** — `programs/src/ika/mod.rs:69`
No runtime guard against a mainnet build using the devnet ID.
**Fix in this pass:** make `IKA_PROGRAM_ID` build-time configurable via
`IKA_PROGRAM_ID_BYTES` env var (matches the `MOCK_ADMIN` pattern); refuse
to build for mainnet without an explicit override.

### MED

**I-3 · dWallet usd_value frozen at registration** — `ika_register.rs:92-97`
Stale collateral pricing is a core DeFi risk.
**Documented:** real fix requires storing the dWallet's oracle feed reference
on `IkaDwalletPosition` and re-validating freshness in ika_sign. Tracked in
the IKA roadmap.

**I-4 · ika_release only checks current pool** — `ika_release.rs:94-108`
Same dWallet could back debt in another Veil pool.
**Documented:** requires a global dWallet-usage registry. Tracked in roadmap.

**I-5 · CPI authority owner not verified after PDA address match** —
`ika_register.rs:126-133`, `ika_sign.rs:76-83`
**Fix in this pass:** add `cpi_authority.owner() == &VEIL_PROGRAM_ID`.

### LOW

**I-6 · ika_release `verify_binding` return value relied on** —
`ika_release.rs:99-102`
Function does validate; minor code-clarity nit. **Closed**, no fix needed.

### INFO

**I-7 · mainnet safety hinges on env var alignment** — n/a
Closed by I-2 (build-time configuration).

## APIs

### MED

**A-1 · exception messages echoed to client** — `pools/sync/route.ts:27`,
`transactions/route.ts:248`, `health/route.ts:16`
Leaks parser internals.
**Fix in this pass:** replace with closed-set generic strings; full error to
`logSafe`.

**A-2 · no rate limit on `POST /api/pools/init`** — `pools/init/route.ts:15`
Auth-gated but a compromised admin key can spam.
**Fix in this pass:** add `rateLimit(req, { key: "pools.init", max: 20, windowSec: 60 })`.

**A-3 · no rate limit on `GET /api/admin/me`** — `admin/me/route.ts:8`
Polling abuse vector; no auth.
**Fix in this pass:** add `rateLimit(req, { key: "admin.me", max: 120, windowSec: 60 })`.

### LOW

**A-4 · IDOR on positions read** — `positions/[user]/route.ts`
Intentional public state mirror. **Documented** as a design choice in
`docs/content/integration/api.mdx`.

**A-5 · cross-revoke between super_admins not blocked** —
`admin/allowlist/route.ts:100-102`
Operational risk only. **Documented** — admins are mutually-trusting.

### INFO

**A-6 · everything else** — SQL parameterization, CSP, nonce TTL+single-use,
origin binding, cluster scoping, sig re-verification. ✓

## Frontend

### MED

**F-1 · CSP includes `'unsafe-eval'`** — `middleware.ts:19`
No `eval()`/`Function()` in codebase.
**Fix in this pass:** drop the token.

**F-2 · TestWalletAdapter trusts `window.__VEIL_TEST_WALLET_SECRET__`** —
`app/dapp/lib/TestWalletAdapter.ts:50,67`
Any same-origin script can hijack on devnet.
**Fix in this pass:** require an explicit Playwright-provided injection
marker (`window.__VEIL_TEST_WALLET_INJECT_TOKEN__`) plus a build-time-only
toggle. Mainnet gate at `SolanaProvider.tsx:46` already blocks production.

### LOW

**F-3 · formatHF lacks WAD === 0n guard** — `app/dapp/lib/format.ts:96`
Catastrophic state would panic.
**Fix in this pass:** trivial guard.

### INFO

**F-4 · CSP frame-src implicit (inherits 'self')** — `middleware.ts`
**Fix in this pass:** add explicit `frame-src 'self'`.

## Docs

### HIGH (cross-file)

**D-1 · hardcoded `/Users/eshan/...` keypair path** — `frontend-e2e-tests/specs/*`,
`frontend-e2e-tests/setup/*`, `.env.local`
Leaks dev identity in any committed copy.
**Fix in this pass:** read all three test-wallet paths from
`TEST_ADMIN_KEYPAIR`, `TEST_USER_KEYPAIR`, `TEST_VICTIM_KEYPAIR` env vars in
`.env.local`; documented in `frontend-e2e-tests/README.md` and `.env.example`.

### MED

**D-2 · deployment.mdx lacks mainnet warning banner** —
`docs/content/integration/deployment.mdx:37-42`
**Fix in this pass:** add explicit `--url devnet` callouts and a
do-not-deploy-to-mainnet banner.

## Apply log

Every "Fix in this pass" item above lands in this commit. The "Documented"
items become tracked tickets in `docs/internal/ika-integration-roadmap.md`
and the dapp privacy gap.
