/*!
WAD-precision (1e18) fixed-point arithmetic for the kink interest-rate model.

All rates and indices live in WAD space:
  1.0  = 1_000_000_000_000_000_000
  0.05 = 50_000_000_000_000_000

Token amounts stay in their native u64 units; they are cast to u128 only
inside calculations and the result is cast back.
*/

use pinocchio::error::ProgramError;

// ── Constants ────────────────────────────────────────────────────────────────

pub const WAD: u128 = 1_000_000_000_000_000_000; // 1e18

/// 365 × 24 × 3600
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

// ── Default interest-rate / risk parameters ───────────────────────────────

pub const BASE_RATE: u128 = WAD / 100; // 1 %
pub const OPTIMAL_UTIL: u128 = WAD * 80 / 100; // 80 %
pub const SLOPE1: u128 = WAD * 4 / 100; // 4 %
pub const SLOPE2: u128 = WAD * 75 / 100; // 75 %
pub const RESERVE_FACTOR: u128 = WAD / 10; // 10 %
pub const LTV: u128 = WAD * 75 / 100; // 75 %
pub const LIQ_THRESHOLD: u128 = WAD * 80 / 100; // 80 %
pub const LIQ_BONUS: u128 = WAD * 5 / 100; // 5 %
pub const PROTOCOL_LIQ_FEE: u128 = WAD / 10; // 10 % of bonus
pub const CLOSE_FACTOR: u128 = WAD / 2; // 50 %

/// Flash loan fee: 9 basis points = 0.09 %.
pub const FLASH_FEE_BPS: u64 = 9;
/// Share of flash fee that goes to the protocol (10 %).
pub const FLASH_PROTOCOL_SHARE_BPS: u64 = 10; // 10% of the fee
/// Share of flash fee that goes to LPs (90 %).
pub const FLASH_LP_SHARE_BPS: u64 = 90; // 90% of the fee

// ── Core WAD helpers ─────────────────────────────────────────────────────────

/// Multiply two WAD-scaled values: (a × b) / WAD
#[inline(always)]
pub fn wad_mul(a: u128, b: u128) -> Result<u128, ProgramError> {
    match a.checked_mul(b) {
        Some(product) => Ok(product / WAD),
        None => {
            // Fallback: divide first to avoid overflow.
            // wad_mul(a, b) = a * b / WAD
            // = (a / WAD) * b + (a % WAD) * b / WAD
            let quotient = a / WAD;
            let remainder = a % WAD;
            let main = quotient.checked_mul(b)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            // remainder < WAD (1e18) and b < u128::MAX, so remainder * b may
            // still overflow; use the same split if needed.
            let rem_part = match remainder.checked_mul(b) {
                Some(v) => v / WAD,
                None => {
                    // b / WAD * remainder + b % WAD * remainder / WAD
                    let bq = b / WAD;
                    let br = b % WAD;
                    bq.checked_mul(remainder)
                        .ok_or(ProgramError::ArithmeticOverflow)?
                        .checked_add(br * remainder / WAD)
                        .ok_or(ProgramError::ArithmeticOverflow)?
                }
            };
            main.checked_add(rem_part)
                .ok_or(ProgramError::ArithmeticOverflow)
        }
    }
}

/// Divide two WAD-scaled values: (a × WAD) / b
#[inline(always)]
pub fn wad_div(a: u128, b: u128) -> Result<u128, ProgramError> {
    if b == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    match a.checked_mul(WAD) {
        Some(numerator) => Ok(numerator / b),
        None => {
            // Fallback: divide first to avoid overflow.
            // wad_div(a, b) = a * WAD / b
            // = (a / b) * WAD + (a % b) * WAD / b
            let quotient = a / b;
            let remainder = a % b;
            let main = quotient.checked_mul(WAD)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let rem_scaled = match remainder.checked_mul(WAD) {
                Some(v) => v / b,
                None => {
                    // Still overflows — split WAD into sqrt(WAD)² so
                    // intermediate products stay within u128.
                    // remainder × WAD / b
                    //   = (remainder × S / b) × S + (remainder × S % b) × S / b
                    // where S = 1e9 = sqrt(WAD).
                    const SQRT_WAD: u128 = 1_000_000_000;
                    let step = remainder.checked_mul(SQRT_WAD)
                        .ok_or(ProgramError::ArithmeticOverflow)?;
                    let q2 = step / b;
                    let r2 = step % b;
                    let part_a = q2.checked_mul(SQRT_WAD)
                        .ok_or(ProgramError::ArithmeticOverflow)?;
                    let part_b = r2.checked_mul(SQRT_WAD)
                        .ok_or(ProgramError::ArithmeticOverflow)?
                        / b;
                    part_a.checked_add(part_b)
                        .ok_or(ProgramError::ArithmeticOverflow)?
                }
            };
            main.checked_add(rem_scaled)
                .ok_or(ProgramError::ArithmeticOverflow)
        }
    }
}

