# Veil Core Lending Protocol — Capabilities

This document covers every action available in Veil's on-chain lending protocol, with concrete examples showing how each instruction works and how they compose together.

---

## On-Chain Instructions

Veil's Solana program exposes 25 instructions, each identified by a single-byte discriminator. The table below groups them by category.

### Core Lending

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 1 | Initialize | `0x00` | Create a new lending pool for any SPL token |
| 2 | Deposit | `0x01` | Supply tokens to a pool, receive interest-bearing shares |
| 3 | Withdraw | `0x02` | Redeem shares for underlying tokens |
| 4 | Borrow | `0x03` | Borrow tokens against your deposit in the same pool |
| 5 | Repay | `0x04` | Repay borrowed tokens to reduce your debt |
| 6 | Liquidate | `0x05` | Liquidate an unhealthy position (HF < 1.0) |

### Flash Loans

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 7 | FlashBorrow | `0x06` | Borrow any amount without collateral (must repay same tx) |
| 8 | FlashRepay | `0x07` | Repay flash loan + 0.09% fee (atomic enforcement) |

### Cross-Collateral Lending

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 9 | CrossBorrow | `0x16` | Borrow from one pool using deposits in other pools as collateral |
| 10 | CrossWithdraw | `0x17` | Withdraw from a pool while maintaining cross-collateral health |
| 11 | CrossRepay | `0x18` | Repay a cross-collateral borrow |
| 12 | CrossLiquidate | `0x19` | Liquidate an unhealthy cross-collateral position |
| 13 | InitPosition | `0x1A` | Create an empty position PDA (needed before cross-borrow into a new pool) |

### Privacy Layer (FHE)

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 14 | EnablePrivacy | `0x08` | Toggle privacy on a position — balances stored as FHE ciphertext |
| 15 | PrivateDeposit | `0x09` | Deposit with encrypted balance update |
| 16 | PrivateBorrow | `0x0A` | Borrow with encrypted debt tracking |
| 17 | PrivateRepay | `0x0B` | Repay with encrypted balance update |
| 18 | PrivateWithdraw | `0x0C` | Withdraw with encrypted share redemption |

### Cross-Chain (Ika dWallet)

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 19 | IkaRegister | `0x11` | Register a dWallet position (native BTC/ETH collateral) |
| 20 | IkaRelease | `0x12` | Release a dWallet position back to the user |
| 21 | IkaSign | `0x13` | Trigger MPC signing for cross-chain settlement |

### Pool Administration

| # | Instruction | Discriminator | Description |
|---|-------------|---------------|-------------|
| 22 | UpdatePool | `0x0D` | Update risk parameters (LTV, rates, fees) — authority only |
| 23 | PausePool | `0x0E` | Pause a pool (blocks deposits/borrows) — authority only |
| 24 | ResumePool | `0x0F` | Resume a paused pool — authority only |
| 25 | CollectFees | `0x10` | Sweep accumulated protocol fees — authority only |
| 26 | UpdateOraclePrice | `0x14` | Refresh Pyth oracle price cache for a pool |
| 27 | SetPoolDecimals | `0x15` | Read token decimals from mint and store on pool |

---

## Interest Rate Model

Veil uses a **kink-based (two-slope) interest rate model**:

```
If utilization <= optimal (80%):
    borrowRate = baseRate + (U / U_opt) x slope1

If utilization > optimal (80%):
    borrowRate = baseRate + slope1 + ((U - U_opt) / (1 - U_opt)) x slope2

supplyRate = borrowRate x U x (1 - reserveFactor)
```

Default parameters:

| Parameter | Value |
|-----------|-------|
| Base Rate | 1% |
| Optimal Utilization | 80% |
| Slope 1 | 4% |
| Slope 2 | 75% |
| Reserve Factor | 10% |
| LTV | 75% |
| Liquidation Threshold | 80% |
| Liquidation Bonus | 5% |
| Close Factor | 50% |
| Flash Fee | 9 bps (0.09%) |

All rates and ratios are WAD-scaled (1e18 = 100%) using overflow-safe u128 arithmetic.

---

## Testing Scenarios

These scenarios demonstrate every core capability of the protocol. Each can be executed from the dApp frontend against a localnet or devnet deployment.

### 1. Deposit

**Scenario:** Supply 100 USDC to the USDC lending pool.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Action | Deposit |
| Amount | 100 USDC |
| Expected | Transaction confirms. Pool balance increases by 100 USDC. User receives ~100 deposit shares (exact count depends on current supply index). |

