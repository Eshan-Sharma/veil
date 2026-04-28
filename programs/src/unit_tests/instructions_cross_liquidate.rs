//! Tests for `crate::instructions::cross_liquidate`.

use crate::errors::LendError;
use crate::instructions::cross_liquidate::compute_cross_liquidation_terms;
use crate::math::{CLOSE_FACTOR, LIQ_BONUS, LIQ_THRESHOLD, PROTOCOL_LIQ_FEE, WAD};
use crate::state::{LendingPool, UserPosition};

fn make_pool(oracle_price: i64, oracle_expo: i32, token_decimals: u8) -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.ltv = crate::math::LTV;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.liquidation_bonus = LIQ_BONUS;
    pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
    pool.close_factor = CLOSE_FACTOR;
    pool.authority_bump = 7;
    pool.pyth_price_feed = [1u8; 32].into();
    pool.oracle_price = oracle_price;
    pool.oracle_expo = oracle_expo;
    pool.token_decimals = token_decimals;
    pool
}

fn position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.deposit_shares = deposit_shares;
    pos.borrow_principal = borrow_principal;
    pos.deposit_index_snapshot = WAD;
    pos.borrow_index_snapshot = WAD;
    pos
}

#[test]
fn cross_liq_rejects_no_borrow() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);
    let debt_pos = position(0, 0);
    let coll_pos = position(1_000_000_000, 0);

    assert_eq!(
        compute_cross_liquidation_terms(
            &debt_pool, &debt_pos, &coll_pool, &coll_pos, 100,
            100 * WAD, 50 * WAD,
        ),
        Err(LendError::NoBorrow.into())
    );
}

#[test]
fn cross_liq_rejects_healthy_position() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);
    let debt_pos = position(0, 500_000);
    let coll_pos = position(1_000_000_000, 0);

    assert_eq!(
        compute_cross_liquidation_terms(
            &debt_pool, &debt_pos, &coll_pool, &coll_pos, 100,
            120 * WAD, WAD / 2,
        ),
        Err(LendError::PositionHealthy.into())
    );
}

#[test]
fn cross_liq_computes_correct_seizure() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);

    let debt_pos = position(0, 10_000_000);
    let coll_pos = position(1_000_000_000, 0);

    let global_coll = WAD * 80 / 100;
    let global_debt = WAD;

    let result = compute_cross_liquidation_terms(
        &debt_pool, &debt_pos, &coll_pool, &coll_pos, 10_000_000,
        global_coll, global_debt,
    );
    assert!(result.is_ok());

    let (repay, liquidator_gets, protocol_fee, seized_shares) = result.unwrap();
    assert_eq!(repay, 5_000_000);
    assert_eq!(protocol_fee, 3_500_000);
    assert_eq!(liquidator_gets, 31_500_000);
    assert_eq!(seized_shares, 35_000_000);
}

#[test]
fn cross_liq_caps_at_close_factor() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);
    let debt_pos = position(0, 10_000_000);
    let coll_pos = position(1_000_000_000, 0);

    let global_coll = WAD * 80 / 100;
    let global_debt = WAD;

    let (repay, _, _, _) = compute_cross_liquidation_terms(
        &debt_pool, &debt_pos, &coll_pool, &coll_pos, 10_000_000,
        global_coll, global_debt,
    ).unwrap();

    assert_eq!(repay, 5_000_000, "should be capped at 50% close factor");
}

#[test]
fn cross_liq_rejects_insufficient_collateral() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);

    let debt_pos = position(0, 100_000_000);
    let coll_pos = position(1_000, 0);

    let global_coll = WAD / 1000;
    let global_debt = 100 * WAD;

    let result = compute_cross_liquidation_terms(
        &debt_pool, &debt_pos, &coll_pool, &coll_pos, 50_000_000,
        global_coll, global_debt,
    );
    assert_eq!(result, Err(LendError::InsufficientLiquidity.into()));
}

#[test]
fn cross_liq_small_amounts() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(100_000_000, -8, 6);

    let debt_pos = position(0, 2_000_000);
    let coll_pos = position(10_000_000, 0);

    let global_coll = WAD * 8 / 10;
    let global_debt = WAD;

    let (repay, liquidator_gets, protocol_fee, _) = compute_cross_liquidation_terms(
        &debt_pool, &debt_pos, &coll_pool, &coll_pos, 2_000_000,
        global_coll, global_debt,
    ).unwrap();

    assert_eq!(repay, 1_000_000);
    assert_eq!(protocol_fee, 105_000);
    assert_eq!(liquidator_gets, 945_000);
}

#[test]
fn cross_liq_zero_repay_caps_to_zero() {
    let debt_pool = make_pool(100_000_000, -8, 6);
    let coll_pool = make_pool(15_000_000_000, -8, 9);
    let debt_pos = position(0, 10_000_000);
    let coll_pos = position(1_000_000_000, 0);

    let global_coll = WAD * 80 / 100;
    let global_debt = WAD;

    let (repay, _, _, _) = compute_cross_liquidation_terms(
        &debt_pool, &debt_pos, &coll_pool, &coll_pos, 0,
        global_coll, global_debt,
    ).unwrap();
    assert_eq!(repay, 0);
}
