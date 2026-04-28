//! Tests for `crate::instructions::borrow`.

use crate::errors::LendError;
use crate::instructions::borrow::{apply_borrow_to_pool, apply_borrow_to_position, validate_borrow};
use crate::math::{LIQ_THRESHOLD, LTV, WAD};
use crate::state::{LendingPool, UserPosition};

fn pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.ltv = LTV;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.authority_bump = 7;
    pool.pyth_price_feed = [1u8; 32].into();
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
fn borrow_validate_rejects_paused_pool() {
    let mut pool = pool();
    pool.paused = 1;
    assert_eq!(
        validate_borrow(&pool, &position(1_000, 0), 1),
        Err(LendError::PoolPaused.into())
    );
}

#[test]
fn borrow_validate_rejects_excess_collateral_factor() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    assert_eq!(
        validate_borrow(&pool, &position(1_000, 0), 751),
        Err(LendError::ExceedsCollateralFactor.into())
    );
}

#[test]
fn borrow_validate_rejects_undercollateralised_after_borrow() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    pool.ltv = WAD;
    assert_eq!(
        validate_borrow(&pool, &position(1_000, 0), 900),
        Err(LendError::Undercollateralised.into())
    );
}

#[test]
fn borrow_validate_rejects_when_oracle_not_anchored() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    pool.pyth_price_feed = [0u8; 32].into();
    assert_eq!(
        validate_borrow(&pool, &position(1_000, 0), 100),
        Err(LendError::OracleNotAnchored.into())
    );
}

#[test]
fn borrow_validate_rejects_insufficient_liquidity() {
    let mut pool = pool();
    pool.total_deposits = 500;
    pool.total_borrows = 100;
    pool.accumulated_fees = 50;
    assert_eq!(
        validate_borrow(&pool, &position(2_000, 0), 600),
        Err(LendError::InsufficientLiquidity.into())
    );
}

#[test]
fn borrow_validate_returns_existing_debt_and_bump() {
    let mut pool = pool();
    pool.total_deposits = 10_000;
    assert_eq!(
        validate_borrow(&pool, &position(2_000, 300), 400),
        Ok((300, 7))
    );
}

#[test]
fn borrow_apply_position_updates_debt_and_snapshot() {
    let mut pos = position(2_000, 300);
    apply_borrow_to_position(&mut pos, 300, 400, 123);
    assert_eq!(pos.borrow_principal, 700);
    assert_eq!(pos.borrow_index_snapshot, 123);
}

#[test]
fn borrow_apply_pool_updates_total_borrows() {
    let mut pool = pool();
    pool.total_borrows = 300;
    apply_borrow_to_pool(&mut pool, 400);
    assert_eq!(pool.total_borrows, 700);
}