**What happens on-chain:**
- Tokens transfer from user's ATA to pool vault
- Shares minted: `amount x WAD / supplyIndex`
- Position PDA created (or updated) with new share balance

---

### 2. Withdraw

**Scenario:** Redeem 10 shares from the USDC pool.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Action | Withdraw |
| Amount | 10 shares |
| Expected | Transaction confirms. User receives ~10 USDC (more if interest has accrued). Health factor must remain >= 1.0 if the user has outstanding debt. |

**What happens on-chain:**
- Tokens = `shares x supplyIndex / WAD`
- Health factor checked post-withdrawal
- Tokens transfer from vault to user's ATA

---

### 3. Single-Pool Borrow

**Scenario:** Borrow 50 USDC against 100 USDC deposit in the same pool.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Action | Borrow |
| Amount | 50 USDC |
| Collateral | 100 USDC deposit in same pool |
| LTV | 80% -> max borrowable = 80 USDC |
| Expected | Success. Debt of 50 USDC recorded. HF = (100 x 0.85) / 50 = 1.70 |

**Boundary test:**
- Borrowing 80 USDC: succeeds (exactly at LTV cap)
- Borrowing 81 USDC: fails with `ExceedsCollateralFactor`

---

### 4. Repay

**Scenario:** Repay 25 USDC of an existing 50 USDC debt.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Action | Repay |
| Amount | 25 USDC |
| Expected | Debt decreases to ~25 USDC. Health factor improves. Tokens transfer from user to vault. |

**Edge case:** Repaying more than total debt caps at the actual debt amount. No excess tokens are taken.

---

### 5. Cross-Collateral Borrow

**Scenario:** Deposit USDC, then borrow SOL from a different pool using USDC as collateral.

| Field | Value |
|-------|-------|
| Collateral Pool | USDC (50,000 USDC deposited, LTV 80%) |
| Borrow Pool | SOL (price $140, 9 decimals) |
| Borrow Amount | 1 SOL (~$140) |
| Collateral Value | $50,000 x 80% LTV = $40,000 max borrowable |
| Expected | Success. Cross-collateral position established. HF = ($50,000 x 85%) / ($140 + existing debt) |

This is the core innovation of cross-collateral lending — your deposits in one pool back borrows in another, with oracle-based USD conversion.

**How it works internally:**
1. Oracle prices convert each collateral deposit to USD (WAD-scaled)
2. Each deposit is weighted by its pool's LTV and liquidation threshold
3. Total USD collateral is compared against total USD debt across all pools
4. Health factor = sum(deposit_usd x liq_threshold) / sum(debt_usd)

**Boundary tests:**
- Borrow 0.1 SOL (~$14): succeeds easily
- Borrow 250 SOL (~$35,000): fails — exceeds LTV-weighted collateral cap
- Borrow from pool where user has no position: auto-creates position via InitPosition

---

### 6. Cross-Collateral Borrow (Over LTV)

**Scenario:** Attempt to borrow more than allowed by cross-collateral LTV.

| Field | Value |
|-------|-------|
| Collateral | $50,000 USDC (LTV-weighted: $40,000) |
| Existing Debt | $12,000 USDC borrow |
| Borrow Attempt | 250 SOL (~$35,000) |
| Total Debt After | $12,000 + $35,000 = $47,000 |
| Max Allowed | $40,000 |
| Expected | Fails with `ExceedsCollateralFactor` |

---

### 7. Flash Loan

**Scenario:** Borrow and repay 1,000 USDC within a single transaction.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Action | FlashBorrow + FlashRepay |
| Amount | 1,000 USDC |
| Fee | 0.09% = 0.9 USDC |
| Expected | Atomic success. User pays 0.9 USDC fee. 0.81 USDC goes to LPs, 0.09 USDC to protocol. |

**Key properties:**
- No collateral required
- Both instructions must be in the same transaction
- If repay instruction is missing, the entire transaction reverts
- Cannot start a second flash loan while one is active
- Amount limited to pool's available liquidity (deposits - borrows - fees)

---

### 8. Liquidation (Single-Pool)

**Scenario:** A borrower's health factor drops below 1.0 due to price movement.

| Field | Value |
|-------|-------|
| Borrower Deposit | 1,250 USDC |
| Borrower Debt | 1,100 USDC (after interest accrual) |
| HF | (1250 x 0.85) / 1100 = 0.965 < 1.0 |
| Close Factor | 50% -> liquidator repays up to 550 USDC |
| Liquidation Bonus | 5% -> liquidator seizes 550 x 1.05 = 577.5 USDC worth |
| Expected | Liquidator repays debt, receives collateral + bonus |

