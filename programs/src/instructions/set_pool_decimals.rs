/*!
Admin instruction to set `token_decimals` on an existing pool.

Useful for pools created before cross-collateral support was added,
or when the mint wasn't readable at init time.

Accounts:
  [0]  authority       signer
  [1]  pool            writable
  [2]  token_mint      read-only

Instruction data (after discriminator 0x15): (none)
*/

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use crate::{
    errors::LendError,
    state::{check_program_owner, LendingPool},
};

pub struct SetPoolDecimals;

impl SetPoolDecimals {
    pub const DISCRIMINATOR: u8 = 0x15; // 21

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Self)
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 3 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        check_program_owner(&accounts[1], program_id)?;

        let pool = LendingPool::from_account(&accounts[1])?;
        if &pool.authority != accounts[0].address() {
            return Err(LendError::Unauthorized.into());
        }
        if &pool.token_mint != accounts[2].address() {
            return Err(ProgramError::InvalidAccountData);
        }

        // Read decimals from the SPL token mint (offset 44).
        if accounts[2].data_len() < 82 {
            return Err(LendError::InvalidInstructionData.into());
        }
        let mint_data = unsafe {
            core::slice::from_raw_parts(accounts[2].data_ptr(), accounts[2].data_len())
        };
        let decimals = mint_data[44];

        let pool_mut = LendingPool::from_account_mut(&accounts[1])?;
        pool_mut.token_decimals = decimals;

        Ok(())
    }
}
