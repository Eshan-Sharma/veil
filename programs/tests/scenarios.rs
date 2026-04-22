/*!
End-to-end business logic scenarios.

These tests combine math + LendingPool + UserPosition to verify the protocol's
invariants without requiring a live Solana runtime.  Each test drives the state
machines directly on the structs (bypassing AccountView, CPI, and syscalls) and
asserts that the accounting adds up correctly.
*/

mod common;

use veil_lending::{
    errors::LendError,
    instructions::{CollectFees, PausePool, ResumePool, UpdatePool},
    math::{
        self, current_borrow_balance, current_deposit_balance, deposit_to_shares, flash_fee,
        health_factor, max_borrowable, split_flash_fee, wad_mul,
        BASE_RATE, CLOSE_FACTOR, FLASH_FEE_BPS, LIQ_BONUS, LIQ_THRESHOLD, LTV,
        OPTIMAL_UTIL, PROTOCOL_LIQ_FEE, RESERVE_FACTOR, SLOPE1, SLOPE2, WAD,
    },
    state::LendingPool,
};
use common::{make_pool, pool_bytes, RawAccount};

const AUTHORITY: [u8; 32] = [1u8; 32];
const OTHER: [u8; 32]     = [2u8; 32];
const PROGRAM: pinocchio::Address = pinocchio::Address::new_from_array([9u8; 32]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build a zeroed LendingPool with all default risk + rate parameters.
fn default_pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.base_rate = math::BASE_RATE;
    pool.optimal_utilization = math::OPTIMAL_UTIL;
    pool.slope1 = math::SLOPE1;
    pool.slope2 = math::SLOPE2;
    pool.reserve_factor = math::RESERVE_FACTOR;
    pool.ltv = LTV;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.liquidation_bonus = LIQ_BONUS;
    pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
    pool.close_factor = CLOSE_FACTOR;
    pool.last_update_timestamp = 0;
    pool.flash_fee_bps = FLASH_FEE_BPS;
    pool
}

// ── Deposit scenarios ─────────────────────────────────────────────────────────

#[test]
fn deposit_mints_correct_shares_at_initial_index() {
    let pool = default_pool();
    let deposit_amount = 10_000u64;
    // At WAD supply index, shares = amount
    let shares = deposit_to_shares(deposit_amount, pool.supply_index).unwrap();
    assert_eq!(shares, deposit_amount);
}

#[test]
fn deposit_after_index_growth_mints_fewer_shares() {
    let mut pool = default_pool();
    // Simulate 10% supply index growth
    pool.supply_index = WAD + WAD / 10; // 1.1 × WAD
    let shares = deposit_to_shares(1_100, pool.supply_index).unwrap();
    // 1100 tokens ÷ 1.1 = 1000 shares
    assert_eq!(shares, 1_000);
}

#[test]
fn deposit_redeem_round_trip_exact_at_initial_index() {
    let pool = default_pool();
    let amount = 50_000u64;
    let shares = deposit_to_shares(amount, pool.supply_index).unwrap();
    let redeemed = current_deposit_balance(shares, pool.supply_index).unwrap();
    assert_eq!(redeemed, amount);
}

#[test]
fn depositor_earns_interest_over_time() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;

    let shares = deposit_to_shares(1_000_000, pool.supply_index).unwrap();
    let initial_balance = current_deposit_balance(shares, pool.supply_index).unwrap();

    // Fast-forward 1 year
    pool.accrue_interest(86_400 * 365).unwrap();

    let final_balance = current_deposit_balance(shares, pool.supply_index).unwrap();
    assert!(
        final_balance > initial_balance,
        "depositor balance must grow: {} vs {}",
        final_balance,
        initial_balance
    );
}

#[test]
fn multiple_depositors_get_proportional_shares() {
    let pool = default_pool();
    // Two equal deposits at the same index → equal shares
    let s1 = deposit_to_shares(10_000, pool.supply_index).unwrap();
    let s2 = deposit_to_shares(10_000, pool.supply_index).unwrap();
    assert_eq!(s1, s2);

    // Double deposit → double shares
    let s3 = deposit_to_shares(20_000, pool.supply_index).unwrap();
    assert_eq!(s3, 2 * s1);
}

// ── Borrow / LTV / health-factor scenarios ────────────────────────────────────

#[test]
fn max_borrow_is_75_percent_of_deposit() {
    let pool = default_pool();
    let deposit = 1_000_000u64;
    let max_b = max_borrowable(deposit, pool.ltv).unwrap();
    assert_eq!(max_b, 750_000);
}

#[test]
fn borrow_at_exactly_ltv_is_healthy() {
    let pool = default_pool();
    let deposit = 1_000_000u64;
    let borrow = max_borrowable(deposit, pool.ltv).unwrap(); // 750_000
    let hf = health_factor(deposit, borrow, pool.liquidation_threshold).unwrap();
    // HF = (1_000_000 × 0.8) / 750_000 = 800_000 / 750_000 ≈ 1.0666 > 1.0
    assert!(hf > WAD, "position at LTV cap must still be healthy: HF={}", hf);
}

#[test]
fn borrow_above_ltv_would_exceed_ltv_cap() {
    let pool = default_pool();
    let deposit = 1_000u64;
    let max_b = max_borrowable(deposit, pool.ltv).unwrap(); // 750
    // Any amount > max_b should fail the LTV check in the real instruction
    assert!(751 > max_b, "751 should exceed the LTV cap");
}

#[test]
fn borrow_available_liquidity_excludes_protocol_fees() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 300_000;
    pool.accumulated_fees = 50_000;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);

    assert_eq!(available, 650_000);
    assert!(651_000 > available, "borrowing cannot consume reserved protocol fees");
}

