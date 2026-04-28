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
        // Round-to-nearest instead of floor. Pure floor truncates dust
        // amounts to $0 even when the true value is non-trivial — an
        // attacker could otherwise repeatedly borrow tiny amounts that
        // contribute zero to the global debt USD total.
        let half = divisor / 2;
        Ok(base.saturating_add(half) / divisor)
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

/// Minimum loan size for flash loans. Below this, `flash_fee` rounds to zero
/// at any fee_bps ≤ 90, letting an attacker iterate dust loans for free.
pub const MIN_FLASH_AMOUNT: u64 = 10_000;

/// Fee charged on a flash loan: amount × fee_bps / 10_000.
///
/// Rounds *up* to a minimum of 1 token unit for any non-zero amount. Without
/// this, sub-1112-unit loans at 9 bps round to zero and become unfee-able
/// scriptable primitives.
pub fn flash_fee(amount: u64, fee_bps: u64) -> Result<u64, ProgramError> {
    if amount == 0 {
        return Ok(0);
    }
    if amount < MIN_FLASH_AMOUNT {
        return Err(ProgramError::InvalidArgument);
    }
    let raw = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let raw = raw.min(u64::MAX as u128) as u64;
    Ok(raw.max(1))
}

/// Split `fee` into (lp_portion, protocol_portion) using the configured
/// share constants. LP gets `FLASH_LP_SHARE_BPS`, protocol gets
/// `FLASH_PROTOCOL_SHARE_BPS`. Rounding leaves any remainder with LPs.
pub fn split_flash_fee(fee: u64) -> (u64, u64) {
    let protocol = ((fee as u128) * (FLASH_PROTOCOL_SHARE_BPS as u128)
        / ((FLASH_PROTOCOL_SHARE_BPS + FLASH_LP_SHARE_BPS) as u128)) as u64;
    let lp = fee.saturating_sub(protocol);
    (lp, protocol)
}
