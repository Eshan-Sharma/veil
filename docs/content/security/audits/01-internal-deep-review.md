---
title: "01 — Internal Deep Review"
description: Internal deep audit of Veil's on-chain math, oracle handling, frontend, and API surface.
---

# Internal Deep Review

**Date:** 2026-04-27
**Auditor:** Internal deep review (on-chain, math, oracle, frontend, API)

---

## FALSE POSITIVES ELIMINATED

Two things the automated scan flagged that are **NOT bugs**:

- **"Double division in accrue_interest"** — WRONG. The formula `total_borrows * b_rate * elapsed / SECONDS_PER_YEAR / WAD` is correct. `b_rate` is WAD-scaled, so dividing by both is mathematically equivalent to `borrows × (rate/WAD) × (elapsed/SECONDS_PER_YEAR)`. Verified with concrete numbers.

- **"Borrow principal accounting bug in Repay"** — WRONG. The code sets `borrow_principal = new_debt` AND updates `borrow_index_snapshot = current_index`. This is standard Aave-style rebasing: "close old position, open new one at current index." Future debt = `new_principal × future_index / current_index` — math checks out.

---

## CRITICAL — Must Fix Before Mainnet

### C1. Mock Health Factor Bypass in Single-Pool Borrow
**File:** `instructions/borrow.rs:61-63`
```rust
if pool.pyth_price_feed == [0u8; 32].into() {
    math::WAD * 2 // Always healthy
}
```
When a pool has no oracle anchored, the health factor is hardcoded to 200% — **any borrow passes**. If a pool is deployed without an oracle (misconfiguration or intentional griefing), users can borrow with zero effective collateralization. This is meant for localnet but the guard is runtime, not compile-time.

**Fix:** Gate behind `#[cfg(feature = "testing")]` or require oracle to be set before any borrows.

### C2. Anyone Can Update Oracle Prices
**File:** `instructions/update_oracle_price.rs`
The instruction takes **no signer**. Anyone can call `UpdateOraclePrice` to refresh the cached price. Combined with the 120-second staleness window, an attacker can:
1. Wait for a favorable price within the 120s window
2. Call `UpdateOraclePrice` to cache that price
3. Immediately cross-borrow against the (stale but valid) collateral value
4. Oracle updates to real price → position is undercollateralized

**Fix:** Reduce `MAX_ORACLE_AGE` to 10-30 seconds. Consider adding a freshness requirement: the Pyth timestamp must be within N seconds of the *current* slot, not just the last update.

### C3. No Vault Account Verification
**Files:** Every instruction that transfers tokens (deposit, withdraw, borrow, repay, flash_borrow, flash_repay, collect_fees, cross_borrow, cross_withdraw, cross_liquidate)

The vault account is **never verified** to be:
- The correct ATA for the pool's token mint
- Owned by the pool authority PDA
- Actually a token account at all

An attacker could pass any writable token account as the vault. The SPL token program CPI would fail if the authority doesn't match (for vault→user transfers), which provides *implicit* protection for outbound transfers. But for **inbound transfers** (deposit, repay), the user transfers tokens to whatever "vault" is passed — an attacker could substitute their own token account.

**Attack scenario for Deposit:**
1. Attacker creates a fake vault token account they control
2. Calls `Deposit` with the real pool but the fake vault
3. User's tokens go to the attacker's account
4. Pool state records the deposit (shares increase) but vault doesn't actually hold the tokens
5. Pool becomes insolvent — vault can't cover withdrawals

**Fix:** Derive the expected vault address on-chain and verify `accounts[vault_idx]` matches:
```rust
let expected_vault = get_associated_token_address(pool_authority, pool.token_mint);
if accounts[2].address() != &expected_vault { return Err(...); }
```

### C4. No Token Program Verification
**Files:** All transfer instructions

The token program account is never verified to be the actual SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). A malicious program could be passed that appears to succeed transfers without actually moving tokens.