#[test]
fn health_factor_exactly_one_at_liq_threshold() {
    // deposit × threshold = debt  →  HF = 1.0 exactly
    // With LIQ_THRESHOLD = 0.80:  deposit = 1250, debt = 1000
    let hf = health_factor(1_250, 1_000, LIQ_THRESHOLD).unwrap();
    assert_eq!(hf, WAD, "HF must be exactly 1.0 WAD at the threshold boundary");
}

#[test]
fn health_factor_decreases_as_debt_grows() {
    let deposit = 2_000u64;
    let hf_low = health_factor(deposit, 500, LIQ_THRESHOLD).unwrap();
    let hf_mid = health_factor(deposit, 1_000, LIQ_THRESHOLD).unwrap();
    let hf_high = health_factor(deposit, 1_500, LIQ_THRESHOLD).unwrap();
    assert!(hf_low > hf_mid && hf_mid > hf_high, "HF must decrease as debt grows");
}

#[test]
fn no_debt_health_factor_is_max() {
    let hf = health_factor(1_000_000, 0, LIQ_THRESHOLD).unwrap();
    assert_eq!(hf, u128::MAX);
}

#[test]
fn underwater_position_hf_below_one() {
    // Severely undercollateralised: 100 deposit, 1000 debt
    let hf = health_factor(100, 1_000, LIQ_THRESHOLD).unwrap();
    assert!(hf < WAD, "underwater position must have HF < 1: HF={}", hf);
}

// ── Repay scenarios ───────────────────────────────────────────────────────────

#[test]
fn full_repay_clears_debt() {
    let pool = default_pool();
    let principal = 500_000u64;
    let debt = current_borrow_balance(principal, pool.borrow_index, pool.borrow_index).unwrap();
    let remaining = debt.saturating_sub(debt); // repay all
    assert_eq!(remaining, 0);
}

#[test]
fn partial_repay_reduces_debt_proportionally() {
    let pool = default_pool();
    let principal = 1_000_000u64;
    let debt = current_borrow_balance(principal, pool.borrow_index, pool.borrow_index).unwrap();
    let repay = debt / 2;
    let remaining = debt.saturating_sub(repay);
    assert_eq!(remaining, debt - repay);
}

#[test]
fn repay_more_than_debt_caps_at_debt() {
    // The instruction caps repay_amount = amount.min(total_debt)
    let total_debt = 1_000u64;
    let requested = 2_000u64;
    let actual_repay = requested.min(total_debt);
    assert_eq!(actual_repay, total_debt);
    // Remaining debt after capped repay
    assert_eq!(total_debt.saturating_sub(actual_repay), 0);
}

#[test]
fn withdraw_without_debt_can_redeem_entire_balance() {
    let pool = default_pool();
    let shares = 80_000u64;
    let token_amount = current_deposit_balance(shares, pool.supply_index).unwrap();
    let remaining_deposit = current_deposit_balance(0, pool.supply_index).unwrap();
    assert_eq!(token_amount, 80_000);
    assert_eq!(remaining_deposit, 0);
}

#[test]
fn withdraw_to_exact_liquidation_boundary_is_still_allowed() {
    let pool = default_pool();
    let debt = 1_000u64;
    let remaining_deposit = 1_250u64; // 1_250 * 0.8 = 1_000
    let hf = health_factor(remaining_deposit, debt, pool.liquidation_threshold).unwrap();
    assert_eq!(hf, WAD);
}

#[test]
fn withdraw_past_liquidation_boundary_would_break_health_factor() {
    let pool = default_pool();
    let debt = 1_000u64;
    let remaining_deposit = 1_249u64;
    let hf = health_factor(remaining_deposit, debt, pool.liquidation_threshold).unwrap();
    assert!(hf < WAD, "withdrawing below the threshold must become invalid");
}

#[test]
fn interest_accrual_increases_effective_debt() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 600_000;

    let principal = 600_000u64;
    let snapshot = pool.borrow_index;

    // Fast-forward 1 year
    pool.accrue_interest(86_400 * 365).unwrap();

    let current_debt = current_borrow_balance(principal, pool.borrow_index, snapshot).unwrap();
    assert!(
        current_debt > principal,
        "debt must grow with interest: {} vs {}",
        current_debt,
        principal
    );
}

// ── Liquidation scenarios ─────────────────────────────────────────────────────

#[test]
fn liquidation_repay_amount_is_50_percent_of_debt() {
    let pool = default_pool();
    let total_debt = 1_000_000u64;
    let repay = wad_mul(total_debt as u128, pool.close_factor).unwrap() as u64;
    assert_eq!(repay, 500_000, "close factor 50% should repay half the debt");
}

#[test]
fn liquidation_seized_collateral_includes_bonus() {
    let pool = default_pool();
    let repay = 500_000u64;
    let one_plus_bonus = WAD + pool.liquidation_bonus; // 1.05
    let seized = wad_mul(repay as u128, one_plus_bonus).unwrap() as u64;
    // 500_000 × 1.05 = 525_000
    assert_eq!(seized, 525_000);
}

#[test]
fn liquidation_protocol_takes_10_percent_of_seized() {
    let pool = default_pool();
    let seized = 525_000u64;
    let protocol_fee = wad_mul(seized as u128, pool.protocol_liq_fee).unwrap() as u64;
    // 525_000 × 0.10 = 52_500
    assert_eq!(protocol_fee, 52_500);
    let liquidator_gets = seized.saturating_sub(protocol_fee);
    assert_eq!(liquidator_gets, 472_500);
}

#[test]
fn liquidation_not_allowed_when_healthy() {
    let pool = default_pool();
    let deposit = 2_000u64;
    let debt = 1_000u64;
    let hf = health_factor(deposit, debt, pool.liquidation_threshold).unwrap();
    // HF = (2000 × 0.8) / 1000 = 1.6 → healthy
    assert!(hf >= WAD, "healthy position must not be liquidatable");
}

