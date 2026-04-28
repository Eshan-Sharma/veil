---
title: "04 — Red-Team Report"
description: Hostile end-to-end review of on-chain program, frontend, API, and operational scripts.
---

# Adversarial Red-Team Audit

**Date:** 2026-04-28
**Scope:** Full adversarial review — on-chain Pinocchio program (`/programs`), Next.js frontend & API (`/veil-landing`), and operational scripts.
**Stance:** Hostile. Goal = drain user funds. No assumption is treated as safe until verified.
**Methodology:** White-box source review of all 30 instruction handlers, all API routes, all SDK builders. Cross-referenced against the prior frontend audit to avoid duplication and verify previous findings still stand.

> **Bottom line:** the on-chain program contains at least **two unconditional fund-drain vectors** (vault substitution and oracle anchor frontrun) that work on a freshly initialized pool. The flash-loan path has a third drain vector via the same vault-substitution issue. The frontend retains every Critical from the prior audit. Do not deploy to mainnet in current state.

---

## Severity Index

| ID | Severity | Title | Layer |
|---|---|---|---|
| **C-1** | Critical | Vault account never compared to `pool.vault` — fake-vault deposit + real-vault drain | On-chain |
| **C-2** | Critical | `FlashRepay` accepts attacker-controlled vault — free flash loan + state desync | On-chain |
| **C-3** | Critical | Oracle anchor race — first caller binds an attacker-owned price feed | On-chain |
| **C-4** | Critical | Single-asset borrow HF bypass when `pyth_price_feed == 0` — hardcoded `2 × WAD` | On-chain |
| **C-5** | Critical | `IkaRelease` does not check outstanding debt — release of cross-chain collateral while still borrowed | On-chain |
| **C-6** | Critical | Mock instructions have no runtime authority guard — full price/fee override if built with `--features testing` | On-chain |
| **C-7** | Critical | Frontend SSRF + cache poison via user-supplied `rpc` (still unfixed from prior audit) | Frontend |
| **C-8** | Critical | `POST /api/transactions` accepts arbitrary `action` and unverified `signature` — audit-trail forgery | Frontend |
| **H-1** | High | `Repay` double-credits `total_deposits` — utilization-rate drift | On-chain |
| **H-2** | High | Pyth oracle owner check too weak — any third-party program passes | On-chain |
| **H-3** | High | Cross-borrow / cross-liquidate trust caller-supplied collateral list — pool omission inflates apparent HF | On-chain |
| **H-4** | High | No `liquidator != borrower` check (single + cross liquidate) — bonus-skim & combined exploit primitive | On-chain |
| **H-5** | High | Hardcoded user-specific keypair path in 5 production scripts | Ops |
| **H-6** | High | Database credentials in `.env.local` (still present from prior audit) | Frontend |
| **H-7** | High | Origin-header fallback to `http://localhost:4321` (still present) | Frontend |
| **M-1** | Medium | First-deposit share inflation — minimum-deposit not enforced | On-chain |
| **M-2** | Medium | `Repay` silently caps over-repayment, no error returned | On-chain |
| **M-3** | Medium | Pool authority is a free-form pubkey, not a PDA — set-once-and-forever invariant relies on init flow | On-chain |
| **M-4** | Medium | `set_pool_decimals` (disc `0x15`) reachable post-init — admin can re-shape USD math | On-chain |
| **M-5** | Medium | `update_oracle_price` is permissionless — anyone can refresh, frontrun-anchor, or DoS via stale-price spam | On-chain |
| **M-6** | Medium | Frontend ships `mockOracleIx` / `mockFeesIx` builders in production SDK | Frontend |
| **M-7** | Medium | No rate limiting on public API endpoints (still present) | Frontend |
| **L-1** | Low | `FLASH_PROTOCOL_SHARE_BPS` / `FLASH_LP_SHARE_BPS` constants are dead code; `split_flash_fee` hardcodes `/10` | On-chain |
| **L-2** | Low | `flash_fee(amount, 9)` rounds to 0 for `amount < 1112` — sub-dust free flash loans | On-chain |
| **L-3** | Low | NaN-tainted pagination params in `/api/transactions` (still present) | Frontend |
| **L-4** | Low | No CSP / security headers (still present) | Frontend |
| **L-5** | Low | Public admin allowlist & audit log (still present) | Frontend |
| **L-6** | Low | `IkaDwalletPosition::LIQUIDATED` status defined but never written | On-chain |

