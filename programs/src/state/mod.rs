mod encrypted_position;
pub mod ika_position;
mod lending_pool;
mod user_position;

pub use encrypted_position::EncryptedPosition;
pub use ika_position::IkaDwalletPosition;
pub use lending_pool::LendingPool;
pub use user_position::UserPosition;

use pinocchio::{account::AccountView, error::ProgramError, Address};
use crate::errors::LendError;

/// SPL Token Program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
pub const SPL_TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
]);

/// Token-2022 Program ID (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
pub const TOKEN_2022_PROGRAM_ID: Address = Address::new_from_array([
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
]);

/// Verify that `account` is owned by `program_id`.
/// Prevents attackers from passing fake accounts owned by other programs.
#[inline(always)]
pub fn check_program_owner(account: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
    if account.owner() != program_id {
        return Err(LendError::InvalidAccountOwner.into());
    }
    Ok(())
}

/// Verify that the supplied vault account is the one anchored to the pool.
/// Without this check, a compromised frontend could redirect deposits/repays
/// to an attacker-controlled token account while the pool still records the
/// transfer.
#[inline(always)]
pub fn check_vault(vault_account: &AccountView, pool: &LendingPool) -> Result<(), ProgramError> {
    if vault_account.address() != &pool.vault {
        return Err(LendError::InvalidVault.into());
    }
    Ok(())
}

/// Verify that the supplied token program account is one of the trusted SPL
/// token program IDs (legacy SPL Token or Token-2022 Extensions). A malicious
/// program in this slot could "succeed" without moving any tokens.
#[inline(always)]
pub fn check_token_program(account: &AccountView) -> Result<(), ProgramError> {
    let addr = account.address();
    if addr == &SPL_TOKEN_PROGRAM_ID || addr == &TOKEN_2022_PROGRAM_ID {
        Ok(())
    } else {
        Err(LendError::InvalidTokenProgram.into())
    }
}