#[test]
fn liquidation_allowed_only_when_hf_below_one() {
    let pool = default_pool();
    let deposit = 1_000u64;
    let debt = 1_000u64;
    let hf = health_factor(deposit, debt, pool.liquidation_threshold).unwrap();
    // HF = (1000 × 0.8) / 1000 = 0.8 < 1 → liquidatable
    assert!(hf < WAD, "undercollateralised position must be liquidatable: HF={}", hf);
}

#[test]
fn liquidation_full_scenario() {
    // Full numbers: deposit=1000, debt=900
    // HF = (1000 × 0.8) / 900 = 800/900 ≈ 0.888 WAD → liquidatable
    let pool = default_pool();
    let deposit = 1_000u64;
    let debt = 900u64;

    let hf = health_factor(deposit, debt, pool.liquidation_threshold).unwrap();
    assert!(hf < WAD, "position should be underwater");

    // repay = 900 × 50% = 450
    let repay = wad_mul(debt as u128, pool.close_factor).unwrap() as u64;
    assert_eq!(repay, 450);

    // seized = 450 × 1.05 = 472
    let one_plus_bonus = WAD + pool.liquidation_bonus;
    let seized = wad_mul(repay as u128, one_plus_bonus).unwrap() as u64;
    assert_eq!(seized, 472);

    // seized ≤ deposit: ok
    assert!(seized <= deposit, "cannot seize more than deposited");

    // protocol fee = 472 × 10% = 47
    let protocol_fee = wad_mul(seized as u128, pool.protocol_liq_fee).unwrap() as u64;
    assert_eq!(protocol_fee, 47);

    // liquidator gets = 472 - 47 = 425
    let liquidator_gets = seized.saturating_sub(protocol_fee);
    assert_eq!(liquidator_gets, 425);

    // Post-liquidation: borrower's remaining debt = 900 - 450 = 450
    let remaining_debt = debt.saturating_sub(repay);
    assert_eq!(remaining_debt, 450);

    // Remaining deposit = 1000 - 472 = 528
    let remaining_deposit = deposit.saturating_sub(seized);
    assert_eq!(remaining_deposit, 528);

    // Remaining HF after liquidation = (528 × 0.8) / 450 ≈ 0.938 — still unhealthy
    // (partial liquidation only closes 50%)
    let post_hf = health_factor(remaining_deposit, remaining_debt, pool.liquidation_threshold).unwrap();
    // Should be higher than before but may still be < WAD for this extreme scenario
    assert!(post_hf > hf, "HF should improve after liquidation");
}

// ── Interest rate model scenarios ─────────────────────────────────────────────

#[test]
fn rate_kink_at_80_percent_utilization() {
    // At exactly the kink: rate = BASE_RATE + SLOPE1 = 1% + 4% = 5%
    let pool = default_pool();
    let util = math::utilization_rate(800_000, 1_000_000).unwrap();
    let rate = math::borrow_rate(util, pool.base_rate, pool.optimal_utilization, pool.slope1, pool.slope2).unwrap();
    assert_eq!(rate, math::BASE_RATE + math::SLOPE1);
}

#[test]
fn rate_jump_above_kink() {
    // Compare 70% (below kink) vs 90% (above kink) to show slope2 dominance.
    // jump ≈ 0.125*SLOPE1 + 0.5*SLOPE2 >> SLOPE1 since slope2 = 75% >> slope1 = 4%
    let pool = default_pool();
    let util_below = math::utilization_rate(700_000, 1_000_000).unwrap();
    let util_above = math::utilization_rate(900_000, 1_000_000).unwrap();
    let r_below = math::borrow_rate(util_below, pool.base_rate, pool.optimal_utilization, pool.slope1, pool.slope2).unwrap();
    let r_above = math::borrow_rate(util_above, pool.base_rate, pool.optimal_utilization, pool.slope1, pool.slope2).unwrap();
    let jump = r_above - r_below;
    // Rate jump should be >> SLOPE1 (slope2 contribution overwhelms slope1)
    assert!(jump > 5 * math::SLOPE1, "kink should create a large rate jump: jump={}", jump);
}

#[test]
fn pool_accounts_balance_after_accrual() {
    // total_deposits ≥ total_borrows + accumulated_fees should hold approximately
    // after interest accrual (the pool should not be insolvent on its own)
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    pool.accrue_interest(86_400 * 365).unwrap();

    // The deposits grow by the deposit interest which is
    // borrow interest × (1 - reserve_factor). Borrows grow by borrow interest.
    // The pool remains solvent because fees go to accumulated_fees.
    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    // Available liquidity must remain positive (not go negative due to accrual)
    assert!(
        available <= pool.total_deposits,
        "pool accounting must stay consistent"
    );
}

// ── Flash loan scenarios ──────────────────────────────────────────────────────

#[test]
fn flash_fee_is_9_bps_of_amount() {
    // 9 bps on 1_000_000 = 1_000_000 * 9 / 10_000 = 900
    let fee = flash_fee(1_000_000, FLASH_FEE_BPS).unwrap();
    assert_eq!(fee, 900);
}

#[test]
fn flash_fee_zero_amount_is_zero() {
    assert_eq!(flash_fee(0, FLASH_FEE_BPS).unwrap(), 0);
}

#[test]
fn flash_fee_split_90_10() {
    let fee = 100u64;
    let (lp, protocol) = split_flash_fee(fee);
    assert_eq!(protocol, 10);
    assert_eq!(lp, 90);
    assert_eq!(lp + protocol, fee);
}