---

## Critical findings — full detail

### C-1. Vault-substitution drain (deposit/withdraw/borrow/repay/liquidate)

**Files & lines:**
- `programs/src/instructions/deposit.rs:180` — `Transfer::new(&accounts[1], &accounts[2], &accounts[0], self.amount).invoke()?;`
- `programs/src/instructions/withdraw.rs:142` — `Transfer::new(&accounts[2], &accounts[1], &accounts[5], token_amount).invoke_signed(&[signer])?;`
- `programs/src/instructions/borrow.rs:154` — same pattern
- `programs/src/instructions/repay.rs:92` — same pattern
- `programs/src/instructions/liquidate.rs:151,163` — both transfer legs
- `programs/src/instructions/cross_*.rs` — same pattern (verified in agent audit)
- `programs/src/state/lending_pool.rs:56` — `pub vault: Address` (stored at init, never enforced afterwards)

**Bug.** `LendingPool` stores the vault address at initialization (`lending_pool.rs:175`, `pool.vault = *vault`), but **no instruction handler ever compares `accounts[2].address()` against `pool.vault`**. The only implicit constraint is that, on outgoing transfers, the source vault must be owned by the `pool_authority` PDA so the SPL signer derivation matches. Anyone can create another SPL token account whose owner field is that PDA, and any token account at all can be passed as the *destination* on incoming transfers.

**Drain.**
1. Attacker creates `evil_mint` (they are the mint authority) and an `evil_user_token` holding `1_000_000_000` evil tokens.
2. Attacker creates `evil_vault` — an SPL token account with `mint = evil_mint` and any owner (does not need to be the PDA, since the deposit transfer is signed by the *user*, not the PDA).
3. `Deposit { amount = 1_000_000_000 }` with `accounts[2] = evil_vault`. SPL transfer succeeds (user owns `evil_user_token`, mints match). Program increments `position.deposit_shares` proportionally and `pool.total_deposits` by `1_000_000_000`.
4. `Borrow { amount = available_real_liquidity }` with `accounts[2] = real_vault` (the legitimate one). The PDA-signed transfer from `real_vault → attacker_user_token_REAL` succeeds because the program does not check that `accounts[2] == pool.vault`. Attacker walks away with the real underlying.

**Fix.** In every handler that consumes `accounts[2]`:
```rust
if *accounts[2].address() != pool.vault {
    return Err(LendError::InvalidVault.into());
}
```
This is one line per handler and closes every variant of the attack.

---

### C-2. Flash-loan vault substitution → free flash loan + state desync

**Files:** `programs/src/instructions/flash_borrow.rs:54-115`, `flash_repay.rs:43-85`

**Bug.** Same root cause as C-1 — neither handler validates `accounts[2] == pool.vault`. In `FlashBorrow` the vault must be owned by the `pool_authority` PDA for the signed transfer to clear, so the *source* leg pins to the real vault. In `FlashRepay` (line 70) the transfer is `borrower_token → vault` signed by the **user**, so `accounts[2]` can be **any token account the attacker chooses** — including one they own.

