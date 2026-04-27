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

/// Verify that `account` is owned by `program_id`.
/// Prevents attackers from passing fake accounts owned by other programs.
#[inline(always)]
pub fn check_program_owner(account: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
    if account.owner() != program_id {
        return Err(LendError::InvalidAccountOwner.into());
    }
    Ok(())
}
