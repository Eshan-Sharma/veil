//! Tests for `crate::math`.

use crate::math::*;

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