// ── Kink interest-rate model ─────────────────────────────────────────────────

/// U = totalBorrows / totalDeposits  (WAD-scaled)
pub fn utilization_rate(total_borrows: u64, total_deposits: u64) -> Result<u128, ProgramError> {
    if total_deposits == 0 {
        return Ok(0);
    }
    wad_div(total_borrows as u128, total_deposits as u128)
}

/// Kink borrow rate (per second, WAD-scaled annual rate).
///
/// if U ≤ U_opt:  R = R₀ + (U / U_opt) × Slope₁
/// if U > U_opt:  R = R₀ + Slope₁ + ((U − U_opt) / (1 − U_opt)) × Slope₂
pub fn borrow_rate(
    utilization: u128,
    base_rate: u128,
    optimal_util: u128,
    slope1: u128,
    slope2: u128,
) -> Result<u128, ProgramError> {
    if utilization <= optimal_util {
        // base_rate + (U / U_opt) * Slope1
        let ratio = wad_div(utilization, optimal_util)?;
        let delta = wad_mul(ratio, slope1)?;
        Ok(base_rate
            .checked_add(delta)
            .ok_or(ProgramError::ArithmeticOverflow)?)
    } else {
        // base_rate + Slope1 + ((U - U_opt) / (1 - U_opt)) * Slope2
        let excess = utilization - optimal_util;
        let denominator = WAD - optimal_util;
        let ratio = wad_div(excess, denominator)?;
        let delta = wad_mul(ratio, slope2)?;
        Ok(base_rate
            .checked_add(slope1)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_add(delta)
            .ok_or(ProgramError::ArithmeticOverflow)?)
    }
}

/// supplyRate = borrowRate × U × (1 − reserveFactor)
pub fn supply_rate(
    borrow_rate_wad: u128,
    utilization: u128,
    reserve_factor: u128,
) -> Result<u128, ProgramError> {
    // borrowRate * U
    let borrow_x_util = wad_mul(borrow_rate_wad, utilization)?;
    // * (1 - reserveFactor)
    let one_minus_rf = WAD - reserve_factor;
    wad_mul(borrow_x_util, one_minus_rf)
}

// ── Interest index accrual ────────────────────────────────────────────────────

