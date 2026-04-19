/*!
FHE computation graph definitions for the Veil lending protocol.

Each function here defines one node (or subgraph) in the Encrypt DAG.
The plaintext Rust function is the source of truth for the logic; the
`#[encrypt_fn]` SDK equivalent is shown in each doc comment.

When the Encrypt SDK dependency is enabled, replace each function body
with the `#[encrypt_fn]`-decorated version from the doc comment.  The
generated CPI wrapper (`<FnName>Cpi` trait) is then called via the
`EncryptContext` on the instruction handler.

# Health factor arithmetic inside FHE

WAD-scale (1e18) arithmetic is impractical inside EUint64 (would require
EUint128 for intermediate products).  We use basis-point (BPS) arithmetic:

  HF ≥ 1.0  ⟺  deposit × LIQ_THRESHOLD_BPS ≥ debt × BPS_DENOM
            ⟺  deposit × 8_000 ≥ debt × 10_000
            ⟺  4 × deposit ≥ 5 × debt        (simplified)

Maximum safe deposit at LIQ_THRESHOLD_BPS = 8_000:
  u64::MAX / 10_000 ≈ 1.84 × 10¹⁵ tokens
For USDC (6 decimals): ~1.84 × 10⁹ USDC — sufficient for current scale.
*/

use pinocchio::error::ProgramError;

// ── Balance update graphs ──────────────────────────────────────────────��──────

