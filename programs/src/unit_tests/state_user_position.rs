//! Tests for `crate::state::user_position`.

use crate::math::WAD;
use crate::state::UserPosition;

fn default_position() -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.deposit_index_snapshot = WAD;
    pos.borrow_index_snapshot = WAD;
    pos
}

#[test]
fn size_matches_layout() {
    assert_eq!(core::mem::size_of::<UserPosition>(), UserPosition::SIZE);
}

#[test]
fn discriminator_is_correct() {
    assert_eq!(UserPosition::DISCRIMINATOR, *b"VEILPOS!");
}

#[test]
fn default_position_zero_shares_and_debt() {
    let pos = default_position();
    assert_eq!(pos.deposit_shares, 0);
    assert_eq!(pos.borrow_principal, 0);
}

#[test]
fn default_position_index_snapshots_at_wad() {
    let pos = default_position();
    assert_eq!(pos.deposit_index_snapshot, WAD);
    assert_eq!(pos.borrow_index_snapshot, WAD);
}

#[test]
fn deposit_shares_accumulate() {
    let mut pos = default_position();
    pos.deposit_shares = pos.deposit_shares.saturating_add(1_000);
    pos.deposit_shares = pos.deposit_shares.saturating_add(2_000);
    assert_eq!(pos.deposit_shares, 3_000);
}

#[test]
fn borrow_principal_can_be_updated() {
    let mut pos = default_position();
    pos.borrow_principal = 500_000;
    assert_eq!(pos.borrow_principal, 500_000);
}

#[test]
fn deposit_shares_saturating_sub_no_underflow() {
    let mut pos = default_position();
    pos.deposit_shares = 100;
    pos.deposit_shares = pos.deposit_shares.saturating_sub(200);
    assert_eq!(pos.deposit_shares, 0, "saturating_sub must not underflow");
}

#[test]
fn borrow_principal_repay_to_zero() {
    let mut pos = default_position();
    pos.borrow_principal = 1_000;
    let debt = pos.borrow_principal;
    pos.borrow_principal = debt.saturating_sub(debt); // full repay
    assert_eq!(pos.borrow_principal, 0);
}
