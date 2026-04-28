//! Tests for `crate::instructions::deposit`.

use pinocchio::Address;

use crate::errors::LendError;
use crate::instructions::deposit::{
    apply_deposit_to_pool, apply_deposit_to_position, compute_deposit_shares,
    validate_existing_position, validate_new_position_pda,
};
use crate::math::WAD;
use crate::state::{LendingPool, UserPosition};

fn position() -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.owner = Address::new_from_array([1u8; 32]);
    pos.pool = Address::new_from_array([2u8; 32]);
    pos
}

#[test]
fn deposit_validate_new_position_pda_rejects_wrong_address() {
    assert_eq!(
        validate_new_position_pda(
            &Address::new_from_array([9u8; 32]),
            &Address::new_from_array([2u8; 32]),
            &Address::new_from_array([1u8; 32]),
            &Address::new_from_array([3u8; 32]),
            7,
        ),
        Err(LendError::InvalidPda.into())
    );
}

#[test]
fn deposit_validate_existing_position_checks_binding() {
    let pos = position();
    assert_eq!(
        validate_existing_position(
            &pos,
            &Address::new_from_array([1u8; 32]),
            &Address::new_from_array([2u8; 32])
        ),
        Ok(())
    );
    assert_eq!(
        validate_existing_position(
            &pos,
            &Address::new_from_array([8u8; 32]),
            &Address::new_from_array([2u8; 32])
        ),
        Err(LendError::Unauthorized.into())
    );
}

#[test]
fn deposit_compute_shares_matches_math() {
    assert_eq!(compute_deposit_shares(1_100, WAD + WAD / 10), Ok(1_000));
}

#[test]
fn deposit_apply_position_updates_shares_and_snapshot() {
    let mut pos = position();
    apply_deposit_to_position(&mut pos, 500, 123);
    assert_eq!(pos.deposit_shares, 500);
    assert_eq!(pos.deposit_index_snapshot, 123);
}

#[test]
fn deposit_apply_pool_updates_total_deposits() {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    apply_deposit_to_pool(&mut pool, 700);
    assert_eq!(pool.total_deposits, 700);
}
