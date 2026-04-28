//! Tests for `crate::instructions::withdraw`.

use crate::errors::LendError;
use crate::instructions::withdraw::{
    apply_withdrawal_to_pool, apply_withdrawal_to_position, compute_withdrawal_terms,
};
use crate::math::{LIQ_THRESHOLD, WAD};
use crate::state::{LendingPool, UserPosition};

fn pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.authority_bump = 5;
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
fn withdraw_terms_reject_excess_shares() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    assert_eq!(
        compute_withdrawal_terms(&pool, &position(100, 0), 101),
        Err(LendError::ExceedsDepositBalance.into())
    );
}

#[test]
fn withdraw_terms_reject_insufficient_liquidity() {
    let mut pool = pool();
    pool.total_deposits = 500;
    pool.total_borrows = 100;
    pool.accumulated_fees = 50;
    assert_eq!(
        compute_withdrawal_terms(&pool, &position(1_000, 0), 600),
        Err(LendError::InsufficientLiquidity.into())
    );
}

#[test]
fn withdraw_terms_reject_undercollateralised() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    assert_eq!(
        compute_withdrawal_terms(&pool, &position(1_250, 1_000), 1),
        Err(LendError::Undercollateralised.into())
    );
}

#[test]
fn withdraw_terms_return_token_amount_and_bump() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    assert_eq!(
        compute_withdrawal_terms(&pool, &position(1_000, 0), 500),
        Ok((500, 5))
    );
}

#[test]
fn withdraw_apply_position_updates_shares_and_snapshot() {
    let mut pos = position(1_000, 0);
    apply_withdrawal_to_position(&mut pos, 500, 123);
    assert_eq!(pos.deposit_shares, 500);
    assert_eq!(pos.deposit_index_snapshot, 123);
}

#[test]
fn withdraw_apply_pool_reduces_total_deposits() {
    let mut pool = pool();
    pool.total_deposits = 1_000;
    apply_withdrawal_to_pool(&mut pool, 500);
    assert_eq!(pool.total_deposits, 500);
}