**Drain.**
1. `FlashBorrow { amount = available_liquidity }` with `accounts[2] = real_vault`. Real vault sends tokens to attacker. `pool.flash_loan_amount = X`.
2. `FlashRepay` (same tx or any later tx — see C-2b on atomicity) with `accounts[2] = attacker_owned_token_account_with_same_mint`. The program transfers `X + fee` from attacker's `borrower_token` to attacker's own `vault` substitute. State updates: `flash_loan_amount = 0`, `total_deposits += lp_fee`, `accumulated_fees += protocol_fee`.
3. Net: attacker has `X` real tokens, paid zero fee, and the protocol's accounting now permanently mis-tracks `total_deposits` (inflated by the phantom `lp_fee`) and `accumulated_fees` (inflated by phantom `protocol_fee`). Repeat until vault is empty.

**C-2b — atomicity is also weak.** The docstring says "MUST include a FlashRepay later in the same transaction". There is **no** introspection sysvar enforcement — `FlashBorrow` returns `Ok(())` whether or not `FlashRepay` ever fires. Without C-2 (vault check), this alone is not yet a drain because `pool.flash_loan_amount` blocks future flash loans, but it is a denial-of-flash-loan vector and amplifies C-2 once vault validation is added.

**Fix.** (i) `if *accounts[2].address() != pool.vault { return Err(...) }` in both handlers. (ii) Add introspection-sysvar check (or a guarded `flash_in_flight` invariant on every other state-mutating instruction) so `FlashBorrow` cannot persist without a matching `FlashRepay` in the same tx.

---

### C-3. Oracle anchor frontrun + permissive owner check

**File:** `programs/src/instructions/update_oracle_price.rs:43-86`

**Bug.** The oracle owner check rejects only two cases:
```rust
if oracle_owner == &SYSTEM_PROGRAM || oracle_owner == program_id {
    return Err(LendError::OracleInvalid.into());
}
```
Any third-party program owner passes. `pyth::read_price` then validates magic bytes and aggregate status, but those bytes are user-controlled when the account is owned by an attacker-controlled program. On the **first** call to `UpdateOraclePrice` for a freshly-initialized pool, line 76 anchors `pool.pyth_price_feed = feed_addr` permanently. The instruction has no signer requirement at all (`fn process` does not call `is_signer()` on any account).

**Drain.**
1. Pool is initialized with `pyth_price_feed = [0u8; 32]`.
2. Attacker deploys `fake_pyth` program. Creates `fake_oracle` account owned by it; writes Pyth-shaped bytes (magic, status `Trading`, recent timestamp, attacker-chosen price/expo).
3. Attacker calls `UpdateOraclePrice(pool, fake_oracle)` *before* any legitimate keeper. `pool.pyth_price_feed` is now anchored to `fake_oracle`.
4. Subsequent legitimate calls with the real Pyth feed are rejected by line 77 (`OraclePriceFeedMismatch`). The pool is permanently bound to attacker's price source.
5. Attacker drains via cross-pool operations: set price absurdly high on their collateral pool, borrow against the inflated USD value; or set price to zero on someone else's collateral pool and liquidate.

**Fix.** (a) Hardcode the legitimate Pyth program ID(s) as a strict allowlist. (b) Make the first-anchor call gated by `pool.authority` signer: `if pool.pyth_price_feed == zero && !accounts[?].is_signer_matching(pool.authority) { return Err }`. (c) Require `Initialize` to set `pyth_price_feed` directly, eliminating the race entirely.

---

### C-4. Single-asset HF bypass when `pyth_price_feed == 0`

**File:** `programs/src/instructions/borrow.rs:61-66`

```rust
let hf = if pool.pyth_price_feed == [0u8; 32].into() {
    // Mock health factor for localnet testing when no oracle is anchored
    math::WAD * 2 // Always healthy
} else {
    math::health_factor(deposit_balance, debt_after, pool.liquidation_threshold)?
};
```

**Bug.** This branch is reachable in **production** until someone anchors a Pyth feed. It is a "localnet testing" shortcut written into the production handler with no `cfg` gate.