/// Adds `amount` to an encrypted deposit balance.
///
/// ### SDK equivalent (`#[encrypt_fn]`)
/// ```rust,ignore
/// use encrypt_dsl::prelude::*;
///
/// #[encrypt_fn]
/// fn add_deposit(deposit: EUint64, amount: EUint64) -> EUint64 {
///     deposit + amount
/// }
/// ```
/// ### CPI call (once SDK is active)
/// ```rust,ignore
/// ctx.add_deposit(deposit_ct, amount_ct, out_deposit_ct)?;
/// ```
pub fn add_deposit_plaintext(deposit: u64, amount: u64) -> Result<u64, ProgramError> {
    deposit
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Subtracts `amount` from an encrypted deposit balance.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn sub_deposit(deposit: EUint64, amount: EUint64) -> EUint64 {
///     deposit - amount   // saturates at 0 in FHE
/// }
/// ```
pub fn sub_deposit_plaintext(deposit: u64, amount: u64) -> u64 {
    deposit.saturating_sub(amount)
}

/// Adds `amount` to an encrypted debt balance.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn add_debt(debt: EUint64, amount: EUint64) -> EUint64 {
///     debt + amount
/// }
/// ```
pub fn add_debt_plaintext(debt: u64, amount: u64) -> Result<u64, ProgramError> {
    debt.checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Subtracts `amount` from an encrypted debt balance (full repay clamps to 0).
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn sub_debt(debt: EUint64, amount: EUint64) -> EUint64 {
///     debt - amount   // saturates at 0
/// }
/// ```
pub fn sub_debt_plaintext(debt: u64, amount: u64) -> u64 {
    debt.saturating_sub(amount)
}

// ── Health factor graphs ──────────────────────────────────────────────────────

/// Returns `true` (healthy) when `deposit × 8_000 ≥ debt × 10_000`.
///
/// This is the encrypted equivalent of HF ≥ 1.0 using BPS arithmetic to
/// avoid u128 intermediate values inside EUint64.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn is_healthy(deposit: EUint64, debt: EUint64) -> EBool {
///     // deposit * 80% >= debt  ⟺  4*deposit >= 5*debt
///     let scaled_deposit = deposit * 8_000u64;
///     let scaled_debt    = debt    * 10_000u64;
///     scaled_deposit >= scaled_debt
/// }
/// ```
/// ### CPI call
/// ```rust,ignore
/// ctx.is_healthy(deposit_ct, debt_ct, healthy_out_ct)?;
/// ```
pub fn is_healthy_plaintext(deposit: u64, debt: u64) -> bool {
    if debt == 0 {
        return true;
    }
    // deposit * 8_000 >= debt * 10_000
    let lhs = (deposit as u128) * 8_000;
    let rhs = (debt as u128) * 10_000;
    lhs >= rhs
}

/// Returns `true` (should liquidate) when position is undercollateralised.
///
/// Inverse of `is_healthy`.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn should_liquidate(deposit: EUint64, debt: EUint64) -> EBool {
///     let scaled_deposit = deposit * 8_000u64;
///     let scaled_debt    = debt    * 10_000u64;
///     scaled_deposit < scaled_debt
/// }
/// ```
pub fn should_liquidate_plaintext(deposit: u64, debt: u64) -> bool {
    !is_healthy_plaintext(deposit, debt)
}

/// Returns the borrow capacity: `max_borrow = deposit × LTV_BPS / BPS_DENOM`.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn max_borrow(deposit: EUint64) -> EUint64 {
///     // 75 % LTV
///     deposit * 7_500u64 / 10_000u64
/// }
/// ```
pub fn max_borrow_plaintext(deposit: u64) -> u64 {
    ((deposit as u128) * 7_500 / 10_000).min(u64::MAX as u128) as u64
}

/// Returns `true` if `amount` does not exceed the borrowable capacity.
///
/// ### SDK equivalent
/// ```rust,ignore
/// #[encrypt_fn]
/// fn borrow_allowed(deposit: EUint64, existing_debt: EUint64, amount: EUint64) -> EBool {
///     let max = deposit * 7_500u64 / 10_000u64;
///     existing_debt + amount <= max
/// }
/// ```
pub fn borrow_allowed_plaintext(deposit: u64, existing_debt: u64, amount: u64) -> bool {
    let max = max_borrow_plaintext(deposit);
    existing_debt.saturating_add(amount) <= max
}

// ────────────────────────────────────────────────────────────────────────────���
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── add / sub deposit ────────────────────────────────────────────────────

    #[test]
    fn add_deposit_basic() {
        assert_eq!(add_deposit_plaintext(1_000, 500).unwrap(), 1_500);
    }

    #[test]
    fn add_deposit_overflow_returns_err() {
        assert!(add_deposit_plaintext(u64::MAX, 1).is_err());
    }

    #[test]
    fn sub_deposit_basic() {
        assert_eq!(sub_deposit_plaintext(1_000, 300), 700);
    }

    #[test]
    fn sub_deposit_saturates_at_zero() {
        assert_eq!(sub_deposit_plaintext(100, 200), 0);
    }

    // ── add / sub debt ───────────────────────────────────────────────────────

    #[test]
    fn add_debt_basic() {
        assert_eq!(add_debt_plaintext(500, 200).unwrap(), 700);
    }

    #[test]
    fn sub_debt_full_repay_saturates() {
        assert_eq!(sub_debt_plaintext(500, 600), 0);
    }

    // ── is_healthy ───────────────────────────────────────────────────────────

    #[test]
    fn healthy_when_no_debt() {
        assert!(is_healthy_plaintext(0, 0));
        assert!(is_healthy_plaintext(1_000, 0));
    }

    #[test]
    fn healthy_at_exactly_threshold() {
        // deposit=1000, debt=800 → 1000*8000 = 8_000_000, 800*10000 = 8_000_000
        // 8_000_000 >= 8_000_000 → true (exactly at boundary)
        assert!(is_healthy_plaintext(1_000, 800));
    }

    #[test]
    fn unhealthy_just_over_threshold() {
        // deposit=1000, debt=801 → 8_000_000 < 8_010_000 → false
        assert!(!is_healthy_plaintext(1_000, 801));
    }

    #[test]
    fn healthy_well_collateralised() {
        // deposit=2_000_000, debt=500_000 → HF=3.2
        assert!(is_healthy_plaintext(2_000_000, 500_000));
    }

    #[test]
    fn should_liquidate_is_inverse_of_is_healthy() {
        let cases = [(1_000, 0), (1_000, 800), (1_000, 801), (500, 1_000)];
        for (d, b) in cases {
            assert_eq!(
                should_liquidate_plaintext(d, b),
                !is_healthy_plaintext(d, b),
                "mismatch at deposit={d} debt={b}"
            );
        }
    }

    // ── borrow_allowed ───────────────────────────────────────────────────────

    #[test]
    fn max_borrow_is_75_percent() {
        // 75 % of 10_000 = 7_500
        assert_eq!(max_borrow_plaintext(10_000), 7_500);
    }

    #[test]
    fn borrow_allowed_within_ltv() {
        // deposit=10_000, existing=0, want=7_500 → exactly at LTV
        assert!(borrow_allowed_plaintext(10_000, 0, 7_500));
    }

    #[test]
    fn borrow_rejected_over_ltv() {
        // deposit=10_000, existing=0, want=7_501 → over LTV
        assert!(!borrow_allowed_plaintext(10_000, 0, 7_501));
    }

    #[test]
    fn borrow_rejected_when_existing_debt_near_max() {
        // deposit=10_000, existing=7_000, want=501 → 7_501 > 7_500
        assert!(!borrow_allowed_plaintext(10_000, 7_000, 501));
    }
}
