//! Tests for `crate::instructions::cross_withdraw`.

use crate::errors::LendError;
use crate::instructions::cross_withdraw::validate_cross_withdraw;
use crate::math::{LIQ_THRESHOLD, WAD};
use crate::state::{LendingPool, UserPosition};

fn pool(total_deposits: u64) -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.authority_bump = 5;
    pool.total_deposits = total_deposits;
    pool.pyth_price_feed = [1u8; 32].into();
    pool.oracle_price = 100_000_000;
    pool.oracle_expo = -8;
    pool.token_decimals = 6;
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
fn cross_withdraw_rejects_excess_shares() {
    let p = pool(10_000_000);
    assert_eq!(
        validate_cross_withdraw(&p, &position(100, 0), 101),
        Err(LendError::ExceedsDepositBalance.into())
    );
}

#[test]
fn cross_withdraw_rejects_insufficient_liquidity() {
    let mut p = pool(500_000);
    p.total_borrows = 100_000;
    p.accumulated_fees = 50_000;
    assert_eq!(
        validate_cross_withdraw(&p, &position(1_000_000, 0), 600_000),
        Err(LendError::InsufficientLiquidity.into())
    );
}

#[test]
fn cross_withdraw_returns_token_amount_and_bump() {
    let p = pool(10_000_000);
    assert_eq!(
        validate_cross_withdraw(&p, &position(1_000, 0), 500),
        Ok((500, 5))
    );
}

#[test]
fn cross_withdraw_all_shares_no_debt() {
    let p = pool(10_000_000);
    let result = validate_cross_withdraw(&p, &position(5_000, 0), 5_000);
    assert!(result.is_ok());
    let (amount, bump) = result.unwrap();
    assert_eq!(amount, 5_000);
    assert_eq!(bump, 5);
}

#[test]
fn cross_withdraw_one_over_deposit() {
    let p = pool(10_000_000);
    assert_eq!(
        validate_cross_withdraw(&p, &position(1_000, 0), 1_001),
        Err(LendError::ExceedsDepositBalance.into())
    );
}

#[test]
fn cross_withdraw_zero_available() {
    let mut p = pool(1_000);
    p.total_borrows = 1_000;
    assert_eq!(
        validate_cross_withdraw(&p, &position(1_000, 0), 1),
        Err(LendError::InsufficientLiquidity.into())
    );
}

#[test]
fn cross_withdraw_partial_with_debt_ok() {
    let p = pool(10_000);
    let result = validate_cross_withdraw(&p, &position(2_000, 0), 500);
    assert!(result.is_ok());
}
