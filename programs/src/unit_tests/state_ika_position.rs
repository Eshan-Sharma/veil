//! Tests for `crate::state::ika_position`.

use crate::state::ika_position::{curve, scheme};
use crate::state::IkaDwalletPosition;

#[test]
fn size_matches_layout() {
    assert_eq!(core::mem::size_of::<IkaDwalletPosition>(), IkaDwalletPosition::SIZE);
}

#[test]
fn discriminator_is_veilika() {
    assert_eq!(IkaDwalletPosition::DISCRIMINATOR, *b"VEILIKA!");
}

#[test]
fn curve_constants_are_sequential() {
    assert_eq!(curve::SECP256K1, 0);
    assert_eq!(curve::SECP256R1, 1);
    assert_eq!(curve::CURVE25519, 2);
    assert_eq!(curve::RISTRETTO, 3);
}

#[test]
fn scheme_constants_are_sequential() {
    assert_eq!(scheme::ECDSA_KECCAK256, 0);
    assert_eq!(scheme::SCHNORRKEL_MERLIN, 6);
}
