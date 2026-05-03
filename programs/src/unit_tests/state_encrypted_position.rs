//! Tests for `crate::state::encrypted_position`.

use crate::state::EncryptedPosition;

#[test]
fn size_matches_layout() {
    assert_eq!(core::mem::size_of::<EncryptedPosition>(), EncryptedPosition::SIZE);
}

#[test]
fn discriminator_is_correct() {
    assert_eq!(&EncryptedPosition::DISCRIMINATOR, b"VEILENC!");
}

#[test]
fn zero_handles_report_zero() {
    let pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    assert_eq!(pos.enc_deposit, [0u8; 32]);
    assert_eq!(pos.enc_debt, [0u8; 32]);
}
