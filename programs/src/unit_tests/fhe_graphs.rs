//! Tests for `crate::fhe::graphs`.

use crate::fhe::graphs::*;

// ── add / sub deposit ────────────────────────────────────────────────────

#[test]
fn add_deposit_basic() {
    assert_eq!(add_deposit_plaintext(1_000, 500).unwrap(), 1_500);
}

#[test]
fn add_deposit_overflow_returns_err() {
    assert!(add_deposit_plaintext(u64::MAX, 1).is_err());
}

#[test]
fn sub_deposit_basic() {
    assert_eq!(sub_deposit_plaintext(1_000, 300), 700);
}

#[test]
fn sub_deposit_saturates_at_zero() {
    assert_eq!(sub_deposit_plaintext(100, 200), 0);
}

// ── add / sub debt ───────────────────────────────────────────────────────

#[test]
fn add_debt_basic() {
    assert_eq!(add_debt_plaintext(500, 200).unwrap(), 700);
}

#[test]
fn sub_debt_full_repay_saturates() {
    assert_eq!(sub_debt_plaintext(500, 600), 0);
}

// ── is_healthy ───────────────────────────────────────────────────────────

#[test]
fn healthy_when_no_debt() {
    assert!(is_healthy_plaintext(0, 0));
    assert!(is_healthy_plaintext(1_000, 0));
}

#[test]
fn healthy_at_exactly_threshold() {
    assert!(is_healthy_plaintext(1_000, 800));
}

#[test]
fn unhealthy_just_over_threshold() {
    assert!(!is_healthy_plaintext(1_000, 801));
}

#[test]
fn healthy_well_collateralised() {
    assert!(is_healthy_plaintext(2_000_000, 500_000));
}

#[test]
fn should_liquidate_is_inverse_of_is_healthy() {
    let cases = [(1_000, 0), (1_000, 800), (1_000, 801), (500, 1_000)];
    for (d, b) in cases {
        assert_eq!(
            should_liquidate_plaintext(d, b),
            !is_healthy_plaintext(d, b),
            "mismatch at deposit={d} debt={b}"
        );
    }
}

// ── borrow_allowed ───────────────────────────────────────────────────────

#[test]
fn max_borrow_is_75_percent() {
    assert_eq!(max_borrow_plaintext(10_000), 7_500);
}

#[test]
fn borrow_allowed_within_ltv() {
    assert!(borrow_allowed_plaintext(10_000, 0, 7_500));
}

#[test]
fn borrow_rejected_over_ltv() {
    assert!(!borrow_allowed_plaintext(10_000, 0, 7_501));
}

#[test]
fn borrow_rejected_when_existing_debt_near_max() {
    assert!(!borrow_allowed_plaintext(10_000, 7_000, 501));
}
