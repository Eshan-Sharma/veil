//! Tests for `crate::ika`.

use crate::ika::{CPI_AUTHORITY_SEED, IKA_PROGRAM_ID, IX_APPROVE_MESSAGE, IX_TRANSFER_DWALLET};

#[test]
fn ika_program_id_is_32_bytes() {
    assert_eq!(IKA_PROGRAM_ID.as_ref().len(), 32);
}

#[test]
fn cpi_authority_seed_is_correct() {
    assert_eq!(CPI_AUTHORITY_SEED, b"__ika_cpi_authority");
}

#[test]
fn ix_discriminators() {
    assert_eq!(IX_APPROVE_MESSAGE, 8);
    assert_eq!(IX_TRANSFER_DWALLET, 24);
}