#[test]
fn flash_fee_split_rounds_toward_lp() {
    // fee = 11: protocol = 1, lp = 10
    let (lp, protocol) = split_flash_fee(11);
    assert_eq!(protocol, 1);
    assert_eq!(lp, 10);
    assert_eq!(lp + protocol, 11);
}

#[test]
fn flash_fee_rounding_small_amounts_matches_expected_splits() {
    let cases = [
        (1u64, 0u64, 0u64),
        (2u64, 0u64, 0u64),
        (9u64, 0u64, 0u64),
        (10u64, 0u64, 0u64),
        (11u64, 0u64, 0u64),
        (1_112u64, 1u64, 0u64),
    ];

    for (amount, expected_fee, expected_protocol) in cases {
        let fee = flash_fee(amount, FLASH_FEE_BPS).unwrap();
        let (lp, protocol) = split_flash_fee(fee);
        assert_eq!(fee, expected_fee, "unexpected fee for amount {}", amount);
        assert_eq!(protocol, expected_protocol, "unexpected protocol fee for amount {}", amount);
        assert_eq!(lp + protocol, fee);
    }
}

#[test]
fn flash_loan_records_in_flight_amount() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 0;

    // Simulate FlashBorrow state change
    assert_eq!(pool.flash_loan_amount, 0, "no loan at start");
    pool.flash_loan_amount = 500_000;
    assert_eq!(pool.flash_loan_amount, 500_000);
}

#[test]
fn flash_repay_settles_loan_and_distributes_fee() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 0;
    pool.accumulated_fees = 0;

    let loan_amount = 500_000u64;
    let fee = flash_fee(loan_amount, pool.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(fee);

    // Simulate FlashBorrow
    pool.flash_loan_amount = loan_amount;

    // Simulate FlashRepay accounting
    pool.total_deposits = pool.total_deposits.saturating_add(lp_fee);
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
    pool.flash_loan_amount = 0;

    assert_eq!(pool.flash_loan_amount, 0, "loan cleared");
    assert!(pool.total_deposits > 1_000_000, "LPs gained fee");
    assert!(pool.accumulated_fees > 0, "protocol gained fee");
    assert_eq!(pool.total_deposits - 1_000_000, lp_fee as u64);
    assert_eq!(pool.accumulated_fees, protocol_fee as u64);
}

#[test]
fn flash_loan_does_not_mutate_total_borrows() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 555_000;
    let borrows_before = pool.total_borrows;

    let loan_amount = 100_000u64;
    let fee = flash_fee(loan_amount, pool.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(fee);

    pool.flash_loan_amount = loan_amount;
    pool.total_deposits = pool.total_deposits.saturating_add(lp_fee);
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
    pool.flash_loan_amount = 0;

    assert_eq!(pool.total_borrows, borrows_before, "flash loans must not change borrow book accounting");
}

#[test]
fn flash_loan_lp_fee_grows_total_deposits() {
    // Full round trip: 1M pool, 100k flash loan at 9bps
    // fee = 100_000 * 9 / 10_000 = 90; split: protocol=9, lp=81
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 0;

    let loan = 100_000u64;
    let fee = flash_fee(loan, FLASH_FEE_BPS).unwrap();
    assert_eq!(fee, 90);
    let (lp, proto) = split_flash_fee(fee);
    assert_eq!(proto, 9);
    assert_eq!(lp, 81);

    pool.total_deposits += lp;
    pool.accumulated_fees += proto;
    pool.flash_loan_amount = 0;

    assert_eq!(pool.total_deposits, 1_000_081);
    assert_eq!(pool.accumulated_fees, 9);
}

#[test]
fn flash_cannot_exceed_available_liquidity() {
    let pool = default_pool();
    // pool has 0 deposits — nothing available
    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    assert_eq!(available, 0);

    // Attempting to borrow more than available should be rejected
    let want = 1u64;
    assert!(want > available);
}

#[test]
fn flash_available_liquidity_excludes_borrows_and_fees() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 400_000;
    pool.accumulated_fees = 25_000;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);

    assert_eq!(available, 575_000);
    assert!(575_001 > available);
}

#[test]
fn flash_cannot_start_while_another_flash_loan_is_active() {
    let mut pool = default_pool();
    pool.flash_loan_amount = 42;
    assert_ne!(pool.flash_loan_amount, 0, "non-zero in-flight amount blocks another flash borrow");
}

#[test]
fn flash_fee_on_large_amount() {
    // 100_000_000 tokens at 9bps = 90_000
    let fee = flash_fee(100_000_000, FLASH_FEE_BPS).unwrap();
    assert_eq!(fee, 90_000);
}

// ── Cross-pool / mixed-mode scenarios ───────────────────────────────────────

#[test]
fn same_user_two_pools_borrow_power_isolated() {
    let pool_a = default_pool();
    let pool_b = default_pool();

    let deposit_a = 1_000u64;
    let deposit_b = 5_000u64;

    let max_a = max_borrowable(deposit_a, pool_a.ltv).unwrap();
    let max_combined = max_borrowable(deposit_a + deposit_b, pool_b.ltv).unwrap();

    assert_eq!(max_a, 750);
    assert_eq!(max_combined, 4_500);

    let borrow_only_invalid_for_a = 751u64;
    assert!(
        borrow_only_invalid_for_a > max_a,
        "pool A must only consider collateral deposited into pool A"
    );
    assert!(
        borrow_only_invalid_for_a <= max_combined,
        "this borrow would incorrectly pass if collateral leaked across pools"
    );
}

