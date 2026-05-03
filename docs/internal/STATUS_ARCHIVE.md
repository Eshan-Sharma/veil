# Veil — Project Status & Gap Analysis

Date: 2026-04-25
Author: build session log
Audience: anyone returning to this codebase to continue work

This is an honest, source-grounded inventory of what exists, what's verified,
what's flagged, and what's missing. Use it as the change-of-watch document.

---

## 1. Done — verified

### On-chain protocol (pre-existing)

21 instructions in Pinocchio (`programs/src/`). Math, state, instruction
dispatch, oracle pipeline. **342 cargo tests pass** (`cargo test --lib` 105 +
`cargo test --tests` 57 + 99 + 81). No on-chain code was modified during the
build session — all verification is against the as-shipped binary.

| Discriminator range | Family | Status |
|---|---|---|
| `0x00`–`0x05` | Initialize / Deposit / Withdraw / Borrow / Repay / Liquidate | functional |
| `0x06`–`0x07` | Flash Borrow / Repay | functional with `flash_loan_amount` reentrancy guard |
| `0x08`–`0x0C` | Privacy (FHE) | routes correctly; `execute_graph` CPI stubbed pending Encrypt SDK Pinocchio 0.11 |
| `0x0D`–`0x10` | Admin (UpdatePool / Pause / Resume / CollectFees) | functional, signer == `pool.authority` enforced |
| `0x11`–`0x13` | Ika dWallet (Register / Release / Sign) | functional except liquidation settlement (X-01) |
| `0x14` | UpdateOraclePrice (Pyth, address-anchored, 2% conf cap) | functional |

### Off-chain stack (built during session)

| Layer | What |
|---|---|
| **DB** | Neon Postgres, 6 tables (`pool_admins`, `pools`, `positions`, `tx_log`, `audit_log`, `auth_nonces`); migration script (`db:migrate`); `db:add-admin` CLI; super-admin seeded |
| **Auth** | ed25519 signed nonces (16-byte, single-use, 5-min TTL, action-bound canonical message); server verify via TweetNaCl; allowlist-gated privileged endpoints |
| **API (11 routes)** | `/auth/nonce` · `/admin/me` · `/admin/allowlist` (GET/POST/DELETE) · `/pools` (list/init/sync) · `/positions/[user]` · `/transactions` (GET/POST) |
| **dApp pages** | `/dapp` (markets) · `/dapp/admin` (3 tabs: Manage / Initialize / Allowlist) · `/dapp/liquidate` · `/workflow` · `/whitepaper` |
| **Hooks** | `useVeilActions` (deposit / withdraw / borrow / repay / liquidate / flashExecute) · `useAdminRole` · `usePythPrices` |
| **Hydration** | `WalletButton` mount-gated wrapper (fixes wallet-adapter SSR mismatch) |
| **Verification** | Next.js production build clean, all 14 routes generated · TS typecheck clean · API smoke tested |

### Docs site (built during session)

- Restructured into route group `(docs)/` so the whitepaper has its own chrome
- New RFC-style technical whitepaper at `/whitepaper` (18 sections, full HTTP API integration, 30-finding security audit)
- New integration section: `/integration/{api,database,authorization,dapp,deployment}.mdx`
- 5 real drift bugs fixed in existing docs (PDA seed name, dispatch-table duplicates, `flash_loan_active` → `flash_loan_amount`, `u64::MAX` → `u128::MAX`, non-existent SDK function names)
- `npm run build` clean, 26 static pages generated

### Whitelisted admins

| Wallet | Role | Source |
|---|---|---|
| `3rzenMHF1M27EAK7moeTgLdKepu1pXWvFs9jTWpAeCCb` | `super_admin` | bootstrap (migration seed) |
| `GznA2vEavbE9f4rGn2z4jvY8r8i16jaVQ2nenUSEn6KW` | `pool_admin` | CLI add (user request) |

---

## 2. Open security findings (from whitepaper §13 ultrathink)

These are real gaps an auditor will flag. Tagged with the IDs used in the whitepaper.

### High — blocks any value-bearing deployment

| ID | Gap | Required action |
|---|---|---|
| **A-04** | Oracle feed first-call hijack — anyone can anchor a fresh pool to a fake Pyth account | Take `pyth_price_feed` in `Initialize` data; anchor it before any user deposit |
| **A-09** | `Initialize` squatting — anyone can claim `pool.authority` for any unowned token mint | Add a `SetExpectedAuthority` flow signed by deploy-time root key |
| **X-01** | A `LIQUIDATED` dWallet position is bricked — `IkaSign`/`IkaRelease` both reject; no recovery path for liquidator | New `IkaLiquidate` instruction or ownership-transfer pathway |

### Medium — must close before mainnet