**Constraints:**
- Only callable when HF < 1.0
- Repay amount capped at `closeFactor x totalDebt` (50%)
- Seized amount = repayAmount x (1 + liquidationBonus)
- 10% of bonus goes to protocol as fee

---

### 9. Cross-Collateral Liquidation

**Scenario:** A cross-collateral borrower becomes undercollateralized.

| Field | Value |
|-------|-------|
| Borrower | Has USDC deposit, SOL borrow |
| Debt Pool | SOL |
| Collateral Pool | USDC |
| Action | CrossLiquidate |
| Expected | Liquidator repays SOL debt, seizes USDC collateral (converted via oracle prices) |

The liquidator specifies which debt pool and which collateral pool to settle against. Oracle prices handle the cross-asset conversion.

---

### 10. Cross-Collateral Withdraw

**Scenario:** Withdraw from a collateral pool while maintaining cross-collateral health.

| Field | Value |
|-------|-------|
| Pool | USDC |
| Withdraw | 1,000 shares |
| Related Pools | SOL (has outstanding cross-borrow) |
| Expected | Success if HF remains >= 1.0 after withdrawal. Fails otherwise. |

The instruction checks health factor across all related pools before allowing the withdrawal.

---

### 11. Cross-Collateral Repay

**Scenario:** Repay a cross-collateral borrow.

| Field | Value |
|-------|-------|
| Pool | SOL (where the borrow was taken) |
| Amount | 0.5 SOL |
| Expected | SOL debt decreases. Cross-collateral health factor improves. |

---

### 12. Privacy Toggle

**Scenario:** Enable FHE privacy on a position.

| Field | Value |
|-------|-------|
| Action | EnablePrivacy |
| Expected | An EncryptedPosition PDA is created. Future deposit/borrow/repay/withdraw operations use private instructions. Balances are stored as FHE ciphertext. Observers cannot see position details. |

After enabling privacy, the user uses PrivateDeposit/PrivateBorrow/PrivateRepay/PrivateWithdraw instead of the plaintext versions. Health factor checks execute over encrypted data.

---

### 13. Pool Administration

**Scenario:** Protocol authority updates risk parameters.

| Field | Value |
|-------|-------|
| Action | UpdatePool |
| Parameters | LTV, liquidation threshold, interest rates, flash fee |
| Expected | New parameters take effect immediately for all future operations |

Other admin actions:
- **PausePool**: Blocks all borrows and deposits. Withdrawals and repayments still allowed.
- **ResumePool**: Re-enables a paused pool.
- **CollectFees**: Sweeps accumulated protocol fees to the authority's token account.

---

## Math & Precision

All monetary values use **WAD-scaled u128 arithmetic** (1 WAD = 1e18 = 100%):

- Token amounts stay in native units (u64) until computation
- Rates, ratios, and USD values are WAD-scaled u128
- Overflow-safe: `wad_mul` and `wad_div` use split-scale fallbacks when intermediate products exceed u128
- Oracle prices use Pyth format (price x 10^expo) and are converted to WAD-USD via `token_to_usd_wad`

The cross-health factor formula:

```
HF = sum(deposit_usd_i x liq_threshold_i) / sum(debt_usd_j)
```

Where each `deposit_usd` is computed as:

```
deposit_usd = token_amount x |oracle_price| x 10^(18 + oracle_expo - token_decimals)
```

---

## Architecture Summary

```
User Wallet
    |
    v
[Solana Transaction]
    |
    +-- Deposit/Withdraw/Borrow/Repay      (single-pool)
    +-- CrossBorrow/CrossWithdraw/...       (multi-pool, oracle-priced)
    +-- FlashBorrow + FlashRepay            (atomic, uncollateralized)
    +-- PrivateDeposit/PrivateBorrow/...    (FHE-encrypted positions)
    +-- IkaRegister/IkaSign/IkaRelease      (cross-chain via dWallet)
    |
    v
[On-Chain State]
    +-- LendingPool (416 bytes)  — indices, totals, risk params, oracle cache
    +-- UserPosition (136 bytes) — shares, debt, index snapshots
    +-- EncryptedPosition        — FHE ciphertext balances
    +-- IkaPosition              — dWallet binding + chain state
```

Each pool is isolated by token mint. Cross-collateral operations bridge pools via oracle-based USD conversion. Privacy and cross-chain features are opt-in per position.
