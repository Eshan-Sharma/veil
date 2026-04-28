---
title: "02 — Adversarial Audit"
description: Attacker-first review of every on-chain instruction handler, state struct, and math function.
---

# Adversarial Security Audit

**Date:** 2026-04-28
**Scope:** Full on-chain program (`programs/src/`), all 30 instructions
**Approach:** Attacker-first — every finding includes a concrete exploit path
**Auditor:** Deep code review of every instruction handler, state struct, and math function

---

## EXECUTIVE SUMMARY

The Veil lending protocol has **6 Critical**, **5 High**, **7 Medium**, and **4 Low** severity findings. Three of the critical findings are **novel** (not in the existing internal audit). The most dangerous is a **total_deposits inflation bug in Repay** that creates a slow insolvency, and a **selective position omission attack** on cross-collateral operations that lets attackers liquidate healthy positions or borrow against phantom collateral.

| Severity | Count | Fund Risk                                |
| -------- | ----- | ---------------------------------------- |
| Critical | 6     | Direct fund theft or protocol insolvency |
| High     | 5     | Exploitable under specific conditions    |
| Medium   | 7     | Should fix before mainnet                |
| Low      | 4     | Defense-in-depth                         |

---

## CRITICAL — Immediate Fund Risk

### CRIT-1: Repay Inflates `total_deposits` — Slow Insolvency (NEW)

**Files:** `repay.rs:105-107`, `cross_repay.rs:112-114`, `cross_liquidate.rs:305-308`
**Severity:** CRITICAL
**Status:** NOT in existing audit

Every repayment path adds the repaid amount to `total_deposits`:

```rust
// repay.rs:105-107
pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);  // BUG
```

**Why this is wrong:** `total_deposits` represents the value owed to depositors. When a borrower repays, tokens return to the vault and `total_borrows` decreases — but depositors' claims don't change. The depositor share of interest is already accounted for in `accrue_interest` via `total_deposits += dep_int`.

**Exploit — Inflate Available Liquidity:**

```
1. Attacker deposits 1,000 USDC → total_deposits = 1,000
2. Borrow 750 USDC (75% LTV)    → total_borrows = 750, vault = 250
3. Repay 750 USDC               → total_borrows = 0, total_deposits = 1,750 (BUG)
4. Repeat 100×                  → total_deposits = 76,000, vault = 1,000
```

**Impact:**

- `available = total_deposits - total_borrows - fees` is massively inflated
- Borrow/withdraw liquidity checks pass but SPL transfers fail (vault empty) → protocol becomes unusable
- Utilization = `total_borrows / total_deposits` is artificially low → depositors earn less interest (systematic value extraction)
- Over time, the protocol's accounting diverges from reality — depositors collectively believe they are owed far more than the vault holds

**Fix:** Remove the `total_deposits` addition from all three repay paths:

```rust
// Correct repay accounting:
pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
// Do NOT touch total_deposits — depositor claims are unchanged
```

---

### CRIT-2: Selective Position Omission in Cross-Collateral (NEW)

**Files:** `cross_borrow.rs:178-217`, `cross_withdraw.rs:148-185`, `cross_liquidate.rs:216-246`
**Severity:** CRITICAL
**Status:** NOT in existing audit

All cross-collateral operations compute global health factor from **user-provided** trailing account pairs. The protocol has NO way to verify that ALL of a user's positions are included. An attacker can strategically omit positions to manipulate the computed HF.

**Attack Vector A — Steal Collateral via CrossLiquidate:**

```
Victim has:
  Pool A: $10,000 SOL deposit (the big one)
  Pool B: $500 USDC deposit, $8,000 USDC debt
  Pool C: $200 USDC deposit

Real global HF: ($10,000×0.8 + $500×0.8 + $200×0.8) / $8,000 = 1.07 (healthy)

Attacker calls CrossLiquidate with ONLY Pool B and Pool C (omits Pool A):
Computed HF: ($500×0.8 + $200×0.8) / $8,000 = 0.07 (appears underwater)
Liquidation proceeds — attacker seizes $4,200 of victim's collateral from a HEALTHY position
```