| ID | Gap | Required action |
|---|---|---|
| **A-08** | `UpdatePool` has no timelock | Squads multisig + governance program with timelock |
| **A-12** | No explicit `token_program_id` assertion (relies on pinocchio_token's hardcoded ID) | Add `accounts[token_program].address() == TOKEN_PROGRAM_ID` |
| **A-13** | No `user_token != vault` aliasing check | Add assertion in deposit/withdraw/borrow/repay |
| **O-03** | No domain/origin in canonical signed message | Bake `Origin: <expected>` into the message (SIWE-pattern) |
| **O-04** | DB compromise → `INSERT pool_admins` bypasses signature flow | Postgres least-privilege role split |
| **O-05** | No rate limit on `/api/auth/nonce` | Per-IP and per-pubkey sliding window |

---

## 3. Functional gaps

### Blocks "real users on devnet"

- dApp pool list is **hardcoded** in `useVeilActions::POOL_MINTS`; newly-initialized pools don't appear
- **No oracle keeper** — cached price goes stale within minutes; HF checks become unsafe
- **No position indexer** — `positions` table is empty; liquidator UI cannot scan
- **No test-token faucet** — devnet users have no way to acquire pool assets
- Flash loan example is a no-op round-trip — integrators have no template for real use
- **Privacy UI is 0% built** — 5 private instructions exist on-chain but unreachable
- **dWallet UI is 0% built** — IkaRegister/Sign/Release exist but unreachable
- **Gold (Oro/GRAIL) is 0%** on-chain (claimed in marketing only)
- **Multi-asset positions** — single-asset only; v1 design item
- **Insurance fund / bad-debt handling** — none
- **No ClosePosition instruction** — UserPosition PDAs accumulate rent forever

### Hurts credibility on existing devnet

- No per-pool detail page (`/dapp/pools/[mint]`)
- No per-user position page or tx history (the API exists; the UI doesn't)
- No live TVL / utilization / apr metrics on `/dapp` (mock data only)
- No live liquidation feed
- No audit-log viewer in admin (the table is populated, never displayed)
- No pool-parameter change history view

### Operational / launch gaps

- No production deploy: mainnet program ID, Squads multisig, timelock all absent
- No observability: Sentry/Axiom sink absent; no `/api/health`; no alerting
- No CI/CD: GitHub Actions don't run `cargo test` + `next build` on PRs
- Repo hygiene: no `LICENSE`, no `CONTRIBUTING.md`, no issue templates
- Audit: zero — explicitly pre-audit
- Bug bounty: not announced
- Demo / marketing: no demo video, no on-chain pool actually initialized

---

## 4. Prioritization tiers

### Tier 1 — finish the "demoable on devnet" story (off-chain TS, no redeploy)

1. Drive the dApp from `/api/pools` (replace hardcoded `POOL_MINTS`)
2. Oracle keeper (`scripts/oracle-keeper.ts`)
3. Position indexer (`scripts/indexer.ts`)
4. Liquidation scan UI (use indexed `positions.health_factor_wad`)
5. `/dapp/positions` page (user's open positions)
6. `/dapp/history` page (per-wallet tx log)
7. Audit-log viewer in admin
8. `/dapp/faucet` page (devnet airdrop)
9. `/api/health` endpoint

### Tier 2 — security uplift (off-chain TS only)

10. Rate limiting on `/api/auth/nonce`
11. Origin in canonical signed message (SIWE-pattern)
12. Postgres least-privilege role split (env-var contract)
13. Atomic role-check + nonce-consume in one SQL
14. Logging hygiene (redact signatures from server logs)
15. CI guard against `NEXT_PUBLIC_*postgres*` leaks

### Tier 3 — on-chain hardening (Rust patch + program redeploy)

16. `Initialize` takes `pyth_price_feed` in data; anchor at init
17. Token-program-id explicit assertion in every transfer instruction
18. `user_token != vault` assertion in deposit/withdraw/borrow/repay
19. New `IkaLiquidate` instruction (closes X-01)
20. Per-block `UpdatePool` delta cap (mitigates A-08 even pre-timelock)
21. `ClosePosition` instruction (rent reclamation)

### Tier 4 — product breadth (weeks of work each)

22. Multi-asset (cross-asset) positions
23. Privacy UI + Encrypt SDK CPI activation when 0.11 ships
24. Ika dWallet UI + real testnet integration
25. Oro/GRAIL gold pool
26. Insurance fund / bad-debt accounting
27. Per-pool deposit/borrow caps + isolation mode

---

## 5. Recommendation

**Tier 1 + Tier 2 in this session unblocks "real users on devnet" with a hardened auth layer.** Both are pure off-chain TypeScript — no Solana program redeploy, no breaking changes to the on-chain spec.

**Tier 3 is the right next session** — it's a Rust diff against `programs/src/` plus a redeploy plus retesting of the 342-test suite. Bundle all six on-chain hardenings into one redeploy to amortise the cost.

**Tier 4 is a roadmap.** Multi-asset positions alone is a multi-week scope.

---

## 6. Operational facts (for whoever picks this up next)

- Dev port allocations:
  - 4321 — dApp dev server (`/Users/.../veil-landing`)
  - 5454 / 5455 — docs site (older / newer build)
  - 3000, 3001, 4123 — pre-existing on the user's machine, untouched
- Database connection: in `veil-landing/.env.local` as `DATABASE_URL` (gitignored)
- Migrations: `cd veil-landing && npm run db:migrate` (idempotent)
- Add admin: `cd veil-landing && npm run db:add-admin -- <pubkey> [pool_admin|super_admin] [label]`
- Cargo tests: `cd programs && cargo test --lib && cargo test --tests`
- Frontend tests: typecheck via `next build` (no separate test runner)
- Whitepaper at `/dapp/whitepaper` (marketing, Stellaray-style) and `/docs/app/whitepaper/` (technical, RFC-style with §13 audit)