/// Advance the borrow and supply indices by `elapsed_secs` of simple interest.
///
/// newIndex = oldIndex × (1 + annualRate × Δt / SECONDS_PER_YEAR)
///
/// Returns `(new_borrow_index, new_supply_index)`.
pub fn accrue_indices(
    borrow_index: u128,
    supply_index: u128,
    borrow_rate_wad: u128,
    supply_rate_wad: u128,
    elapsed_secs: u64,
) -> Result<(u128, u128), ProgramError> {
    if elapsed_secs == 0 {
        return Ok((borrow_index, supply_index));
    }
    let dt = elapsed_secs as u128;

    // interest_per_second × elapsed  (still in WAD space)
    let borrow_delta = borrow_rate_wad
        .checked_mul(dt)
        .ok_or(ProgramError::ArithmeticOverflow)?
        / SECONDS_PER_YEAR;

    let supply_delta = supply_rate_wad
        .checked_mul(dt)
        .ok_or(ProgramError::ArithmeticOverflow)?
        / SECONDS_PER_YEAR;

    // factor = WAD + delta  (i.e. 1 + delta)
    let borrow_factor = WAD
        .checked_add(borrow_delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let supply_factor = WAD
        .checked_add(supply_delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    Ok((
        wad_mul(borrow_index, borrow_factor)?,
        wad_mul(supply_index, supply_factor)?,
    ))
}

// ── Borrow balance helper ─────────────────────────────────────────────────────

/// Current debt = principal × (currentBorrowIndex / snapshotIndex)
pub fn current_borrow_balance(
    principal: u64,
    borrow_index: u128,
    index_snapshot: u128,
) -> Result<u64, ProgramError> {
    if index_snapshot == 0 || principal == 0 {
        return Ok(0);
    }
    let scaled = (principal as u128)
        .checked_mul(borrow_index)
        .ok_or(ProgramError::ArithmeticOverflow)?
        / index_snapshot;
    Ok(scaled.min(u64::MAX as u128) as u64)
}

// ── Deposit balance helper ────────────────────────────────────────────────────

/// Current deposit value = shares × supplyIndex / WAD
pub fn current_deposit_balance(shares: u64, supply_index: u128) -> Result<u64, ProgramError> {
    let balance = (shares as u128)
        .checked_mul(supply_index)
        .ok_or(ProgramError::ArithmeticOverflow)?
        / WAD;
    Ok(balance.min(u64::MAX as u128) as u64)
}

/// Shares minted for a deposit = amount × WAD / supplyIndex
pub fn deposit_to_shares(amount: u64, supply_index: u128) -> Result<u64, ProgramError> {
    let shares = wad_div(amount as u128, supply_index)?;
    Ok(shares.min(u64::MAX as u128) as u64)
}

// ── Health factor ─────────────────────────────────────────────────────────────

/// HF = (depositBalance × liquidationThreshold) / debtBalance  (WAD-scaled)
///
/// Returns `u128::MAX` when debt is zero (fully collateralised).
pub fn health_factor(
    deposit_balance: u64,
    debt_balance: u64,
    liquidation_threshold: u128,
) -> Result<u128, ProgramError> {
    if debt_balance == 0 {
        return Ok(u128::MAX);
    }
    let weighted = wad_mul(deposit_balance as u128, liquidation_threshold)?;
    wad_div(weighted, debt_balance as u128)
}

/// Max tokens a user may borrow given their deposit balance.
/// maxBorrowable = depositBalance × LTV
pub fn max_borrowable(deposit_balance: u64, ltv: u128) -> Result<u64, ProgramError> {
    let max = wad_mul(deposit_balance as u128, ltv)?;
    Ok(max.min(u64::MAX as u128) as u64)
}

// ── Cross-collateral helpers ─────────────────────────────────────────────────

/// Convert a token amount to WAD-scaled USD value.
///
/// result = amount × |oracle_price| × 10^(18 + oracle_expo - token_decimals)
///
/// Example: 1_000_000 USDC (6 dec) at price 100_000_000 (expo -8)
///   = 1_000_000 × 100_000_000 × 10^(18 + (-8) - 6)
///   = 1_000_000 × 100_000_000 × 10^4
///   = 1_000_000_000_000_000_000 = 1.0 WAD = $1.00
pub fn token_to_usd_wad(
    amount: u64,
    oracle_price: i64,
    oracle_expo: i32,
    token_decimals: u8,
) -> Result<u128, ProgramError> {
    if amount == 0 || oracle_price <= 0 {
        return Ok(0);
    }
    let price = oracle_price as u128;
    let base = (amount as u128)
        .checked_mul(price)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // scale_exp = 18 + oracle_expo - token_decimals
    let scale_exp: i32 = 18 + oracle_expo - (token_decimals as i32);

    if scale_exp >= 0 {
        let factor = 10u128
            .checked_pow(scale_exp as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        base.checked_mul(factor)
            .ok_or(ProgramError::ArithmeticOverflow)
    } else {
        let divisor = 10u128
            .checked_pow((-scale_exp) as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        Ok(base / divisor)
    }
}

/// Cross-collateral health factor.
///
/// HF = weighted_collateral_usd / total_debt_usd  (both WAD-scaled USD)
///
/// Since both inputs are WAD-scaled, we compute HF as a WAD-scaled ratio:
///   HF = (collateral × WAD) / debt
///
/// To avoid u128 overflow when collateral is large (e.g., $10,000 = 1e22),
/// we divide first then scale: HF = (collateral / debt) × WAD + remainder.
///
/// Returns `u128::MAX` when debt is zero.
pub fn cross_health_factor(
    weighted_collateral_usd: u128,
    total_debt_usd: u128,
) -> Result<u128, ProgramError> {
    if total_debt_usd == 0 {
        return Ok(u128::MAX);
    }
    wad_div(weighted_collateral_usd, total_debt_usd)
}

/// Max additional USD (WAD-scaled) a user may borrow given cross-collateral.
///
/// `ltv_weighted_collateral_usd` is already multiplied by each pool's LTV.
/// Returns 0 if existing debt exceeds the cap.
pub fn cross_max_borrowable_usd(
    ltv_weighted_collateral_usd: u128,
    existing_debt_usd: u128,
) -> Result<u128, ProgramError> {
    Ok(ltv_weighted_collateral_usd.saturating_sub(existing_debt_usd))
}

/// Convert a USD WAD amount back to token amount.
///
/// Inverse of `token_to_usd_wad`:
/// tokens = usd_wad / (|oracle_price| × 10^(18 + oracle_expo - token_decimals))
pub fn usd_wad_to_tokens(
    usd_wad: u128,
    oracle_price: i64,
    oracle_expo: i32,
    token_decimals: u8,
) -> Result<u64, ProgramError> {
    if usd_wad == 0 || oracle_price <= 0 {
        return Ok(0);
    }
    let price = oracle_price as u128;
    let scale_exp: i32 = 18 + oracle_expo - (token_decimals as i32);

    let tokens = if scale_exp >= 0 {
        let factor = 10u128
            .checked_pow(scale_exp as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let denom = price
            .checked_mul(factor)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if denom == 0 {
            return Ok(0);
        }
        usd_wad / denom
    } else {
        let factor = 10u128
            .checked_pow((-scale_exp) as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        usd_wad
            .checked_mul(factor)
            .ok_or(ProgramError::ArithmeticOverflow)?
            / price
    };

    Ok(tokens.min(u64::MAX as u128) as u64)
}

// ── Flash loan helpers ────────────────────────────────────────────────────────

/// Fee charged on a flash loan: amount × fee_bps / 10_000
pub fn flash_fee(amount: u64, fee_bps: u64) -> Result<u64, ProgramError> {
    (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_div(10_000)
        .map(|v| v.min(u64::MAX as u128) as u64)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Split `fee` into (lp_portion, protocol_portion).
/// LP gets 90 %, protocol gets 10 % (rounding leaves remainder with LPs).
pub fn split_flash_fee(fee: u64) -> (u64, u64) {
    let protocol = fee / 10;
    let lp = fee.saturating_sub(protocol);
    (lp, protocol)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // ── wad_mul ──────────────────────────────────────────────────────────────

    #[test]
    fn wad_mul_zero_left() {
        assert_eq!(wad_mul(0, WAD).unwrap(), 0);
    }

    #[test]
    fn wad_mul_zero_right() {
        assert_eq!(wad_mul(WAD, 0).unwrap(), 0);
    }

    #[test]
    fn wad_mul_identity() {
        // 1.0 × 1.0 = 1.0
        assert_eq!(wad_mul(WAD, WAD).unwrap(), WAD);
    }

    #[test]
    fn wad_mul_two_times_three() {
        // 2.0 × 3.0 = 6.0
        assert_eq!(wad_mul(2 * WAD, 3 * WAD).unwrap(), 6 * WAD);
    }

    #[test]
    fn wad_mul_half() {
        // 1.0 × 0.5 = 0.5
        assert_eq!(wad_mul(WAD, WAD / 2).unwrap(), WAD / 2);
    }

    #[test]
    fn wad_mul_less_than_one() {
        // 0.05 × 0.05 = 0.0025
        assert_eq!(
            wad_mul(WAD / 20, WAD / 20).unwrap(),
            WAD / 400
        );
    }

    #[test]
    fn wad_mul_overflow_returns_err() {
        // u128::MAX × u128::MAX overflows even with fallback
        assert!(wad_mul(u128::MAX, u128::MAX).is_err());
    }

    #[test]
    fn wad_mul_large_values_succeed() {
        // Large values that previously overflowed now use the fallback path
        let result = wad_mul(u128::MAX, 2).unwrap();
        // u128::MAX * 2 / WAD ≈ (u128::MAX / WAD) * 2
        let expected = (u128::MAX / WAD) * 2 + (u128::MAX % WAD) * 2 / WAD;
        assert_eq!(result, expected);
    }

    // ── wad_div ──────────────────────────────────────────────────────────────

    #[test]
    fn wad_div_zero_numerator() {
        assert_eq!(wad_div(0, WAD).unwrap(), 0);
    }

    #[test]
    fn wad_div_identity() {
        // 1.0 ÷ 1.0 = 1.0
        assert_eq!(wad_div(WAD, WAD).unwrap(), WAD);
    }

    #[test]
    fn wad_div_half() {
        // 1.0 ÷ 2.0 = 0.5
        assert_eq!(wad_div(WAD, 2 * WAD).unwrap(), WAD / 2);
    }

    #[test]
    fn wad_div_double() {
        // 2.0 ÷ 1.0 = 2.0  (a=2*WAD, b=WAD)
        assert_eq!(wad_div(2 * WAD, WAD).unwrap(), 2 * WAD);
    }

    #[test]
    fn wad_div_by_zero_returns_err() {
        assert!(wad_div(WAD, 0).is_err());
    }

    #[test]
    fn wad_div_small_values() {
        // 500 ÷ 1_000 (raw token amounts, not WAD-scaled)
        assert_eq!(wad_div(500, 1_000).unwrap(), WAD / 2);
    }

    #[test]
    fn wad_div_large_cross_health_factor() {
        // Real scenario: $42,500 liq-weighted collateral / $12,140 total debt
        // Both WAD-scaled → a = 42500e18, b = 12140e18
        // Expected HF ≈ 3.50 → 3.5 × WAD
        let collateral = 42_500u128 * WAD;
        let debt = 12_140u128 * WAD;
        let hf = wad_div(collateral, debt).unwrap();
        // 42500/12140 ≈ 3.5008...
        assert!(hf > 3 * WAD, "HF should be > 3.0, got {}", hf);
        assert!(hf < 4 * WAD, "HF should be < 4.0, got {}", hf);
        // Check precision: 42500/12140 = 3.500823... → within 0.001 WAD
        let expected = 3_500_823_723_228_995_057u128; // 42500e18 * 1e18 / 12140e18
        let diff = if hf > expected { hf - expected } else { expected - hf };
        assert!(diff < WAD / 1_000, "precision loss too large: diff={}", diff);
    }

    #[test]
    fn wad_div_50k_vs_140() {
        // $50,000 collateral / $140 debt → HF ≈ 357
        let a = 50_000u128 * WAD;
        let b = 140u128 * WAD;
        let result = wad_div(a, b).unwrap();
        // 50000/140 ≈ 357.142857...
        let expected_approx = 357 * WAD;
        assert!(result > expected_approx, "should be > 357 WAD");
        assert!(result < 358 * WAD, "should be < 358 WAD");
    }

    // ── utilization_rate ─────────────────────────────────────────────────────

    #[test]
    fn util_zero_deposits_returns_zero() {
        assert_eq!(utilization_rate(0, 0).unwrap(), 0);
        assert_eq!(utilization_rate(100, 0).unwrap(), 0);
    }

    #[test]
    fn util_zero_borrows_returns_zero() {
        assert_eq!(utilization_rate(0, 1_000_000).unwrap(), 0);
    }

    #[test]
    fn util_fifty_percent() {
        assert_eq!(utilization_rate(500_000, 1_000_000).unwrap(), WAD / 2);
    }

    #[test]
    fn util_hundred_percent() {
        assert_eq!(utilization_rate(1_000_000, 1_000_000).unwrap(), WAD);
    }

    #[test]
    fn util_optimal_eighty_percent() {
        // 800 / 1000 = 0.8 = OPTIMAL_UTIL
        assert_eq!(utilization_rate(800_000, 1_000_000).unwrap(), OPTIMAL_UTIL);
    }

    #[test]
    fn util_small_borrow() {
        // 1 / 1_000_000 = 1e-6  (no rounding loss since we're in WAD space)
        let u = utilization_rate(1, 1_000_000).unwrap();
        assert_eq!(u, WAD / 1_000_000);
    }

    // ── borrow_rate ──────────────────────────────────────────────────────────

    #[test]
    fn borrow_rate_zero_utilization() {
        // At 0% util: rate = BASE_RATE
        let r = borrow_rate(0, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        assert_eq!(r, BASE_RATE);
    }

    #[test]
    fn borrow_rate_at_kink() {
        // At exactly 80% util: rate = BASE_RATE + SLOPE1
        let r = borrow_rate(OPTIMAL_UTIL, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        assert_eq!(r, BASE_RATE + SLOPE1);
    }

    #[test]
    fn borrow_rate_below_kink() {
        // At 40% util (= OPTIMAL_UTIL / 2):
        // rate = BASE_RATE + (0.4/0.8) × SLOPE1 = BASE_RATE + SLOPE1/2
        let half_kink = OPTIMAL_UTIL / 2;
        let r = borrow_rate(half_kink, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        let expected = BASE_RATE + SLOPE1 / 2;
        assert_eq!(r, expected);
    }

    #[test]
    fn borrow_rate_above_kink_full() {
        // At 100% util: rate = BASE_RATE + SLOPE1 + SLOPE2
        let r = borrow_rate(WAD, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        assert_eq!(r, BASE_RATE + SLOPE1 + SLOPE2);
    }

    #[test]
    fn borrow_rate_above_kink_midpoint() {
        // At 90% util: excess = 10%, denominator = 20%
        // rate = BASE_RATE + SLOPE1 + (0.1/0.2) × SLOPE2 = BASE_RATE + SLOPE1 + SLOPE2/2
        let util_90 = WAD * 90 / 100;
        let r = borrow_rate(util_90, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        let expected = BASE_RATE + SLOPE1 + SLOPE2 / 2;
        assert_eq!(r, expected);
    }

    #[test]
    fn borrow_rate_monotonically_increasing() {
        // Rate should never decrease as utilization increases
        let utils = [0, WAD / 10, OPTIMAL_UTIL / 2, OPTIMAL_UTIL, WAD * 9 / 10, WAD];
        let mut prev = 0u128;
        for &u in &utils {
            let r = borrow_rate(u, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
            assert!(r >= prev, "rate not monotone at util={}", u);
            prev = r;
        }
    }

    // ── supply_rate ──────────────────────────────────────────────────────────

    #[test]
    fn supply_rate_zero_utilization() {
        // supplyRate = borrowRate × 0 × (1 - RF) = 0
        let br = borrow_rate(0, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        assert_eq!(supply_rate(br, 0, RESERVE_FACTOR).unwrap(), 0);
    }

    #[test]
    fn supply_rate_below_borrow_rate() {
        // supplyRate < borrowRate because RF > 0
        let util = OPTIMAL_UTIL;
        let br = borrow_rate(util, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        let sr = supply_rate(br, util, RESERVE_FACTOR).unwrap();
        assert!(sr < br, "supply rate must be less than borrow rate");
    }

    #[test]
    fn supply_rate_full_utilization_no_reserve() {
        // With zero reserve factor: supplyRate = borrowRate × U
        let br = borrow_rate(WAD, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
        let sr = supply_rate(br, WAD, 0).unwrap();
        // sr = br × WAD × WAD / WAD / WAD = br  (at 100% util with zero RF)
        assert_eq!(sr, br);
    }

    // ── accrue_indices ───────────────────────────────────────────────────────

    #[test]
    fn accrue_indices_zero_elapsed_no_change() {
        let (bi, si) = accrue_indices(WAD, WAD, BASE_RATE, BASE_RATE / 2, 0).unwrap();
        assert_eq!(bi, WAD);
        assert_eq!(si, WAD);
    }

    #[test]
    fn accrue_indices_one_year_at_ten_percent_borrow() {
        // After 1 year at 10% borrow rate: borrow_index ≈ 1.1 × WAD
        let borrow_rate_10pct = WAD / 10; // 10% annual
        let supply_rate_5pct = WAD / 20; // 5% annual (notional)
        let (bi, si) = accrue_indices(WAD, WAD, borrow_rate_10pct, supply_rate_5pct, SECONDS_PER_YEAR as u64).unwrap();
        // borrow_delta = 10% × SECONDS_PER_YEAR / SECONDS_PER_YEAR = 10% of WAD
        // borrow_factor = WAD + WAD/10 = 1.1 × WAD
        // new_borrow_index = WAD × 1.1 = 1.1 × WAD
        assert_eq!(bi, WAD + WAD / 10);
        assert_eq!(si, WAD + WAD / 20);
    }

    #[test]
    fn accrue_indices_one_day() {
        // 1 day / 365 days ≈ 0.274%  at 10% annual
        let borrow_rate_10pct = WAD / 10;
        let (bi, _) = accrue_indices(WAD, WAD, borrow_rate_10pct, 0, 86_400).unwrap();
        // borrow_delta = (WAD/10) × 86400 / 31_536_000 = WAD / 3650 (approx)
        let delta = WAD / 10 * 86_400 / SECONDS_PER_YEAR;
        assert_eq!(bi, WAD + delta);
    }

    #[test]
    fn accrue_indices_borrow_grows_faster_than_supply() {
        // With RF > 0, borrow index always grows faster than supply index
        let br = BASE_RATE + SLOPE1;
        let ur = OPTIMAL_UTIL;
        let sr = supply_rate(br, ur, RESERVE_FACTOR).unwrap();
        let (bi, si) = accrue_indices(WAD, WAD, br, sr, 86_400 * 30).unwrap();
        assert!(bi > si, "borrow index must grow faster than supply index");
    }

    // ── current_borrow_balance ───────────────────────────────────────────────

    #[test]
    fn borrow_balance_zero_principal() {
        assert_eq!(current_borrow_balance(0, 2 * WAD, WAD).unwrap(), 0);
    }

    #[test]
    fn borrow_balance_zero_snapshot_returns_zero() {
        assert_eq!(current_borrow_balance(1000, WAD, 0).unwrap(), 0);
    }

    #[test]
    fn borrow_balance_unchanged_when_index_same() {
        assert_eq!(current_borrow_balance(1000, WAD, WAD).unwrap(), 1000);
    }

    #[test]
    fn borrow_balance_doubles_when_index_doubles() {
        // principal × (2×WAD / WAD) = 2 × principal
        assert_eq!(current_borrow_balance(1000, 2 * WAD, WAD).unwrap(), 2000);
    }

    #[test]
    fn borrow_balance_ten_percent_growth() {
        // index grew 10%: debt grows by 10%
        let idx = WAD + WAD / 10; // 1.1 × WAD
        let debt = current_borrow_balance(1_000_000, idx, WAD).unwrap();
        // 1_000_000 × 1.1 = 1_100_000  (exact since no remainder)
        assert_eq!(debt, 1_100_000);
    }

    #[test]
    fn borrow_balance_partial_index_growth() {
        // snapshot=1.0, current=1.05 → 5% growth
        let snap = WAD;
        let curr = WAD + WAD / 20; // 1.05 × WAD
        let debt = current_borrow_balance(2_000_000, curr, snap).unwrap();
        assert_eq!(debt, 2_100_000);
    }

    // ── current_deposit_balance ──────────────────────────────────────────────

    #[test]
    fn deposit_balance_zero_shares() {
        assert_eq!(current_deposit_balance(0, WAD).unwrap(), 0);
    }

    #[test]
    fn deposit_balance_at_initial_index() {
        // shares × WAD / WAD = shares
        assert_eq!(current_deposit_balance(5_000, WAD).unwrap(), 5_000);
    }

    #[test]
    fn deposit_balance_grown_index() {
        // index grew 20%: balance grows by 20%
        let idx = WAD + WAD / 5; // 1.2 × WAD
        assert_eq!(current_deposit_balance(1_000, idx).unwrap(), 1_200);
    }

    // ── deposit_to_shares ────────────────────────────────────────────────────

    #[test]
    fn deposit_to_shares_at_initial_index() {
        // shares = amount × WAD / WAD = amount
        assert_eq!(deposit_to_shares(10_000, WAD).unwrap(), 10_000);
    }

    #[test]
    fn deposit_to_shares_with_grown_index() {
        // When index = 2.0, depositing 2000 tokens → 1000 shares
        assert_eq!(deposit_to_shares(2_000, 2 * WAD).unwrap(), 1_000);
    }

    #[test]
    fn deposit_to_shares_zero_amount() {
        assert_eq!(deposit_to_shares(0, WAD).unwrap(), 0);
    }

    #[test]
    fn deposit_shares_round_trip() {
        // deposit → shares → balance should recover the original amount
        let amount = 500_000u64;
        let index = WAD + WAD / 10; // 1.1
        let shares = deposit_to_shares(amount, index).unwrap();
        let back = current_deposit_balance(shares, index).unwrap();
        // Small rounding loss of at most 1 token is acceptable
        assert!(amount.abs_diff(back) <= 1, "round-trip diff too large: {} vs {}", amount, back);
    }

    // ── health_factor ────────────────────────────────────────────────────────

    #[test]
    fn hf_no_debt_returns_max() {
        assert_eq!(health_factor(1_000, 0, LIQ_THRESHOLD).unwrap(), u128::MAX);
    }

    #[test]
    fn hf_exactly_at_liquidation_boundary() {
        // deposit=1250, debt=1000, threshold=0.8
        // HF = (1250 × 0.8) / 1000 = 1.0 exactly
        let hf = health_factor(1_250, 1_000, LIQ_THRESHOLD).unwrap();
        assert_eq!(hf, WAD);
    }

    #[test]
    fn hf_healthy_position() {
        // deposit=2000, debt=1000, threshold=0.8
        // HF = (2000 × 0.8) / 1000 = 1.6 × WAD
        let hf = health_factor(2_000, 1_000, LIQ_THRESHOLD).unwrap();
        assert_eq!(hf, WAD * 16 / 10);
    }

    #[test]
    fn hf_unhealthy_position() {
        // deposit=1000, debt=1000, threshold=0.8
        // HF = (1000 × 0.8) / 1000 = 0.8 × WAD  →  < WAD  →  liquidatable
        let hf = health_factor(1_000, 1_000, LIQ_THRESHOLD).unwrap();
        assert_eq!(hf, WAD * 8 / 10);
        assert!(hf < WAD, "position should be unhealthy");
    }

    #[test]
    fn hf_just_below_liquidation() {
        // deposit=1249, debt=1000 → HF just under 1.0
        let hf = health_factor(1_249, 1_000, LIQ_THRESHOLD).unwrap();
        assert!(hf < WAD, "HF {} should be < WAD", hf);
    }

    #[test]
    fn hf_just_above_liquidation() {
        // deposit=1252, debt=1000, liq_threshold=0.8
        // weighted = wad_mul(1252, 0.8e18) = 1001 → HF = 1001/1000 * WAD > WAD
        let hf = health_factor(1_252, 1_000, LIQ_THRESHOLD).unwrap();
        assert!(hf > WAD, "HF {} should be > WAD", hf);
    }

    #[test]
    fn hf_zero_deposit_zero_debt_returns_max() {
        // No position at all
        assert_eq!(health_factor(0, 0, LIQ_THRESHOLD).unwrap(), u128::MAX);
    }

    // ── max_borrowable ───────────────────────────────────────────────────────

    #[test]
    fn max_borrowable_zero_deposit() {
        assert_eq!(max_borrowable(0, LTV).unwrap(), 0);
    }

    #[test]
    fn max_borrowable_ltv_75_percent() {
        // 1000 tokens × 75% LTV = 750
        assert_eq!(max_borrowable(1_000, LTV).unwrap(), 750);
    }

    #[test]
    fn max_borrowable_large_deposit() {
        // 1_000_000 × 75% = 750_000
        assert_eq!(max_borrowable(1_000_000, LTV).unwrap(), 750_000);
    }

    #[test]
    fn max_borrowable_full_ltv() {
        // LTV = WAD (100%) → borrowable = deposit
        assert_eq!(max_borrowable(1_000, WAD).unwrap(), 1_000);
    }

    // ── token_to_usd_wad ────────────────────────────────────────────────────

    #[test]
    fn token_to_usd_zero_amount() {
        assert_eq!(token_to_usd_wad(0, 100_000_000, -8, 6).unwrap(), 0);
    }

    #[test]
    fn token_to_usd_negative_price_returns_zero() {
        assert_eq!(token_to_usd_wad(1_000_000, -1, -8, 6).unwrap(), 0);
    }

    #[test]
    fn token_to_usd_usdc_one_dollar() {
        // 1 USDC = 1_000_000 units, price = $1.00 (100_000_000 with expo -8), 6 decimals
        // = 1_000_000 × 100_000_000 × 10^(18-8-6) = 1e14 × 1e4 = 1e18 = WAD
        let usd = token_to_usd_wad(1_000_000, 100_000_000, -8, 6).unwrap();
        assert_eq!(usd, WAD);
    }

    #[test]
    fn token_to_usd_sol_at_150() {
        // 1 SOL = 1_000_000_000 units (9 dec), price = $150 (15_000_000_000 with expo -8)
        // = 1e9 × 15e9 × 10^(18-8-9) = 15e18 × 10^1 = 150 × WAD
        let usd = token_to_usd_wad(1_000_000_000, 15_000_000_000, -8, 9).unwrap();
        assert_eq!(usd, 150 * WAD);
    }

    #[test]
    fn token_to_usd_btc_at_100k() {
        // 1 BTC = 100_000_000 units (8 dec), price = $100,000 (10_000_000_000_000 with expo -8)
        // = 1e8 × 1e13 × 10^(18-8-8) = 1e21 × 1e2 = 1e23 = 100_000 × WAD
        let usd = token_to_usd_wad(100_000_000, 10_000_000_000_000, -8, 8).unwrap();
        assert_eq!(usd, 100_000 * WAD);
    }

    #[test]
    fn token_to_usd_fractional_sol() {
        // 0.5 SOL at $150 = $75
        let usd = token_to_usd_wad(500_000_000, 15_000_000_000, -8, 9).unwrap();
        assert_eq!(usd, 75 * WAD);
    }

    // ── cross_health_factor ─────────────────────────────────────────────────

    #[test]
    fn cross_hf_no_debt_returns_max() {
        assert_eq!(cross_health_factor(100 * WAD, 0).unwrap(), u128::MAX);
    }

    #[test]
    fn cross_hf_equal_collateral_and_debt() {
        // weighted_collateral = debt → HF = 1.0
        let hf = cross_health_factor(WAD * 100, WAD * 100).unwrap();
        assert_eq!(hf, WAD);
    }

    #[test]
    fn cross_hf_healthy() {
        // $200 weighted collateral, $100 debt → HF = 2.0
        let hf = cross_health_factor(200 * WAD, 100 * WAD).unwrap();
        assert_eq!(hf, 2 * WAD);
    }

    #[test]
    fn cross_hf_unhealthy() {
        // $80 weighted collateral, $100 debt → HF = 0.8
        let hf = cross_health_factor(80 * WAD, 100 * WAD).unwrap();
        assert_eq!(hf, WAD * 80 / 100);
    }

    #[test]
    fn cross_hf_large_collateral_small_debt() {
        // Real scenario: $42,500 liq-weighted vs $12,140 debt (both WAD-scaled)
        // This previously overflowed in wad_div's fallback path
        let hf = cross_health_factor(42_500 * WAD, 12_140 * WAD).unwrap();
        assert!(hf > 3 * WAD && hf < 4 * WAD, "HF ≈ 3.50, got {}", hf);
    }

    #[test]
    fn cross_hf_50k_collateral_140_debt() {
        // $50k collateral, $140 debt → HF ≈ 357
        let hf = cross_health_factor(50_000 * WAD, 140 * WAD).unwrap();
        assert!(hf > 357 * WAD && hf < 358 * WAD);
    }

    // ── cross_max_borrowable_usd ────────────────────────────────────────────

    #[test]
    fn cross_max_borrow_no_existing_debt() {
        assert_eq!(cross_max_borrowable_usd(750 * WAD, 0).unwrap(), 750 * WAD);
    }

    #[test]
    fn cross_max_borrow_with_existing_debt() {
        assert_eq!(cross_max_borrowable_usd(750 * WAD, 500 * WAD).unwrap(), 250 * WAD);
    }

    #[test]
    fn cross_max_borrow_debt_exceeds_cap() {
        assert_eq!(cross_max_borrowable_usd(750 * WAD, 800 * WAD).unwrap(), 0);
    }

    // ── usd_wad_to_tokens ───────────────────────────────────────────────────

    #[test]
    fn usd_to_tokens_zero() {
        assert_eq!(usd_wad_to_tokens(0, 100_000_000, -8, 6).unwrap(), 0);
    }

    #[test]
    fn usd_to_tokens_usdc_one_dollar() {
        // $1.00 WAD at USDC price → 1_000_000 units
        let tokens = usd_wad_to_tokens(WAD, 100_000_000, -8, 6).unwrap();
        assert_eq!(tokens, 1_000_000);
    }

    #[test]
    fn usd_to_tokens_sol_150_usd() {
        // $150 WAD at SOL $150 → 1 SOL = 1_000_000_000
        let tokens = usd_wad_to_tokens(150 * WAD, 15_000_000_000, -8, 9).unwrap();
        assert_eq!(tokens, 1_000_000_000);
    }

    #[test]
    fn token_to_usd_round_trip() {
        // Convert 2.5 SOL to USD, then back — should recover original amount
        let amount = 2_500_000_000u64; // 2.5 SOL
        let price = 15_000_000_000i64; // $150
        let expo = -8i32;
        let dec = 9u8;
        let usd = token_to_usd_wad(amount, price, expo, dec).unwrap();
        let back = usd_wad_to_tokens(usd, price, expo, dec).unwrap();
        assert_eq!(back, amount);
    }
}
