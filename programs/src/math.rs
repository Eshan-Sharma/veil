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

// ── Core WAD helpers ─────────────────────────────────────────────────────────

/// Multiply two WAD-scaled values: (a × b) / WAD
#[inline(always)]
pub fn wad_mul(a: u128, b: u128) -> Result<u128, ProgramError> {
    a.checked_mul(b)
        .map(|x| x / WAD)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Divide two WAD-scaled values: (a × WAD) / b
#[inline(always)]
pub fn wad_div(a: u128, b: u128) -> Result<u128, ProgramError> {
    if b == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    a.checked_mul(WAD)
        .map(|x| x / b)
        .ok_or(ProgramError::ArithmeticOverflow)
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