**Attack Vector B — Phantom Borrowing via CrossBorrow:**

```
Attacker has:
  Pool A: $10,000 deposit (collateral)
  Pool B: $7,000 existing debt (omitted)

Attacker calls CrossBorrow on Pool C, includes only Pool A as collateral:
System sees: $10,000 × 0.75 LTV = $7,500 capacity, $0 existing debt
Attacker borrows $7,500 from Pool C
Real situation: $7,500 + $7,000 = $14,500 total debt against $10,000 collateral = insolvent
```

**Attack Vector C — Escape Collateral via CrossWithdraw:**

```
User has cross-collateral debt. Calls CrossWithdraw and omits the pool with the biggest debt.
HF appears healthy → withdrawal succeeds → remaining positions are undercollateralized.
```

**Fix:** The protocol needs an on-chain registry of all cross-collateral positions per user, or it must require a canonical ordered list of ALL positions (verified against a stored bitmap/counter). Without this, the cross-collateral system is fundamentally broken.

---

### CRIT-3: No Vault Account Verification

**Files:** Every instruction that transfers tokens (deposit, withdraw, borrow, repay, flash_borrow, flash_repay, collect_fees, cross_borrow, cross_withdraw, cross_liquidate)
**Severity:** CRITICAL
**Status:** Matches existing audit C3

The pool stores `vault: Address` at offset 72, but **no instruction ever compares the passed vault account against `pool.vault`**. The stored address is dead data.

**For inbound transfers (deposit, repay):** A compromised frontend or man-in-the-middle could redirect user tokens to an attacker-controlled account. The pool records the deposit/repay in state, but the vault never receives the tokens.

**For outbound transfers:** The PDA signature check on `invoke_signed` provides implicit protection — the PDA won't own a fake vault. But this is accidental security, not intentional.

**Fix:** In every instruction, after reading the pool:

```rust
if accounts[VAULT_IDX].address() != &pool.vault {
    return Err(LendError::InvalidVault.into());
}
```

---

### CRIT-4: No Token Program Verification

**Files:** All transfer instructions
**Severity:** CRITICAL
**Status:** Matches existing audit C4

No instruction verifies that the token program account is `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. A malicious program passed in its place could:

- Accept `Transfer` calls without actually moving tokens
- Combined with CRIT-3, allows depositing "phantom tokens" (fake program says transfer succeeded, state records deposit, vault has nothing)

**Fix:** Add constant check:

```rust
const SPL_TOKEN_PROGRAM: Address = pinocchio_token::ID;
if accounts[TOKEN_PROGRAM_IDX].address() != &SPL_TOKEN_PROGRAM {
    return Err(LendError::InvalidTokenProgram.into());
}
```

user comments: it can be p-token as well, token 22 or spl token, check online what all token standards are there and choose the safe ones.

---

### CRIT-5: Liquidate Missing Position-Pool Binding

**File:** `liquidate.rs:124-148`
**Severity:** CRITICAL (upgraded from existing audit M3)
**Status:** In existing audit as M3, but severity is understated

`Liquidate` calls `check_program_owner` on both pool and position, but **never calls `pos.verify_binding(_, pool_addr)`**. An attacker can pass a position from Pool A with Pool B:

**Exploit — Liquidate Healthy Positions:**

```
Pool A: supply_index = WAD (new pool, no interest accrued)
Pool B: supply_index = 2×WAD (mature pool, 100% interest accrued)

Victim's position in Pool B: 1000 shares (worth 2000 tokens), 1500 token debt
Real HF = (2000 × 0.8) / 1500 = 1.067 (HEALTHY)