For **PDA-signed transfers** (withdraw, borrow, flash_borrow), `invoke_signed` would fail if the signer doesn't match — but for **user-signed transfers** (deposit, repay), a fake token program could accept the call and do nothing, letting the user get pool shares without actually depositing tokens.

**Fix:** Add a constant check:
```rust
const SPL_TOKEN: Address = /* ... */;
if accounts[token_program_idx].address() != &SPL_TOKEN {
    return Err(LendError::InvalidTokenProgram.into());
}
```

---

## HIGH — Exploitable Under Specific Conditions

### H1. Oracle First-Anchor Is Irreversible and Permissionless
**File:** `update_oracle_price.rs:74-76`
The first call to `UpdateOraclePrice` permanently anchors the Pyth feed address. Since no signer is required, a front-runner could anchor a **wrong/malicious feed** to a pool immediately after initialization, permanently corrupting its price source.

**Fix:** Only allow pool authority to anchor the first feed. Add signer check when `pyth_price_feed == [0u8; 32]`.

### H2. Missing `check_program_owner` in Admin Instructions
**Files:** `update_pool.rs`, `pause_pool.rs`, `resume_pool.rs`, `collect_fees.rs`

These instructions verify `pool.authority == signer` but **don't verify the pool account is owned by the Veil program**. An attacker could create a fake account with `authority` set to their own pubkey, call `UpdatePool`, and modify their own fake account. If any other instruction reads that fake account thinking it's a real pool, it could be exploited.

The risk is mitigated because other instructions DO call `check_program_owner`. But defense-in-depth says admin instructions should also verify.

**Fix:** Add `check_program_owner(&accounts[1], program_id)?` to all admin instructions.

### H3. Cross-Collateral Flag Orphaning via Regular Repay
Once `CrossBorrow` sets `cross_collateral = 1` on collateral positions, regular `Repay` can fully repay the debt — but it **doesn't clear the cross_collateral flag**. Only `CrossRepay` clears the flag. This means:
- User borrows cross-collateral, gets flag set to 1
- User repays via regular `Repay` (succeeds — no flag check on repay)
- Flag remains 1, user is **permanently locked into `CrossWithdraw`** (which requires oracle and all related positions)
- This is a denial-of-service on the user's collateral

**Fix:** Either block regular `Repay` when position has cross-collateral debt, or clear the flag in `Repay` when `borrow_principal` reaches 0.

### H4. Oracle Confidence Interval Too Wide (2%)
**File:** `pyth/mod.rs:77`
```rust
if (conf as u128) * 50 > (price as u128) {
```
A 2% confidence interval on a $10M collateral position means $200K of uncertainty. During volatile markets, this gives attackers significant room to borrow against inflated collateral values.

Aave uses 0.5-1% depending on the asset. At 2%, an attacker could systematically extract value by borrowing at the top of the CI band.

**Fix:** Tighten to `conf * 100 > price` (1%) or make configurable per-pool.

### H5. FlashBorrow Doesn't Verify Pool Ownership
**File:** `flash_borrow.rs:54`
`FlashBorrow::process` uses `_program_id` (ignores it) and never calls `check_program_owner` on the pool account. Any account with the correct discriminator bytes could be passed.

**Fix:** Add `check_program_owner(&accounts[3], program_id)?`.

---

## MEDIUM — Should Fix

### M1. 120-Second Oracle Staleness Window
`MAX_ORACLE_AGE = 120` is extremely wide for Solana (300 blocks). Crypto markets can move 5-10% in 2 minutes during events. Combined with permissionless oracle updates (C2), this creates a large attack surface.

**Fix:** Reduce to 10-30 seconds.

### M2. Precision Loss in Small Interest Accruals
`accrue_indices` computes `borrow_rate_wad * elapsed / SECONDS_PER_YEAR`. For small elapsed values (1s) and small rates (1% = 1e16), the result is ~316,887 — roughly correct but loses ~13% of true value due to integer division ordering. Over many small accruals, interest is systematically undercounted.