**Realistic exploit.** Single-asset HF only depends on `deposit_balance × LIQ_THRESHOLD / debt`, so the *direct* effect of bypassing it for same-asset positions is bounded by the `max_borrowable = deposit × LTV` check at line 55-59 (which still runs). However:
- Combined with **C-1**, an attacker who deposits via fake vault can grow their `position.deposit_shares` arbitrarily; this passes `max_borrowable` at LTV `0.75`. The HF check would normally also fail (deposit/debt math) but the bypass returns `2 × WAD` unconditionally.
- Combined with **C-3**, an attacker holding the oracle anchor can choose to leave `pyth_price_feed` *zero* on a victim pool while still using cross-pool flows that reference it via cached price, producing inconsistent risk evaluation.
- For pools deliberately deployed without an oracle (e.g., test pools an admin forgot to anchor), this is an immediate full bypass.

**Fix.** Delete the branch. Require oracle anchored before any borrow:
```rust
if pool.pyth_price_feed == [0u8; 32].into() {
    return Err(LendError::OracleNotAnchored.into());
}
let hf = math::health_factor(deposit_balance, debt_after, pool.liquidation_threshold)?;
```

---

### C-5. `IkaRelease` does not verify outstanding debt

**File:** `programs/src/instructions/ika_release.rs:47-106`

**Bug.** The docstring (line 4) says "The position must have no outstanding borrows against it (enforced by checking the pool's accounting for this user)." The implementation checks owner, dwallet, status, but **never** loads any `UserPosition`/`LendingPool` to verify zero debt. After validation it CPIs `transfer_dwallet` back to the user (line 90) and marks the position `RELEASED`.

