//! Tests for `crate::state::lending_pool`.

use crate::math::*;
use crate::state::LendingPool;

/// Build a zeroed pool with all default parameters and WAD indices.
fn default_pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.base_rate = BASE_RATE;
    pool.optimal_utilization = OPTIMAL_UTIL;
    pool.slope1 = SLOPE1;
    pool.slope2 = SLOPE2;
    pool.reserve_factor = RESERVE_FACTOR;
    pool.ltv = LTV;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.liquidation_bonus = LIQ_BONUS;
    pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
    pool.close_factor = CLOSE_FACTOR;
    pool.last_update_timestamp = 0;
    pool
}

// ── Default values ────────────────────────────────────────────────────────

#[test]
fn default_pool_starts_with_wad_indices() {
    let pool = default_pool();
    assert_eq!(pool.borrow_index, WAD);
    assert_eq!(pool.supply_index, WAD);
}

#[test]
fn default_pool_ltv_is_75_percent() {
    let pool = default_pool();
    assert_eq!(pool.ltv, LTV);
    // 75% of WAD
    assert_eq!(pool.ltv, WAD * 75 / 100);
}

#[test]
fn default_pool_liq_threshold_is_80_percent() {
    let pool = default_pool();
    assert_eq!(pool.liquidation_threshold, LIQ_THRESHOLD);
    assert_eq!(pool.liquidation_threshold, WAD * 80 / 100);
}

#[test]
fn default_pool_close_factor_is_50_percent() {
    let pool = default_pool();
    assert_eq!(pool.close_factor, CLOSE_FACTOR);
    assert_eq!(pool.close_factor, WAD / 2);
}

// ── accrue_interest: no-op cases ─────────────────────────────────────────

#[test]
fn accrue_noop_same_timestamp() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    pool.accrue_interest(0).unwrap();
    // Elapsed = 0 → no change
    assert_eq!(pool.borrow_index, WAD);
    assert_eq!(pool.supply_index, WAD);
    assert_eq!(pool.total_deposits, 1_000_000);
    assert_eq!(pool.total_borrows, 500_000);
}

#[test]
fn accrue_noop_backwards_timestamp() {
    let mut pool = default_pool();
    pool.last_update_timestamp = 1000;
    pool.total_borrows = 500_000;
    pool.total_deposits = 1_000_000;
    let bi_before = pool.borrow_index;
    // Timestamp goes backward → function returns Ok but does nothing
    pool.accrue_interest(999).unwrap();
    assert_eq!(pool.borrow_index, bi_before);
}

// ── accrue_interest: no borrows ──────────────────────────────────────────

#[test]
fn accrue_no_borrows_indices_stay_at_wad() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 0;
    pool.accrue_interest(86_400).unwrap(); // 1 day
    // Utilization = 0 → supply rate = 0 → supply index stays at WAD
    // Borrow index grows by BASE_RATE × 1day / 1year (very small)
    // but with 0 borrows, the fee/deposit additions are 0
    assert_eq!(pool.accumulated_fees, 0);
    assert_eq!(pool.total_deposits, 1_000_000);
    // Supply index should not grow when utilization is zero
    assert_eq!(pool.supply_index, WAD);
}

// ── accrue_interest: with borrows ────────────────────────────────────────

#[test]
fn accrue_with_borrows_borrow_index_grows() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 800_000; // 80% utilization (at kink)
    pool.accrue_interest(86_400).unwrap(); // 1 day
    // At kink: borrow_rate = BASE_RATE + SLOPE1 = 1% + 4% = 5% annual
    // borrow_index grows by 5% × 1/365 ≈ 0.0137%
    assert!(pool.borrow_index > WAD, "borrow index must grow");
    assert!(pool.supply_index > WAD, "supply index must grow (some borrows)");
}

