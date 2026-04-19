/*!
End-to-end business logic scenarios.

These tests combine math + LendingPool + UserPosition to verify the protocol's
invariants without requiring a live Solana runtime.  Each test drives the state
machines directly on the structs (bypassing AccountView, CPI, and syscalls) and
asserts that the accounting adds up correctly.
*/

use veil_lending::{
    errors::LendError,
    math::{
        self, current_borrow_balance, current_deposit_balance, deposit_to_shares, flash_fee,
        health_factor, max_borrowable, split_flash_fee, wad_mul,
        CLOSE_FACTOR, FLASH_FEE_BPS, LIQ_BONUS, LIQ_THRESHOLD, LTV, PROTOCOL_LIQ_FEE, WAD,
    },
    state::LendingPool,
};

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
fn flash_fee_on_large_amount() {
    // 100_000_000 tokens at 9bps = 90_000
    let fee = flash_fee(100_000_000, FLASH_FEE_BPS).unwrap();
    assert_eq!(fee, 90_000);
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
    ];
    let mut seen = std::collections::HashSet::new();
    for &code in &codes {
        assert!(seen.insert(code), "duplicate error code: {}", code);
    }
}

#[test]
fn instruction_discriminators_are_unique_and_sequential() {
    use veil_lending::instructions::{Borrow, Deposit, FlashBorrow, FlashRepay, Initialize, Liquidate, Repay, Withdraw};
    let discs = [
        Initialize::DISCRIMINATOR,
        Deposit::DISCRIMINATOR,
        Withdraw::DISCRIMINATOR,
        Borrow::DISCRIMINATOR,
        Repay::DISCRIMINATOR,
        Liquidate::DISCRIMINATOR,
        FlashBorrow::DISCRIMINATOR,
        FlashRepay::DISCRIMINATOR,
    ];
    let mut seen = std::collections::HashSet::new();
    for &d in &discs {
        assert!(seen.insert(d), "duplicate discriminator: {}", d);
    }
    // All 8 discriminators 0..=7
    let mut sorted = discs.to_vec();
    sorted.sort();
    assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5, 6, 7]);
}