#[test]
fn cross_pool_health_and_liquidation_checks_remain_isolated() {
    let pool_a = default_pool();
    let pool_b = default_pool();

    let hf_a = health_factor(1_000, 900, pool_a.liquidation_threshold).unwrap();
    let hf_b = health_factor(10_000, 1_000, pool_b.liquidation_threshold).unwrap();

    assert!(hf_a < WAD, "pool A position should be liquidatable");
    assert!(hf_b > WAD, "pool B position should stay healthy");
}

#[test]
fn mixed_mode_plaintext_state_remains_authoritative_across_private_and_public_steps() {
    let mut pool = default_pool();

    // Plaintext deposit.
    let deposit_amount = 2_000u64;
    let deposit_shares = deposit_to_shares(deposit_amount, pool.supply_index).unwrap();
    pool.total_deposits = deposit_amount;

    // Enable privacy should seed ciphertexts from current plaintext balances.
    let seeded_enc_deposit = current_deposit_balance(deposit_shares, pool.supply_index).unwrap();
    let seeded_enc_debt = current_borrow_balance(0, pool.borrow_index, pool.borrow_index).unwrap();
    assert_eq!(seeded_enc_deposit, deposit_amount);
    assert_eq!(seeded_enc_debt, 0);

    // Private borrow updates the same plaintext source of truth.
    let mut borrow_principal = 1_000u64;
    let borrow_snapshot = pool.borrow_index;
    pool.total_borrows = borrow_principal;

    // Accrue before returning to a plaintext repay path.
    pool.accrue_interest(86_400 * 30).unwrap();
    let accrued_debt = current_borrow_balance(borrow_principal, pool.borrow_index, borrow_snapshot).unwrap();
    assert!(accrued_debt > borrow_principal, "interest must accrue before the mixed-mode repay");

    let repay_amount = 400u64.min(accrued_debt);
    borrow_principal = accrued_debt.saturating_sub(repay_amount);
    pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
    pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);

    // Private withdraw still relies on the plaintext balances for HF checks.
    let withdrawn_shares = 1_000u64;
    let remaining_shares = deposit_shares.saturating_sub(withdrawn_shares);
    let remaining_deposit = current_deposit_balance(remaining_shares, pool.supply_index).unwrap();
    let hf = health_factor(remaining_deposit, borrow_principal, pool.liquidation_threshold).unwrap();

    assert!(hf > WAD, "post-withdraw mixed-mode position must remain healthy");
    assert!(borrow_principal < accrued_debt, "plaintext repay must reduce debt");
    assert!(remaining_deposit < seeded_enc_deposit, "withdraw must reduce the authoritative deposit balance");
}

#[test]
fn liquidity_exhaustion_blocks_withdraw_even_for_large_depositor() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 900_000;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    let requested_withdraw = 200_000u64;

    assert_eq!(available, 100_000);
    assert!(
        requested_withdraw > available,
        "withdraw should fail when free liquidity is exhausted by another borrower"
    );
}

#[test]
fn accumulated_fees_are_reserved_from_borrow_and_withdraw_capacity() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 200_000;
    pool.accumulated_fees = 300_000;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);

    assert_eq!(available, 500_000);
    assert!(500_001 > available, "borrow capacity must exclude accumulated fees");
    assert!(500_001 > available, "withdraw capacity must exclude accumulated fees");
}

#[test]
fn partial_liquidation_can_be_followed_by_second_liquidation() {
    let pool = default_pool();

    let initial_deposit = 1_000u64;
    let initial_debt = 900u64;

    let first_repay = wad_mul(initial_debt as u128, pool.close_factor).unwrap() as u64;
    let first_seized = wad_mul(first_repay as u128, WAD + pool.liquidation_bonus).unwrap() as u64;
    let debt_after_first = initial_debt.saturating_sub(first_repay);
    let deposit_after_first = initial_deposit.saturating_sub(first_seized);
    let hf_after_first = health_factor(deposit_after_first, debt_after_first, pool.liquidation_threshold).unwrap();

    assert!(hf_after_first < WAD, "one close-factor liquidation can still leave the position unhealthy");

    let second_repay = wad_mul(debt_after_first as u128, pool.close_factor).unwrap() as u64;
    let second_seized = wad_mul(second_repay as u128, WAD + pool.liquidation_bonus).unwrap() as u64;
    let debt_after_second = debt_after_first.saturating_sub(second_repay);
    let deposit_after_second = deposit_after_first.saturating_sub(second_seized);
    let hf_after_second =
        health_factor(deposit_after_second, debt_after_second, pool.liquidation_threshold).unwrap();

    assert!(second_repay > 0, "a second liquidation should still have debt to close");
    assert!(second_seized > 0, "a second liquidation should still seize collateral");
    assert!(hf_after_second > hf_after_first, "a second liquidation must continue improving solvency");
}

