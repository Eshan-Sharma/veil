//! Tests for `crate::instructions::collect_fees`.

use pinocchio::Address;

use crate::errors::LendError;
use crate::instructions::collect_fees::{clear_accumulated_fees, snapshot_fee_collection};
use crate::state::LendingPool;

fn pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.authority = Address::new_from_array([1u8; 32]);
    pool.authority_bump = 9;
    pool
}

#[test]
fn collect_fees_snapshot_rejects_wrong_authority() {
    let pool = pool();
    assert_eq!(
        snapshot_fee_collection(&pool, &Address::new_from_array([2u8; 32])),
        Err(LendError::Unauthorized.into())
    );
}

#[test]
fn collect_fees_snapshot_rejects_zero_fees() {
    let pool = pool();
    assert_eq!(
        snapshot_fee_collection(&pool, &Address::new_from_array([1u8; 32])),
        Err(LendError::NoFeesToCollect.into())
    );
}

#[test]
fn collect_fees_snapshot_returns_amount_and_bump() {
    let mut pool = pool();
    pool.accumulated_fees = 123;
    assert_eq!(
        snapshot_fee_collection(&pool, &Address::new_from_array([1u8; 32])),
        Ok((123, 9))
    );
}

#[test]
fn collect_fees_clear_zeroes_accumulated_fees() {
    let mut pool = pool();
    pool.accumulated_fees = 123;
    clear_accumulated_fees(&mut pool);
    assert_eq!(pool.accumulated_fees, 0);
}