#[test]
fn accrue_with_borrows_fees_accrue() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000; // 50% utilization
    pool.accrue_interest(86_400 * 30).unwrap(); // 30 days
    assert!(pool.accumulated_fees > 0, "fees must accrue over 30 days");
}

#[test]
fn accrue_total_deposits_grows_with_interest() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    pool.accrue_interest(86_400 * 365).unwrap(); // 1 year
    // Depositors earn some interest (net of reserve factor)
    assert!(pool.total_deposits > 1_000_000);
}

#[test]
fn accrue_total_borrows_grows_with_interest() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    pool.accrue_interest(86_400 * 365).unwrap(); // 1 year
    // Borrowers owe more after a year
    assert!(pool.total_borrows > 500_000);
}

#[test]
fn accrue_updates_timestamp() {
    let mut pool = default_pool();
    pool.last_update_timestamp = 0;
    pool.accrue_interest(12_345).unwrap();
    assert_eq!(pool.last_update_timestamp, 12_345);
}

// ── accrue_interest: above kink ──────────────────────────────────────────

#[test]
fn accrue_above_kink_higher_borrow_index_growth() {
    // At 95% utilization borrow rate is much higher than at 50%
    let mut pool_low = default_pool();
    pool_low.total_deposits = 1_000_000;
    pool_low.total_borrows = 500_000; // 50% util
    pool_low.accrue_interest(86_400).unwrap();
    let low_growth = pool_low.borrow_index - WAD;

    let mut pool_high = default_pool();
    pool_high.total_deposits = 1_000_000;
    pool_high.total_borrows = 950_000; // 95% util (above kink)
    pool_high.accrue_interest(86_400).unwrap();
    let high_growth = pool_high.borrow_index - WAD;

    assert!(
        high_growth > low_growth,
        "above-kink borrow index growth ({}) must exceed below-kink ({})",
        high_growth,
        low_growth
    );
}

#[test]
fn accrue_full_utilization_maximum_rate() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 1_000_000; // 100% utilization
    pool.accrue_interest(86_400 * 365).unwrap();
    // At 100% util: borrow_rate = BASE_RATE + SLOPE1 + SLOPE2 = 1+4+75 = 80% annual
    // After 1 year borrow_index ≈ WAD × 1.8
    let expected_approx = WAD + WAD * 8 / 10; // 1.8 × WAD
    // Allow ±1% tolerance for integer rounding
    let tolerance = expected_approx / 100;
    assert!(
        pool.borrow_index > expected_approx - tolerance,
        "borrow index {} too low",
        pool.borrow_index
    );
    assert!(
        pool.borrow_index < expected_approx + tolerance,
        "borrow index {} too high",
        pool.borrow_index
    );
}

// ── Incremental vs batch accrual ─────────────────────────────────────────

#[test]
fn accrue_two_steps_equals_one_step_approx() {
    // Accruing in two steps of 12h should be close to one step of 24h.
    // (Not exactly equal due to compounding, but within 0.1% for short periods.)
    let deposits = 1_000_000u64;
    let borrows = 600_000u64;

    let mut single = default_pool();
    single.total_deposits = deposits;
    single.total_borrows = borrows;
    single.accrue_interest(86_400).unwrap();

    let mut incremental = default_pool();
    incremental.total_deposits = deposits;
    incremental.total_borrows = borrows;
    incremental.accrue_interest(43_200).unwrap();
    incremental.accrue_interest(86_400).unwrap();

    // Borrow indices should be within 0.001% of each other
    let diff = single.borrow_index.abs_diff(incremental.borrow_index);
    let tolerance = WAD / 100_000; // 0.001%
    assert!(
        diff < tolerance,
        "borrow index divergence too large: {} vs {}",
        single.borrow_index,
        incremental.borrow_index
    );
}

// ── SIZE constant ────────────────────────────────────────────────────────

#[test]
fn lending_pool_size_matches_struct() {
    assert_eq!(core::mem::size_of::<LendingPool>(), LendingPool::SIZE);
}
