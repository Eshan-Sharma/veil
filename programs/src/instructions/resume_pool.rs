/*!
Resume a paused lending pool — re-enables Deposit, Borrow, and FlashBorrow.
Only the pool authority may call this.

Accounts:
  [0]  authority  signer
  [1]  pool       writable

Instruction data (after discriminator 0x0F): none
*/

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use crate::{errors::LendError, state::LendingPool};

pub struct ResumePool;

impl ResumePool {
    pub const DISCRIMINATOR: u8 = 15;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Self)
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        let pool = LendingPool::from_account_mut(&accounts[1])?;
        if pool.authority != *accounts[0].address() {
            return Err(LendError::Unauthorized.into());
        }

        pool.paused = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_accepts_empty() {
        assert!(ResumePool::from_data(&[]).is_ok());
    }

    #[test]
    fn from_data_ignores_extra_bytes() {
        assert!(ResumePool::from_data(&[0x00]).is_ok());
    }

    #[test]
    fn discriminator_is_15() {
        assert_eq!(ResumePool::DISCRIMINATOR, 15);
    }
}