**Fix:** Use `wad_mul(rate, elapsed) / SECONDS_PER_YEAR` to preserve more precision, or accumulate fractional remainders.

### M3. Liquidate Doesn't Verify Borrower Position Binding to Pool
**File:** `liquidate.rs:124-148`
The `Liquidate` instruction checks `check_program_owner` on the borrower position but never calls `verify_binding`. It doesn't need the borrower's identity (liquidation is permissionless), but it also doesn't verify the position actually belongs to the passed pool. If an attacker passes a position from Pool A while the pool account is Pool B, the health factor computation would use Pool B's indices against Pool A's principal/shares — potentially allowing liquidation of healthy positions.

**Fix:** Add `pos.verify_binding_pool(accounts[3].address())?` (pool-only check, no owner needed).

### M4. `token_to_usd_wad` Truncates on Negative scale_exp
When `scale_exp < 0`, the function does `base / divisor` which truncates. For assets where `18 + oracle_expo - token_decimals < 0`, small amounts lose precision. This systematically undervalues collateral, which could prevent users from borrowing their full entitlement.

### M5. `SetPoolDecimals` Can Be Called After Positions Exist
Changing `token_decimals` mid-lifecycle changes the USD valuation of all existing positions. An admin could (accidentally or maliciously) change decimals from 6 to 9, making all USDC collateral worth 1000x less instantly, triggering mass liquidations.

**Fix:** Only allow setting decimals when `total_deposits == 0`.

### M6. No Oracle Expo Bounds Check
`oracle_expo` is stored as `i32`. If Pyth returns extreme values (e.g., expo = -50), `10u128.checked_pow(50)` in `token_to_usd_wad` causes overflow → transaction reverts → all borrow/withdraw/liquidate operations freeze for that pool.

**Fix:** Validate `-18 <= oracle_expo <= 18` in `update_oracle_price`.

---

## LOW — Defense-in-Depth

| # | Finding | Location |
|---|---------|----------|
| L1 | `split_flash_fee` always rounds in LP's favor (up to 9 wei/tx) | `math.rs:394` |
| L2 | Dust positions (1 wei deposits) create abandoned PDA accounts | `deposit.rs` |
| L3 | No rate limiting on `accrue_interest` (anyone can call repeatedly) | All instructions |
| L4 | `wad_div` fallback `part1 * 2` loses up to 1 WAD precision for extreme values | `math.rs:99` |
| L5 | Front-running risk on liquidation txs (MEV on Solana) | `liquidate.rs` |

---

## Frontend / API Findings

| Sev | Finding | Location |
|-----|---------|----------|
| HIGH | Admin page is client-side gated only — any wallet can view the full UI | `admin/page.tsx` |
| MED | `decodeLendingPool()` doesn't validate discriminator before parsing | `state.ts:73` |
| MED | `percentToWad()` doesn't bounds-check input (negative or >100%) | `admin/page.tsx` |
| MED | No CSRF protection on admin allowlist API | `api/admin/allowlist/route.ts` |
| LOW | No rate limiting on public API endpoints | `api/pools/route.ts` |
| LOW | Missing Content-Type validation on POST endpoints | Multiple |

Note: `.env.local` with DB credentials is properly `.gitignore`'d — not a live issue unless git history was already pushed with it.

---

## Priority Fix Order

1. **C3 (vault verification)** + **C4 (token program verification)** — most exploitable; deposit/repay can be redirected
2. **C1 (mock HF bypass)** — compile-time gate it
3. **H1 (oracle first-anchor)** — add signer requirement
4. **H3 (cross-collateral flag orphaning)** — blocks user withdrawals
5. **C2 (permissionless oracle)** + **M1 (staleness)** — tighten oracle security
6. **H2 (admin check_program_owner)** — defense-in-depth
7. **M3 (liquidate position binding)** — prevents cross-pool liquidation abuse
8. **M5 (decimals after deposits)** — prevent admin foot-gun
9. **M6 (oracle expo bounds)** — prevent protocol freeze