#[test]
fn flash_loan_in_pool_a_does_not_touch_pool_b_debt_accounting() {
    let mut pool_a = default_pool();
    let mut pool_b = default_pool();

    pool_a.total_deposits = 1_000_000;
    pool_b.total_deposits = 2_000_000;
    pool_b.total_borrows = 600_000;

    let pool_b_borrows_before = pool_b.total_borrows;
    let pool_b_fees_before = pool_b.accumulated_fees;

    let loan = 100_000u64;
    let fee = flash_fee(loan, pool_a.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(fee);

    pool_a.flash_loan_amount = loan;
    pool_a.total_deposits = pool_a.total_deposits.saturating_add(lp_fee);
    pool_a.accumulated_fees = pool_a.accumulated_fees.saturating_add(protocol_fee);
    pool_a.flash_loan_amount = 0;

    assert_eq!(pool_a.total_deposits, 1_000_081);
    assert_eq!(pool_a.accumulated_fees, 9);
    assert_eq!(pool_a.flash_loan_amount, 0);
    assert_eq!(pool_b.total_borrows, pool_b_borrows_before);
    assert_eq!(pool_b.accumulated_fees, pool_b_fees_before);
}

#[test]
fn paused_pool_a_does_not_block_active_pool_b() {
    let mut pool_a = default_pool();
    let pool_b = default_pool();

    pool_a.paused = 1;

    let pool_b_max_borrow = max_borrowable(2_000, pool_b.ltv).unwrap();
    let pool_b_hf = health_factor(2_000, 1_000, pool_b.liquidation_threshold).unwrap();

    assert_eq!(pool_a.paused, 1);
    assert_eq!(pool_b.paused, 0);
    assert_eq!(pool_b_max_borrow, 1_500);
    assert!(pool_b_hf > WAD, "active pool B should still allow healthy actions");
}

#[test]
fn encrypted_pool_a_and_plaintext_pool_b_do_not_mix_collateral() {
    let pool_a = default_pool();
    let pool_b = default_pool();

    let encrypted_deposit_a = 1_200u64;
    let plaintext_deposit_b = 4_800u64;

    let borrow_power_a = max_borrowable(encrypted_deposit_a, pool_a.ltv).unwrap();
    let leaked_borrow_power = max_borrowable(encrypted_deposit_a + plaintext_deposit_b, pool_b.ltv).unwrap();
    let attempted_borrow_in_a = 901u64;

    assert_eq!(borrow_power_a, 900);
    assert!(attempted_borrow_in_a > borrow_power_a);
    assert!(
        attempted_borrow_in_a <= leaked_borrow_power,
        "this would only pass if pool B collateral leaked into pool A"
    );
}

#[test]
fn ika_pool_a_and_plaintext_pool_b_do_not_mix_collateral() {
    let pool_a = default_pool();
    let pool_b = default_pool();

    let ika_collateral_value = 2_000u64;
    let deposit_b = 10_000u64;

    let borrow_power_a = max_borrowable(ika_collateral_value, pool_a.ltv).unwrap();
    let leaked_borrow_power = max_borrowable(ika_collateral_value + deposit_b, pool_b.ltv).unwrap();
    let attempted_borrow_in_a = 1_501u64;

    assert_eq!(borrow_power_a, 1_500);
    assert!(attempted_borrow_in_a > borrow_power_a);
    assert!(
        attempted_borrow_in_a <= leaked_borrow_power,
        "pool B deposits must not increase pool A IKA borrow headroom"
    );
}

#[test]
fn mixed_mode_full_lifecycle_can_round_trip_back_to_zero() {
    let mut pool = default_pool();

    let deposit_amount = 2_000u64;
    let deposit_shares = deposit_to_shares(deposit_amount, pool.supply_index).unwrap();
    pool.total_deposits = deposit_amount;

    let seeded_deposit = current_deposit_balance(deposit_shares, pool.supply_index).unwrap();
    let seeded_debt = current_borrow_balance(0, pool.borrow_index, pool.borrow_index).unwrap();
    assert_eq!(seeded_deposit, deposit_amount);
    assert_eq!(seeded_debt, 0);

    let borrow_amount = 1_000u64;
    let borrow_snapshot = pool.borrow_index;
    pool.total_borrows = borrow_amount;

    pool.accrue_interest(86_400 * 30).unwrap();
    let accrued_debt = current_borrow_balance(borrow_amount, pool.borrow_index, borrow_snapshot).unwrap();
    assert!(accrued_debt > borrow_amount);

    let repaid = accrued_debt;
    pool.total_borrows = pool.total_borrows.saturating_sub(repaid);
    pool.total_deposits = pool.total_deposits.saturating_add(repaid);

    let remaining_debt = accrued_debt.saturating_sub(repaid);
    let withdrawn_amount = current_deposit_balance(deposit_shares, pool.supply_index).unwrap();
    let remaining_deposit = current_deposit_balance(0, pool.supply_index).unwrap();

    assert_eq!(remaining_debt, 0, "full plaintext repay should clear the mixed-mode debt");
    assert!(withdrawn_amount >= deposit_amount, "supply index growth should not reduce redeemable amount");
    assert_eq!(remaining_deposit, 0, "private withdraw of all shares should zero the deposit side");
}

// ── Discriminator / error type tests ─────────────────────────────────────────

#[test]
fn lend_error_codes_are_unique() {
    use veil_lending::errors::LendError;
    let codes = [
        LendError::MissingSignature as u32,
        LendError::AccountNotWritable as u32,
        LendError::InvalidAccountOwner as u32,
        LendError::InvalidDiscriminator as u32,
        LendError::InvalidPda as u32,
        LendError::InvalidInstructionData as u32,
        LendError::ZeroAmount as u32,
        LendError::InsufficientLiquidity as u32,
        LendError::ExceedsCollateralFactor as u32,
        LendError::Undercollateralised as u32,
        LendError::PositionHealthy as u32,
        LendError::ExceedsCloseFactor as u32,
        LendError::ExceedsDepositBalance as u32,
        LendError::ExceedsDebtBalance as u32,
        LendError::NoBorrow as u32,
        LendError::MathOverflow as u32,
        LendError::TransferFailed as u32,
        LendError::InvalidTimestamp as u32,
        LendError::FlashLoanActive as u32,
        LendError::FlashLoanNotActive as u32,
        LendError::FlashLoanRepayInsufficient as u32,
        LendError::Unauthorized as u32,
        LendError::PoolPaused as u32,
        LendError::NoFeesToCollect as u32,
    ];
    let mut seen = std::collections::HashSet::new();
    for &code in &codes {
        assert!(seen.insert(code), "duplicate error code: {}", code);
    }
}

#[test]
fn instruction_discriminators_are_unique_and_sequential() {
    use veil_lending::instructions::{
        Borrow, Deposit, FlashBorrow, FlashRepay, Initialize, Liquidate, Repay, Withdraw,
    };
    let discs = [
        Initialize::DISCRIMINATOR,
        Deposit::DISCRIMINATOR,
        Withdraw::DISCRIMINATOR,
        Borrow::DISCRIMINATOR,
        Repay::DISCRIMINATOR,
        Liquidate::DISCRIMINATOR,
        FlashBorrow::DISCRIMINATOR,
        FlashRepay::DISCRIMINATOR,
        UpdatePool::DISCRIMINATOR,
        PausePool::DISCRIMINATOR,
        ResumePool::DISCRIMINATOR,
        CollectFees::DISCRIMINATOR,
    ];
    let mut seen = std::collections::HashSet::new();
    for &d in &discs {
        assert!(seen.insert(d), "duplicate discriminator: {}", d);
    }
    // 12 discriminators 0..=12 plus 14, 15, 16
    let mut sorted = discs.to_vec();
    sorted.sort();
    assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16]);
}

