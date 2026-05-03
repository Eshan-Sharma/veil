//! Tests for `crate::instructions::liquidate`.

use crate::errors::LendError;
use crate::instructions::liquidate::{
    apply_liquidation_to_pool, apply_liquidation_to_position, compute_liquidation_terms,
};
use crate::math::{CLOSE_FACTOR, LIQ_BONUS, LIQ_THRESHOLD, PROTOCOL_LIQ_FEE, WAD};
use crate::state::{LendingPool, UserPosition};

fn pool_with_defaults() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.liquidation_bonus = LIQ_BONUS;
    pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
    pool.close_factor = CLOSE_FACTOR;
    pool.authority_bump = 7;
    pool
}

fn position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.deposit_shares = deposit_shares;
    pos.borrow_principal = borrow_principal;
    pos.borrow_index_snapshot = WAD;
    pos.deposit_index_snapshot = WAD;
    pos
}

#[test]
fn liquidate_terms_reject_no_borrow() {
    let pool = pool_with_defaults();
    let pos = position(1_000, 0);
    assert_eq!(compute_liquidation_terms(&pool, &pos), Err(LendError::NoBorrow.into()));
}

#[test]
fn liquidate_terms_reject_healthy_position() {
    let pool = pool_with_defaults();
    let pos = position(2_000, 1_000);
    assert_eq!(
        compute_liquidation_terms(&pool, &pos),
        Err(LendError::PositionHealthy.into())
    );
}

#[test]
fn liquidate_terms_reject_when_seizure_exceeds_deposit() {
    let mut pool = pool_with_defaults();
    pool.liquidation_bonus = WAD;
    let pos = position(400, 900);
    assert_eq!(
        compute_liquidation_terms(&pool, &pos),
        Err(LendError::InsufficientLiquidity.into())
    );
}

#[test]
fn liquidate_terms_compute_expected_amounts() {
    let pool = pool_with_defaults();
    let pos = position(1_000, 900);
    let (repay_amount, liquidator_gets, protocol_fee, seized_shares, authority_bump, total_debt) =
        compute_liquidation_terms(&pool, &pos).unwrap();

    assert_eq!(repay_amount, 450);
    assert_eq!(protocol_fee, 47);
    assert_eq!(liquidator_gets, 425);
    assert_eq!(seized_shares, 472);
    assert_eq!(authority_bump, 7);
    assert_eq!(total_debt, 900);
}

#[test]
fn liquidate_position_update_reduces_debt_and_collateral() {
    let mut pos = position(1_000, 900);
    apply_liquidation_to_position(&mut pos, 123, 456, 900, 450, 472);

    assert_eq!(pos.borrow_principal, 450);
    assert_eq!(pos.borrow_index_snapshot, 123);
    assert_eq!(pos.deposit_shares, 528);
    assert_eq!(pos.deposit_index_snapshot, 456);
}

#[test]
fn liquidate_pool_update_moves_totals_and_fees() {
    let mut pool = pool_with_defaults();
    pool.total_borrows = 900;
    pool.total_deposits = 1_000;
    pool.accumulated_fees = 10;

    apply_liquidation_to_pool(&mut pool, 450, 47, 425);

    assert_eq!(pool.total_borrows, 450);
    assert_eq!(pool.accumulated_fees, 57);
    assert_eq!(pool.total_deposits, 575);
}