**Drain.**
1. User deposits 1 BTC via `IkaRegister` (BTC stays on Bitcoin mainnet; dWallet authority transferred to Veil's CPI PDA).
2. User borrows USDC against this collateral via the on-Solana side.
3. User calls `IkaRelease`. dWallet authority is transferred back to the user's pubkey on Bitcoin mainnet.
4. User signs a Bitcoin transaction with the dWallet, draining the BTC to themselves.
5. The Veil pool's USDC vault is short by the borrowed amount; no mechanism to recover (BTC is on a different chain, no collateral remains).

**Fix.** Load `UserPosition` for `(user, pool)` and require `borrow_principal == 0` AND `cross_collateral == 0` before releasing. Also reject if the user has any debt in *any* pool that may have been backed by this dWallet.

---

### C-6. Mock instructions have no runtime authority check

**Files:** `programs/src/instructions/mock_oracle.rs:14,37-53`; `programs/src/instructions/mock_fees.rs` (same pattern, discriminator `0xFE`)

**Bug.** The file is gated by `#![cfg(feature = "testing")]`, so it is excluded from default `cargo build-sbf`. But:
- `Cargo.toml` declares `[features] testing = []` — easy to enable accidentally.
- Inside `process`, the only guard is `accounts[0].is_signer()`. **No comparison against `pool.authority` or any hardcoded admin.** Any signer can rewrite `pool.oracle_price`, `pool.oracle_expo`, and force-anchor `pool.pyth_price_feed = [1u8;32]` (line 47).
- `MockFees` (per agent audit) injects 100 tokens of fees into `accumulated_fees` — an attacker calling `CollectFees` can drain.

**Defense in depth gap.** A single CI mistake or a dev who runs `cargo build-sbf --features testing` and deploys = total compromise of every pool. There is no second wall.

**Fix.** Inside both `process` functions, add `if *accounts[0].address() != HARDCODED_ADMIN_PUBKEY { return Err(...) }` — even when the feature is on. Also add a build-time check in CI that mainnet artifacts are not produced with `--features testing`.

---

### C-7. SSRF + cache poisoning via user-supplied `rpc` (unfixed)

**Files:** `veil-landing/app/api/pools/sync/route.ts:16-19`; `veil-landing/app/api/positions/sync/route.ts:19-22`

Verified still present. See `veil-landing/SECURITY_AUDIT.md` C1/C2 for full discussion. Frontend agent verified no fix has landed. Combined with frontend RPC-driven state-decoder offsets (`lib/veil/state.ts:80-115`), an attacker can inject arbitrary pool state into the cache that admins read when deciding whether to liquidate.

**Fix.** Remove the `rpc` parameter. Use the server-side trusted endpoint only.

---

### C-8. Tx-log forgery via unauthenticated POST

**File:** `veil-landing/app/api/transactions/route.ts:124-143`

Verified still present. POST accepts any `action` string, any `signature` string, any `wallet`, any `amount`. There is no whitelist (the GET endpoint does have one, line 57 — but the POST handler omits it) and no on-chain verification of the claimed signature. Audit trail can be polluted with fake "liquidation" / "admin_override" / etc. records that admins may rely on.

**Fix.** Apply the same `VALID_ACTIONS` whitelist. Either (a) verify `signature` exists on-chain via RPC before insert, or (b) require an Ed25519 signature from `wallet` over the row contents.

---

## High-severity findings

### H-1. `Repay` double-credits `total_deposits`

**File:** `programs/src/instructions/repay.rs:102-107`

```rust
{
    let pool = LendingPool::from_account_mut(&accounts[3])?;
    pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
    pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);
}
```

**Bug.** `total_deposits` already grows correctly inside `accrue_interest` (`lending_pool.rs:252`: `self.total_deposits += dep_int`). When a borrower repays, the principal portion goes back to the vault (does not change LP claim) and the interest portion has *already* been credited to `total_deposits` via accrual. Adding the full `repay_amount` here is double-counting.

**Effect.** `total_deposits` drifts upward over the life of the pool. Two follow-on consequences:
- `utilization_rate(total_borrows, total_deposits)` is artificially low → `borrow_rate` is artificially low → protocol earns less interest than designed.
- `available = total_deposits − total_borrows − accumulated_fees` reports more liquidity than the vault actually holds → user-facing borrow/withdraw checks pass but the SPL transfer fails confusingly.

**Fix.** Delete line 106. `total_deposits` is mutated only on real LP deposits, accrual, and withdrawals.

---

### H-2. Pyth oracle owner check too permissive

See **C-3**. Same root cause; the High rating here is the residual risk *after* the anchor race is closed but the owner-allowlist still rejects only two specific owners. Hardcode the real Pyth program IDs.

---

### H-3. Cross-borrow / cross-liquidate collateral list is caller-supplied

**Files:** `programs/src/instructions/cross_borrow.rs:191-217`; `cross_liquidate.rs:215-246`

**Bug.** Trailing accounts are interpreted as the borrower's collateral pools/positions; the program iterates whatever is passed and trusts it is the complete set. There is no on-chain registry mapping `user → list_of_pools_with_open_positions`.

**Exploit (cross-borrow):** attacker omits a debt-bearing pool from the list; the global `total_debt_usd` is undercounted, so the LTV check passes for a borrow that should be denied. They borrow above true LTV and become immediately liquidatable — but only against the listed collateral, leaving the omitted pool's debt unsecured.

**Exploit (cross-liquidate):** liquidator omits a high-value collateral pool from the borrower's list; computed `weighted_collateral_usd` is too low, HF appears below 1, liquidation succeeds against an actually-healthy position.

**Fix.** Maintain a `user_pool_index` PDA listing every pool the user has touched; require the caller to pass exactly the indexed set; reject if the count doesn't match.

---

### H-4. No `liquidator != borrower` check

**Files:** `programs/src/instructions/liquidate.rs:124-200`, `cross_liquidate.rs:124-264`

The handler never compares `accounts[0]` to the position owner. Self-liquidation is wealth-neutral *within the user's combined wallet+position view* but lets the user (a) preempt other liquidators and capture the bonus they would have lost anyway, and (b) reset their position state on demand. More importantly, when chained with C-1 (vault substitution), the same primitive becomes a free seizure of pool collateral against attacker-controlled phantom debt.

**Fix.** Add `if *accounts[0].address() == pos.owner { return Err(LendError::SelfLiquidation.into()) }`.

---

### H-5. Hardcoded developer keypair path in production scripts

**Files (verified by grep):**
- `veil-landing/scripts/test-cross-borrow.ts:52` — `path.resolve("/Users/eshan/my-solana-testing-dev-wallet.json")`
- `veil-landing/scripts/setup-localnet.ts:103` — same
- `veil-landing/scripts/test-repay.ts:19` — same
- `veil-landing/scripts/test-withdraw.ts:19` — same
- `veil-landing/scripts/e2e-test.ts:42` — `const PAYER_PATH = "/Users/eshan/my-solana-testing-dev-wallet.json";`
- `veil-landing/scripts/setup-project.ts:29` — `join(process.env.HOME ?? "~", "my-solana-testing-dev-wallet.json")`

**Risk.** If any of these scripts is wired into CI or run on a server, the runtime needs a file at that absolute path. Either the path leaks (deployment misconfiguration, log line) or, worse, the wallet file ends up inside a build artifact / Docker image. The path leaks the developer's username into every error message thrown by these scripts.

**Fix.** Replace with `process.env.SOLANA_KEYPAIR_PATH` and fail loudly if unset. Add a CI grep check that rejects `/Users/` / `/home/` substrings.

---

### H-6, H-7. (See prior audit — credentials still in `.env.local`; origin fallback still in `lib/auth/signature.ts:42-48`.)

---

## Medium-severity findings

### M-1. First-deposit share inflation

**File:** `programs/src/instructions/deposit.rs:69-72`

`shares = wad_div(amount, supply_index)`. On first deposit `supply_index = WAD`, so `shares = amount`. There is no minimum amount and no minimum-share check. Classic ERC4626-style inflation: attacker deposits `1`, gets `1` share; donates `1_000_000_000` directly to the vault SPL account (this is possible — the vault address is public). The next legitimate depositor of `1_000_000_000` gets `0` shares (rounded down) and the attacker now owns `100%` of `2_000_000_000` worth.

Note: the vault is not protected against direct SPL transfers; the program reads pool.total_deposits separately, so a direct vault donation does not increase total_deposits but **does** change the vault balance, breaking the invariant `vault.amount ≈ total_deposits − total_borrows + accumulated_fees`. Combined with H-1 (`total_deposits` drift), accounting is doubly inconsistent.

**Fix.** Enforce a minimum share count (e.g., `if shares < 1000 { return Err(DustAmount) }`) and burn the first 1000 shares to the program (Uniswap v2 trick).

### M-2. Silent over-repayment

**File:** `repay.rs:89` — `let repay_amount = self.amount.min(total_debt);`

If a user submits `Repay { amount: 2_000_000 }` against a `1_000_000` debt, the program silently transfers only `1_000_000`. From the user's wallet perspective, exactly `1_000_000` left their account, so this is not a fund loss in the strict sense, but UX-wise it can mask confusion (user expects "balance updated" feedback for the full amount).

**Fix.** Either return an error if `amount > total_debt`, or write `actual_repaid` into a return-data field so the frontend can display it.

### M-3. Pool authority is a free-form pubkey

**File:** `lending_pool.rs:52`, `initialize.rs:111`. `pool.authority = *authority` (signer in `Initialize`). No PDA derivation, no rotation rule, no multisig requirement. Whatever pubkey signs the init tx becomes the all-powerful pool admin.

**Fix.** Either bind authority to a hardcoded org multisig, or make it a PDA with seeds tied to a governance program.

### M-4. `set_pool_decimals` reachable post-init

The instruction (`disc 0x15`) lets the authority change `pool.token_decimals` at any time. This field is consumed by `math::token_to_usd_wad` in cross-collateral flows. A compromised or coerced authority can shift decimals to inflate or deflate USD valuations of every position in the pool.

**Fix.** Read decimals from the SPL mint at every cross-collateral computation, instead of trusting the cached field. Or make the field immutable after first set.

### M-5. `update_oracle_price` is fully permissionless

Any signer-less caller can refresh prices — useful for keepers, but also enables grief: an attacker can spam stale-but-still-fresh prices to pin the cached value at the bottom of a confidence band, or repeatedly anchor (per C-3) on every freshly initialized pool.

### M-6. Mock instruction builders shipped in production SDK

`veil-landing/lib/veil/instructions.ts:480-526` exports `mockOracleIx` (disc `0xFD`) and `mockFeesIx` (disc `0xFE`). These document the discriminators publicly and ship in the React bundle. Any user of the SDK can construct and send these instructions; they fail at the on-chain dispatch only because the program was not built with `--features testing`. If the program ever ships a build with that flag, the SDK is already armed.

### M-7. (No rate limiting — see prior audit.)

---

## Low-severity findings

### L-1. Dead flash-fee constants

**File:** `programs/src/math.rs:36-39`

```rust
pub const FLASH_PROTOCOL_SHARE_BPS: u64 = 10;
pub const FLASH_LP_SHARE_BPS: u64 = 90;
```

`split_flash_fee` (line 405) hardcodes `let protocol = fee / 10` and ignores both constants. Either remove the constants or wire them in (`fee × FLASH_PROTOCOL_SHARE_BPS / 100`). Currently they are documentation that lies.

### L-2. `flash_fee` rounds to zero for tiny amounts

`flash_fee(amount, 9) = amount × 9 / 10_000`. For `amount < 1112` the result is `0`. No minimum-loan-size enforced; a determined attacker can run unlimited zero-fee flash loans of `1111` units each. Negligible economic value individually, but combined with C-2 makes the drain scriptable without economic cost.

**Fix.** `let fee = max(1, amount × bps / 10_000)` for any non-zero amount, or `if amount < MIN_FLASH_AMOUNT { return Err(...) }`.

### L-3 – L-5. (NaN pagination, no CSP, public allowlist/audit log — see prior audit.)

### L-6. Unwritten dWallet status

`programs/src/state/ika_position.rs` defines `status::LIQUIDATED = 2` but no instruction ever writes it. If liquidation-via-dWallet is the intended cross-chain flow (per README), the wiring is incomplete.

---

## Dead code

| Location | Item | Note |
|---|---|---|
| `programs/src/math.rs:36-39` | `FLASH_PROTOCOL_SHARE_BPS`, `FLASH_LP_SHARE_BPS` | Defined; never referenced. `split_flash_fee` hardcodes `/ 10`. |
| `programs/src/state/ika_position.rs` | `status::LIQUIDATED` | Constant defined, never assigned. |
| `programs/src/instructions/set_pool_decimals.rs` | full instruction | Only called during setup; reachable forever (M-4). |
| `programs/src/instructions/borrow.rs:61-64` | "Mock health factor" branch | Reachable in production (C-4). |
| `programs/src/state/lending_pool.rs:113` | `_oracle_pad: [u8; 12]` | Layout padding — intentional, not actually dead. |
| `programs/src/state/user_position.rs:18` | `_pad_end: [u8; 14]` | Layout padding — intentional. |
| `veil-landing/lib/veil/state.ts:1-3` | `decodeLendingPool`, `decodeUserPosition` | Exported; not imported by any React component (UI uses API routes). |
| `veil-landing/lib/veil/instructions.ts:480-526` | `mockOracleIx`, `mockFeesIx` | Exported in production SDK (M-6). |
| `veil-landing/lib/veil/constants.ts:10` | `"11111111111111111111111111111111"` placeholder program ID fallback | Should `throw` on missing env, not silently fall through to System Program. |

---

## Mock / test code reachable in production

| Item | Location | Status |
|---|---|---|
| `MockOracle` (disc `0xFD`) | `programs/src/instructions/mock_oracle.rs` | Compiled out by default (`#![cfg(feature = "testing")]`). No runtime authority check (C-6). |
| `MockFees` (disc `0xFE`) | `programs/src/instructions/mock_fees.rs` | Same. |
| HF bypass for zero `pyth_price_feed` | `borrow.rs:61-64` | **Always compiled in.** Comment says "for localnet testing." (C-4) |
| `mockOracleIx` / `mockFeesIx` builders | `veil-landing/lib/veil/instructions.ts:480-526` | Always shipped to browser (M-6). |
| Hardcoded keypair path | 5 scripts under `veil-landing/scripts/` | Always shipped in repo (H-5). |
| `test-ledger/` | repo root | `.gitignore`d but present locally. |

---

## Findings already fixed since prior audit

After cross-checking each item from `veil-landing/SECURITY_AUDIT.md` against the live code, **no Critical/High items have been silently fixed**. C1, C2, C3, C4, H1, H2, H3, H4, H5, H6 all still reproduce. Only the math overflow tests have been hardened (math.rs now has explicit fallback paths and broad coverage).

---

## Remediation priority

**Day-zero (block mainnet):**
1. Add `accounts[2] == pool.vault` check to every handler (C-1, C-2).
2. Hardcode Pyth program ID allowlist & require pool-authority signer for first oracle anchor (C-3).
3. Remove the localnet HF-bypass branch from `borrow.rs` and any sibling handlers (C-4).
4. Add `borrow_principal == 0` check inside `IkaRelease` (C-5).
5. Add hardcoded admin runtime check in `MockOracle`/`MockFees`, and a CI guard against `--features testing` mainnet builds (C-6).
6. Strip the `rpc` parameter from `/api/pools/sync` and `/api/positions/sync` (C-7).
7. Apply `VALID_ACTIONS` whitelist + signature verification to `POST /api/transactions` (C-8).

**Week-one:**
8. Delete the duplicated `+= repay_amount` on `total_deposits` (H-1).
9. Require complete pool list in cross-borrow / cross-liquidate (H-3).
10. Add `liquidator != borrower` check (H-4).
11. Replace hardcoded keypair paths with env vars + CI grep (H-5).
12. Rotate `DATABASE_URL` credentials and move to a secret manager (H-6).
13. Require `Origin` header — no fallback (H-7).

**Pre-audit-window:**
14. Minimum-share enforcement / burn-first-1000 trick (M-1).
15. Make `pool.authority` a PDA or a multisig (M-3).
16. Make `pool.token_decimals` immutable post-init or read live from mint (M-4).
17. Wire `FLASH_PROTOCOL_SHARE_BPS` constants or delete them (L-1); enforce minimum flash amount (L-2).
18. Tree-shake `mockOracleIx`/`mockFeesIx` out of production SDK (M-6).

---

## Notes for the next reviewer

- `programs/src/math.rs` is the one part of the codebase that *is* well-defended: WAD overflow fallbacks, comprehensive tests, correct rounding direction. Trust it.
- The on-chain admin auth (`Initialize`, `UpdatePool`, `PausePool`, `ResumePool`, `CollectFees`) does correctly check `signer == pool.authority`. Once M-3 is closed (authority becomes a PDA / multisig), this layer is solid.
- `LendingPool::from_account` and `UserPosition::from_account` enforce discriminators correctly; account-impersonation via raw bytes will not succeed unless the attacker also gets program ownership of the account, which `check_program_owner` already covers.
- The **systemic** weakness of this codebase is account-list trust: caller-supplied vaults (C-1, C-2), oracles (C-3), and cross-pool collateral lists (H-3). Every one-line fix above closes a single instance of the same underlying pattern. A future invariant check (`account_at(idx).address() == pool.field`) helper would be high-leverage.