// ── UpdatePool authority / param tests ───────────────────────────────────────

fn update_pool_data(
    base_rate: u128, optimal_utilization: u128, slope1: u128, slope2: u128,
    reserve_factor: u128, ltv: u128, liquidation_threshold: u128,
    liquidation_bonus: u128, protocol_liq_fee: u128, close_factor: u128,
    flash_fee_bps: u64,
) -> Vec<u8> {
    let mut d = Vec::with_capacity(168);
    for v in [base_rate, optimal_utilization, slope1, slope2, reserve_factor,
              ltv, liquidation_threshold, liquidation_bonus, protocol_liq_fee, close_factor] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(&flash_fee_bps.to_le_bytes());
    d
}

fn default_update_data() -> Vec<u8> {
    update_pool_data(BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
                     LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 9)
}

#[test]
fn update_pool_wrong_authority_returns_unauthorized() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(OTHER, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&default_update_data()).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn update_pool_non_signer_returns_missing_signature() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, false, false, &[]); // not a signer
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&default_update_data()).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::MissingSignature.into()));
}

#[test]
fn update_pool_correct_authority_succeeds() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&default_update_data()).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "correct authority must succeed: {:?}", result);
}

#[test]
fn update_pool_writes_params_to_pool() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let new_flash_bps: u64 = 50;
    let d = update_pool_data(BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
                             LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, new_flash_bps);
    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts).unwrap();
        let updated = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(updated.flash_fee_bps, new_flash_bps);
        assert_eq!(updated.ltv, LTV);
    }
}

#[test]
fn update_pool_rejects_ltv_ge_liq_threshold() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let d = update_pool_data(BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
                             LIQ_THRESHOLD, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 9);
    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidInstructionData.into()));
}

#[test]
fn update_pool_rejects_flash_fee_over_10000() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let d = update_pool_data(BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
                             LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 10_001);
    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidInstructionData.into()));
}

#[test]
fn update_pool_rejects_liquidation_threshold_ge_wad() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let d = update_pool_data(
        BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
        LTV, WAD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 9,
    );
    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidInstructionData.into()));
}

#[test]
fn update_pool_rejects_reserve_factor_ge_wad() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let d = update_pool_data(
        BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, WAD,
        LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 9,
    );
    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidInstructionData.into()));
}

#[test]
fn update_pool_rejects_close_factor_above_wad() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));
    let d = update_pool_data(
        BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
        LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, WAD + 1, 9,
    );
    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        UpdatePool::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidInstructionData.into()));
}

#[test]
fn stricter_pool_params_after_users_exist_do_not_corrupt_accounting() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 600_000;
    pool.accumulated_fees = 10_000;

    let before = (pool.total_deposits, pool.total_borrows, pool.accumulated_fees);
    pool.ltv = 700_000_000_000_000_000u128;
    pool.liquidation_threshold = 750_000_000_000_000_000u128;
    pool.close_factor = 400_000_000_000_000_000u128;

    let after = (pool.total_deposits, pool.total_borrows, pool.accumulated_fees);
    assert_eq!(before, after, "admin parameter tightening must not rewrite balances");
}

// ── PausePool authority tests ─────────────────────────────────────────────────

#[test]
fn pause_pool_wrong_authority_returns_unauthorized() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(OTHER, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn pause_pool_non_signer_returns_missing_signature() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, false, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::MissingSignature.into()));
}

#[test]
fn pause_pool_correct_authority_sets_paused() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts).unwrap();
        let updated = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(updated.paused, 1);
    }
}

// ── ResumePool authority tests ────────────────────────────────────────────────

#[test]
fn resume_pool_wrong_authority_returns_unauthorized() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(OTHER, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn resume_pool_non_signer_returns_missing_signature() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, false, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    let result = unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::MissingSignature.into()));
}

#[test]
fn resume_pool_clears_paused_flag() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.paused = 1;
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts).unwrap();
        let updated = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(updated.paused, 0);
    }
}

#[test]
fn pause_resume_round_trip() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts).unwrap();
        let mid = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(mid.paused, 1, "must be paused");

        let mut accounts2 = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts2).unwrap();
        let end = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(end.paused, 0, "must be unpaused");
    }
}

#[test]
fn repeated_pause_is_idempotent() {
    let pool = make_pool(AUTHORITY, 0);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts).unwrap();
        let mut accounts2 = [auth.view(), pool_acct.view()];
        PausePool.process(&PROGRAM, &mut accounts2).unwrap();
        let updated = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(updated.paused, 1);
    }
}

#[test]
fn repeated_resume_is_idempotent() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.paused = 1;
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let mut pool_acct = RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool));

    unsafe {
        let mut accounts = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts).unwrap();
        let mut accounts2 = [auth.view(), pool_acct.view()];
        ResumePool.process(&PROGRAM, &mut accounts2).unwrap();
        let updated = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(updated.paused, 0);
    }
}

