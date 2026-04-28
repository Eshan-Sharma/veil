//! Tests for `crate::instructions::cross_repay`.

use crate::errors::LendError;
use crate::instructions::cross_repay::compute_repay;
use crate::math::WAD;
use crate::state::{LendingPool, UserPosition};

fn pool() -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool
}

fn position(borrow_principal: u64) -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.borrow_principal = borrow_principal;
    pos.deposit_index_snapshot = WAD;
    pos.borrow_index_snapshot = WAD;
    pos
}

#[test]
fn compute_repay_rejects_no_debt() {
    let p = pool();
    let pos = position(0);
    assert_eq!(compute_repay(&p, &pos, 100), Err(LendError::NoBorrow.into()));
}

#[test]
fn compute_repay_caps_at_total_debt() {
    let p = pool();
    let pos = position(500);
    let (repay, new_debt, _) = compute_repay(&p, &pos, 1_000).unwrap();
    assert_eq!(repay, 500);
    assert_eq!(new_debt, 0);
}

#[test]
fn compute_repay_partial() {
    let p = pool();
    let pos = position(1_000);
    let (repay, new_debt, _) = compute_repay(&p, &pos, 400).unwrap();
    assert_eq!(repay, 400);
    assert_eq!(new_debt, 600);
}

#[test]
fn compute_repay_exact() {
    let p = pool();
    let pos = position(1_000);
    let (repay, new_debt, _) = compute_repay(&p, &pos, 1_000).unwrap();
    assert_eq!(repay, 1_000);
    assert_eq!(new_debt, 0);
}

#[test]
fn compute_repay_with_accrued_interest() {
    let mut p = pool();
    p.borrow_index = WAD + WAD / 10;
    let pos = position(1_000);
    let (repay, new_debt, idx) = compute_repay(&p, &pos, 2_000).unwrap();
    assert_eq!(repay, 1_100);
    assert_eq!(new_debt, 0);
    assert_eq!(idx, WAD + WAD / 10);
}

#[test]
fn compute_repay_zero_principal_rejected() {
    let p = pool();
    let pos = position(0);
    assert_eq!(compute_repay(&p, &pos, 100), Err(LendError::NoBorrow.into()));
}

#[test]
fn compute_repay_returns_current_borrow_index() {
    let mut p = pool();
    p.borrow_index = WAD * 2;
    let pos = position(500);
    let (_, _, idx) = compute_repay(&p, &pos, 500).unwrap();
    assert_eq!(idx, WAD * 2);
}