Attacker passes Pool A + Victim's position:
Computed deposit_balance = 1000 × WAD / WAD = 1000 (using Pool A's index!)
Computed HF = (1000 × 0.8) / 1500 = 0.533 (appears UNDERWATER)
→ Attacker liquidates a perfectly healthy position, stealing collateral
```

**Fix:**

```rust
let pos = UserPosition::from_account(&accounts[4])?;
if &pos.pool != accounts[3].address() {
    return Err(ProgramError::InvalidAccountData);
}
```

---

### CRIT-6: Mock Health Factor Bypass in Borrow

**File:** `borrow.rs:61-63`
**Severity:** CRITICAL
**Status:** Matches existing audit C1

```rust
if pool.pyth_price_feed == [0u8; 32].into() {
    math::WAD * 2 // Always healthy — any borrow passes HF check
}
```

Not compile-time gated. Any pool without an oracle allows borrows constrained only by LTV (no HF enforcement). Combined with the permissionless oracle anchoring (see HIGH-1), an attacker could prevent the oracle from being set, keeping the pool permanently in mock mode.

**Fix:** Gate behind `#[cfg(feature = "testing")]` or reject borrows when no oracle is anchored.
user cooments: I need no hardcoded values especially for math

---

## HIGH — Exploitable Under Specific Conditions

### HIGH-1: Permissionless Oracle First-Anchor Front-Running

**File:** `update_oracle_price.rs:71-76`
**Severity:** HIGH
**Status:** Matches existing audit H1 + C2

`UpdateOraclePrice` requires no signer. The first call permanently anchors the Pyth feed. An attacker can front-run pool initialization to anchor a malicious/wrong feed, permanently corrupting the pool's price source.

**Combined with C2 (permissionless updates):** Anyone can call `UpdateOraclePrice` to cache a favorable price within the 120-second staleness window, then immediately cross-borrow against inflated collateral.

**Fix:** Require pool authority signer when `pyth_price_feed == [0; 32]` (first anchor). Reduce `MAX_ORACLE_AGE` to 30 seconds.

---

### HIGH-2: Cross-Collateral Flag Orphaning via Regular Repay

**Files:** `repay.rs`, `cross_borrow.rs:273-277`
**Severity:** HIGH
**Status:** Matches existing audit H3

Once `CrossBorrow` sets `cross_collateral = 1` on collateral positions, regular `Repay` can fully repay the debt without clearing the flag. Only `CrossRepay` clears it. Result: user's collateral is **permanently locked** — they're forced through `CrossWithdraw` (requiring oracle + all related positions) forever.

**Fix:** In `repay.rs`, when `new_debt == 0`, clear `cross_collateral` flag.

---

### HIGH-3: Missing `check_program_owner` in Multiple Instructions

**Files:** `update_pool.rs`, `pause_pool.rs`, `resume_pool.rs`, `collect_fees.rs`, `flash_borrow.rs`, `flash_repay.rs`, `update_oracle_price.rs`
**Severity:** HIGH
**Status:** Partially in existing audit (H2, H5)

Seven instructions skip `check_program_owner`:

| Instruction       | Uses `_program_id` (ignored) | Impact                     |
| ----------------- | ---------------------------- | -------------------------- |
| UpdatePool        | Yes                          | Fake pool can be "updated" |
| PausePool         | Likely                       | Fake pool can be "paused"  |
| ResumePool        | Likely                       | Fake pool can be "resumed" |
| CollectFees       | Yes                          | Fees from fake pool        |
| FlashBorrow       | Yes                          | Flash loan from fake pool  |
| FlashRepay        | Yes                          | Flash repay to fake pool   |
| UpdateOraclePrice | No (uses it)                 | Oracle on unverified pool  |

While most of these only modify fake accounts (not exploitable alone), the combination with other bugs creates risk. FlashBorrow + FlashRepay on fake pools could be used for arbitrage or to confuse off-chain monitoring.

**Fix:** Add `check_program_owner` to all instructions that read/write pool state.

---

### HIGH-4: Admin Can Rug Via Instant Parameter Changes

**File:** `update_pool.rs`
**Severity:** HIGH

The admin can instantly change ALL risk parameters with no timelock:

- Set `liquidation_threshold` near 0 → all positions become liquidatable
- Set `liquidation_bonus` to 90% → liquidator seizes nearly all collateral
- Set `close_factor` to 100% → liquidate entire positions in one tx
- Set `flash_fee_bps` to 0 → free flash loans

Combined, admin can trigger mass liquidations and extract protocol value in a single block.

Missing validation in UpdatePool:

- No upper bound on `slope1`, `slope2`, `base_rate` → overflow in `borrow_rate` → all operations revert (DoS)
- No check that `optimal_utilization < WAD` → if set to WAD, `WAD - optimal_util = 0` → division by zero when utilization > 100%
- No upper bound on `liquidation_bonus` → if > WAD, seized collateral exceeds deposit → arithmetic errors

**Fix:** Add timelock for parameter changes. Add bounds: `slope* < 10 * WAD`, `liquidation_bonus < WAD / 2`, `optimal_utilization < WAD`.

---

### HIGH-5: `SetPoolDecimals` Can Trigger Mass Liquidations

**File:** `set_pool_decimals.rs`
**Severity:** HIGH
**Status:** Matches existing audit M5 (upgraded)

Admin can change `token_decimals` at any time, even with active positions. Since `token_to_usd_wad` uses `token_decimals` to compute USD value, changing decimals from 6 to 9 would make all USDC collateral worth 1000× less, triggering mass liquidations.

**Fix:** Only allow setting decimals when `total_deposits == 0 && total_borrows == 0`.

---

## MEDIUM — Should Fix Before Mainnet

### MED-1: 120-Second Oracle Staleness Window

**File:** `update_oracle_price.rs:28`
**Severity:** MEDIUM
**Status:** Matches existing audit M1

`MAX_ORACLE_AGE = 120` is dangerously wide for Solana. Crypto markets move 5-10% in 2 minutes during volatile events. Combined with permissionless oracle updates, creates a large attack surface for oracle manipulation.

**Fix:** Reduce to 10 seconds.

---

### MED-2: Oracle Exponent Not Bounds-Checked

**File:** `update_oracle_price.rs`, `math.rs:288-316`
**Severity:** MEDIUM
**Status:** Matches existing audit M6

`oracle_expo` is stored as `i32`. If Pyth returns extreme values (e.g., expo = -50), `10u128.checked_pow(50)` overflows → all cross-collateral operations for that pool revert permanently.

**Fix:** Validate `-18 <= oracle_expo <= 18` in `update_oracle_price`.

---

### MED-3: Precision Loss in Small Interest Accruals

**File:** `math.rs:195-198`
**Severity:** MEDIUM
**Status:** Matches existing audit M2

```rust
let borrow_delta = borrow_rate_wad
    .checked_mul(dt).unwrap()
    / SECONDS_PER_YEAR;  // Integer division truncates
```

For 1-second accruals at 1% rate: `1e16 * 1 / 31_536_000 = 316,887` vs true value 317,097 (0.07% loss). Over many small accruals, interest is systematically undercounted, benefiting borrowers at depositor expense.

**Fix:** Use `wad_mul(rate, elapsed) / SECONDS_PER_YEAR` or accumulate remainders.
User comments: you fix the math

---

### MED-4: `token_to_usd_wad` Truncation on Negative Scale

**File:** `math.rs:311-316`
**Severity:** MEDIUM
**Status:** Matches existing audit M4

When `scale_exp < 0`, `base / divisor` truncates. For tokens where `18 + oracle_expo - token_decimals < 0`, small amounts systematically lose value. This undervalues collateral, preventing users from borrowing their full entitlement.

---

### MED-5: Flash Loan State Not Cleared on Transaction Failure

**File:** `flash_borrow.rs:97-100`
**Severity:** MEDIUM

If a transaction containing FlashBorrow fails AFTER the pool state is written but BEFORE FlashRepay, Solana reverts all state changes — so this is safe. However, if the FlashBorrow CPI transfer succeeds but the program panics later (e.g., in a subsequent instruction), the entire transaction reverts and `flash_loan_amount` is restored to 0. This is correct behavior.

But: there's no check that `flash_loan_amount == 0` at the END of a transaction. If someone calls FlashBorrow but never calls FlashRepay in the same transaction, the runtime reverts everything. However, if the program is called via CPI and the outer program handles errors, the flash_loan_amount could persist in a bad state.

**Fix:** This is actually safe due to Solana's atomic transactions. No fix needed, but document the invariant.

---

### MED-6: UpdatePool Doesn't Accrue Interest Before Changing Rates

**File:** `update_pool.rs:75-118`
**Severity:** MEDIUM

`UpdatePool` directly modifies rate parameters without first calling `accrue_interest`. This means the new rates apply retroactively to the period since the last accrual. If the admin changes `base_rate` from 1% to 50%, all interest since last accrual is computed at 50%.

**Fix:** Add `pool.accrue_interest(Clock::get()?.unix_timestamp)?` before applying new parameters.

---

### MED-7: Oracle Confidence Interval Too Wide (2%)

**File:** `pyth/mod.rs:77`
**Severity:** MEDIUM
**Status:** Matches existing audit H4

`(conf as u128) * 50 > (price as u128)` allows 2% CI. On $10M collateral, that's $200K of uncertainty. Aave uses 0.5-1%.

**Fix:** Tighten to 1%: `conf * 100 > price`.

---

## LOW — Defense-in-Depth

### LOW-1: Dust Position Griefing

**File:** `deposit.rs`

Anyone can create 1-wei positions across many pools, creating abandoned PDA accounts that can never be closed. Each costs rent but creates on-chain bloat.

### LOW-2: Flash Fee Rounding Benefits LPs

**File:** `math.rs:405-408`

`split_flash_fee` always rounds down the protocol portion, giving up to 9 wei per flash loan to LPs instead of the protocol.

### LOW-3: No Rate Limiting on accrue_interest

**File:** All state-mutating instructions

Any instruction that calls `accrue_interest` can be called permissionlessly (Deposit with amount=1). Combined with MED-3, an attacker could force many small accruals to maximize precision loss.

### LOW-4: Cross-Collateral Flag Not Set on Borrow Pool Position

**File:** `cross_borrow.rs:272-277`

CrossBorrow sets `cross_collateral = 1` on trailing collateral positions but NOT on the borrow pool's own position (even if it has deposits used as collateral at line 226-235). This means the borrow pool position can be withdrawn via regular `Withdraw` without cross-HF check.

---

## ATTACK PLAYBOOKS

### Playbook 1: Total Protocol Insolvency via Repay Inflation

**Difficulty:** Easy | **Capital Required:** Minimal | **Profit:** Indirect (depositor losses)

```
for i in 1..1000:
    deposit(pool, 1000 USDC)           # vault += 1000
    borrow(pool, 750 USDC)             # vault -= 750
    repay(pool, 750 USDC)              # vault += 750, total_deposits += 750 (BUG)

# After 1000 iterations:
# vault = 1000 USDC (unchanged)
# total_deposits = 1000 + 1000*750 = 751,000 USDC
# available = 751,000 USDC (but vault has 1,000)
#
# All future borrows pass liquidity check but SPL transfer fails → DoS
# Utilization = 0/751000 = 0% → depositors earn zero interest
# Pool is permanently broken
```

### Playbook 2: Liquidate Any Healthy Cross-Collateral Position

**Difficulty:** Medium | **Capital Required:** Repay amount | **Profit:** Seized collateral - repay

```
1. Identify victim with cross-collateral across pools A, B, C
   (e.g., $50k SOL in A, $5k USDC in B, $40k debt in C)

2. Call CrossLiquidate with ONLY Pool B and Pool C
   Omit Pool A ($50k SOL deposit)

3. Computed global HF = ($5k × 0.8) / $40k = 0.1 (underwater!)
   Real global HF = ($50k + $5k) × 0.8 / $40k = 1.1 (healthy)

4. Liquidation proceeds:
   - Repay 50% × $40k = $20k of debt
   - Seize $20k × 1.05 = $21k of collateral from Pool B
   - Victim loses $21k of collateral from a HEALTHY position
```

### Playbook 3: Cross-Pool Index Mismatch Liquidation

**Difficulty:** Easy | **Capital Required:** Repay amount | **Profit:** Seized collateral

```
1. Find two pools for same token (e.g., USDC Pool 1 and USDC Pool 2)
   Pool 1: supply_index = WAD (new)
   Pool 2: supply_index = 1.5 × WAD (mature, 50% interest accrued)

2. Victim has position in Pool 2: 1000 shares (= 1500 tokens), 1300 debt
   Real HF = (1500 × 0.8) / 1300 = 0.923... wait that's already unhealthy

3. Better example:
   Victim in Pool 2: 1000 shares (= 1500 tokens), 1100 debt
   Real HF = (1500 × 0.8) / 1100 = 1.09 (healthy)

4. Call Liquidate with Pool 1 + Victim's position:
   Computed deposit = 1000 × WAD / WAD = 1000 (wrong! should be 1500)
   Computed HF = (1000 × 0.8) / 1100 = 0.727 (underwater!)

5. Liquidate and seize collateral from healthy position
```

### Playbook 4: Phantom Borrowing via Debt Omission

**Difficulty:** Easy | **Capital Required:** Initial deposit | **Profit:** Borrowed tokens

```
1. Deposit $10,000 USDC into Pool A
2. CrossBorrow $7,000 SOL from Pool B, using Pool A as collateral
3. CrossBorrow $7,000 WBTC from Pool C, using Pool A as collateral
   (include only Pool A in trailing accounts, omit Pool B position)
4. System sees: $10k collateral, $0 existing debt → $7.5k borrow capacity
5. Borrow succeeds! Total debt now: $14,000 against $10,000 collateral
6. Walk away with $4,000 of protocol funds
```

### Playbook 5: Oracle Front-Running + Stale Price Exploitation

**Difficulty:** Medium | **Capital Required:** Capital for borrowing | **Profit:** Undercollateralized borrow delta

```
1. Monitor Pyth for favorable price movements
2. When SOL price spikes to $200 (real price $150), call UpdateOraclePrice
   within the 120-second window to cache $200
3. Immediately CrossBorrow against SOL collateral valued at $200
4. Wait for oracle to update to real price ($150)
5. Position is 25% undercollateralized
6. If price keeps dropping, position becomes insolvent before liquidators react
```

---

## COMPARISON WITH EXISTING INTERNAL AUDIT

| Existing Finding               | My Assessment            | Notes                                                 |
| ------------------------------ | ------------------------ | ----------------------------------------------------- |
| C1 (Mock HF)                   | Confirmed CRITICAL       | Agree                                                 |
| C2 (Permissionless oracle)     | Confirmed HIGH           | Agree                                                 |
| C3 (Vault verification)        | Confirmed CRITICAL       | Agree, vault addr stored but never checked            |
| C4 (Token program)             | Confirmed CRITICAL       | Agree                                                 |
| H1 (Oracle first-anchor)       | Confirmed HIGH           | Agree                                                 |
| H2 (Admin check_program_owner) | Expanded to HIGH-3       | 7 instructions affected, not just 4                   |
| H3 (Cross-collateral flag)     | Confirmed HIGH           | Agree                                                 |
| H4 (Oracle CI 2%)              | Confirmed MEDIUM         | Reasonable assessment                                 |
| H5 (FlashBorrow owner check)   | Absorbed into HIGH-3     | Part of broader pattern                               |
| M1 (Oracle staleness)          | Confirmed MEDIUM         | Agree                                                 |
| M2 (Precision loss)            | Confirmed MEDIUM         | Agree                                                 |
| M3 (Liquidate binding)         | **UPGRADED to CRITICAL** | Cross-pool index mismatch enables stealing collateral |
| M4 (token_to_usd truncation)   | Confirmed MEDIUM         | Agree                                                 |
| M5 (SetPoolDecimals)           | **UPGRADED to HIGH**     | Admin can trigger mass liquidations                   |
| M6 (Oracle expo bounds)        | Confirmed MEDIUM         | Agree                                                 |

**New findings NOT in existing audit:**

- **CRIT-1:** Repay inflates total_deposits (slow insolvency)
- **CRIT-2:** Selective position omission in cross-collateral (steal collateral)
- **HIGH-4:** Admin rug via instant parameters + missing validation bounds
- **MED-5:** Flash loan state consistency (confirmed safe, documented)
- **MED-6:** UpdatePool doesn't accrue interest first
- **LOW-4:** Cross-collateral flag not set on borrow pool position

---

## PRIORITY FIX ORDER

```
IMMEDIATE (blocks mainnet):
  1. CRIT-1  Repay total_deposits inflation     → Remove the saturating_add lines
  2. CRIT-2  Selective position omission         → On-chain position registry
  3. CRIT-5  Liquidate missing binding           → Add verify_binding check
  4. CRIT-3  Vault verification                  → Compare against pool.vault
  5. CRIT-4  Token program verification          → Hardcode SPL_TOKEN check
  6. CRIT-6  Mock HF bypass                      → Feature-gate it

BEFORE BETA (high priority):
  7. HIGH-1  Oracle front-running                → Require signer on first anchor
  8. HIGH-2  Cross-collateral flag orphaning      → Clear flag in regular repay
  9. HIGH-3  check_program_owner everywhere       → Add to all 7 instructions
 10. HIGH-4  Admin parameter bounds               → Add validation + timelock
 11. HIGH-5  SetPoolDecimals guard                → Block when positions exist

BEFORE MAINNET (medium priority):
 12. MED-1   Oracle staleness window              → Reduce to 30s
 13. MED-2   Oracle expo bounds                   → Validate range
 14. MED-3   Precision loss                       → Use wad_mul ordering
 15. MED-6   UpdatePool accrue interest            → Call before modifying
 16. MED-7   Oracle CI width                      → Tighten to 1%
```

---

## ARCHITECTURAL RECOMMENDATIONS

### 1. Cross-Collateral Position Registry

The current design trusts clients to provide all relevant positions. This is the single biggest architectural flaw. Options:

- **On-chain linked list:** Each UserPosition stores a `next_position` pointer. CrossBorrow/Withdraw must traverse the full list.
- **Bitmap counter:** LendingPool stores a count of cross-collateral positions per user. Instructions verify that the number of provided positions matches.
- **Position index account:** Per-user PDA that stores an array of all pool addresses where the user has positions.

### 2. Vault Derivation

Instead of storing the vault address and hoping someone checks it, derive the vault deterministically:

```rust
vault_pda = ["vault", pool_address, bump]
```

Then verify in every instruction by re-deriving.

### 3. Admin Timelock

All parameter changes should go through a two-step process:

1. `ProposeUpdate` — stores new params with a 24-hour delay
2. `ExecuteUpdate` — applies params after the delay expires

### 4. Emergency Pause

The current `PausePool` only blocks deposits and borrows. It should also block:

- Withdrawals (to prevent bank run during incident)
- Cross-operations (to prevent exploits during pause)
- Oracle updates (to freeze prices during investigation)

---

_This audit covers the on-chain program only. Frontend, API, and off-chain components were not re-audited. All findings should be verified with on-chain integration tests before implementing fixes._