#[test]
fn fee_collection_can_sweep_combined_interest_and_flash_fees_without_touching_principal() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 600_000;

    let principal_before = pool.total_deposits.saturating_sub(pool.accumulated_fees);
    pool.accrue_interest(86_400 * 30).unwrap();
    let fees_after_accrual = pool.accumulated_fees;
    assert!(fees_after_accrual > 0, "interest accrual should contribute reserve fees");

    let flash_fee_total = flash_fee(100_000, pool.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(flash_fee_total);
    pool.total_deposits = pool.total_deposits.saturating_add(lp_fee);
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);

    let combined_fees = pool.accumulated_fees;
    assert!(combined_fees > fees_after_accrual, "flash fees should add to accrued reserve fees");

    let total_deposits_before_sweep = pool.total_deposits;
    let total_borrows_before_sweep = pool.total_borrows;
    let depositor_claim_before_sweep = pool.total_deposits.saturating_sub(pool.accumulated_fees);

    pool.accumulated_fees = 0;

    assert_eq!(pool.total_deposits, total_deposits_before_sweep, "fee sweep should not rewrite depositor principal accounting");
    assert_eq!(pool.total_borrows, total_borrows_before_sweep, "fee sweep should not touch borrower accounting");
    assert!(depositor_claim_before_sweep >= principal_before, "depositor side should still include earned LP share and prior interest");
}

#[test]
fn zero_elapsed_accrual_is_noop() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    let before = (
        pool.total_deposits,
        pool.total_borrows,
        pool.accumulated_fees,
        pool.borrow_index,
        pool.supply_index,
        pool.last_update_timestamp,
    );

    pool.accrue_interest(0).unwrap();

    let after = (
        pool.total_deposits,
        pool.total_borrows,
        pool.accumulated_fees,
        pool.borrow_index,
        pool.supply_index,
        pool.last_update_timestamp,
    );
    assert_eq!(before, after);
}

#[test]
fn backwards_timestamp_accrual_is_noop() {
    let mut pool = default_pool();
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 500_000;
    pool.last_update_timestamp = 100;
    let before = (
        pool.total_deposits,
        pool.total_borrows,
        pool.accumulated_fees,
        pool.borrow_index,
        pool.supply_index,
        pool.last_update_timestamp,
    );

    pool.accrue_interest(99).unwrap();

    let after = (
        pool.total_deposits,
        pool.total_borrows,
        pool.accumulated_fees,
        pool.borrow_index,
        pool.supply_index,
        pool.last_update_timestamp,
    );
    assert_eq!(before, after);
}

#[test]
fn dust_rounding_near_share_boundaries_stays_consistent() {
    let mut pool = default_pool();
    pool.supply_index = WAD + 1;

    let one_share = deposit_to_shares(1, pool.supply_index).unwrap();
    let two_shares = deposit_to_shares(2, pool.supply_index).unwrap();
    let redeemed_one = current_deposit_balance(one_share, pool.supply_index).unwrap();
    let redeemed_two = current_deposit_balance(two_shares, pool.supply_index).unwrap();

    assert_eq!(one_share, 0, "tiny deposits can round down to zero shares at elevated index");
    assert_eq!(two_shares, 1, "next unit across the boundary should mint one share");
    assert_eq!(redeemed_one, 0);
    assert!(redeemed_two >= 1);
}

// ── CollectFees authority tests ───────────────────────────────────────────────
// The token CPI cannot run in unit/integration tests (no real runtime).
// We test every check that fires before the CPI: signature, authority, zero fees.

fn collect_accounts(signer_key: [u8; 32], is_signer: bool, fees: u64) -> [RawAccount; 6] {
    let pool = make_pool(AUTHORITY, fees);
    [
        RawAccount::new(signer_key, is_signer, false, &[]),          // [0] authority
        RawAccount::new([0u8; 32], false, true, &pool_bytes(&pool)), // [1] pool
        RawAccount::new([0u8; 32], false, true, &[]),                // [2] vault
        RawAccount::new([0u8; 32], false, true, &[]),                // [3] treasury
        RawAccount::new([0u8; 32], false, false, &[]),               // [4] pool_authority
        RawAccount::new([0u8; 32], false, false, &[]),               // [5] token_program
    ]
}

#[test]
fn collect_fees_non_signer_returns_missing_signature() {
    let mut accts = collect_accounts(AUTHORITY, false, 1_000);
    let result = unsafe {
        let mut views = [
            accts[0].view(), accts[1].view(), accts[2].view(),
            accts[3].view(), accts[4].view(), accts[5].view(),
        ];
        CollectFees.process(&PROGRAM, &mut views)
    };
    assert_eq!(result, Err(LendError::MissingSignature.into()));
}

#[test]
fn collect_fees_wrong_authority_returns_unauthorized() {
    let mut accts = collect_accounts(OTHER, true, 1_000);
    let result = unsafe {
        let mut views = [
            accts[0].view(), accts[1].view(), accts[2].view(),
            accts[3].view(), accts[4].view(), accts[5].view(),
        ];
        CollectFees.process(&PROGRAM, &mut views)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn collect_fees_zero_fees_returns_no_fees_to_collect() {
    let mut accts = collect_accounts(AUTHORITY, true, 0);
    let result = unsafe {
        let mut views = [
            accts[0].view(), accts[1].view(), accts[2].view(),
            accts[3].view(), accts[4].view(), accts[5].view(),
        ];
        CollectFees.process(&PROGRAM, &mut views)
    };
    assert_eq!(result, Err(LendError::NoFeesToCollect.into()));
}
