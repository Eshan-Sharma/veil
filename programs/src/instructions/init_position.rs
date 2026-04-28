/*!
Create an empty UserPosition PDA without depositing.

Needed for cross-borrow: the borrow pool position must exist before
the cross_borrow instruction can write to it, but the user may not
hold the borrow token yet.

Accounts:
  [0]  user             signer, writable (pays rent)
  [1]  pool             read-only – LendingPool PDA (must exist)
  [2]  position         writable – UserPosition PDA to create
  [3]  system_program

Instruction data (after discriminator 0x1A):
  position_bump: u8
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    errors::LendError,
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct InitPosition {
    pub position_bump: u8,
}

impl InitPosition {
    pub const DISCRIMINATOR: u8 = 0x1A; // 26

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            position_bump: data[0],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 4 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // Pool must be a valid program-owned account
        check_program_owner(&accounts[1], program_id)?;
        {
            // Verify it's actually a LendingPool (checks discriminator)
            let _pool = LendingPool::from_account(&accounts[1])?;
        }

        // Position must not already exist
        if accounts[2].lamports() != 0 {
            // Already created — no-op (idempotent)
            return Ok(());
        }

        let pool_addr = *accounts[1].address();
        let user_addr = *accounts[0].address();

        // Verify PDA derivation
        let derived = Address::derive_address(
            &[b"position", pool_addr.as_ref(), user_addr.as_ref()],
            Some(self.position_bump),
            program_id,
        );
        if derived != *accounts[2].address() {
            return Err(LendError::InvalidPda.into());
        }

        let rent = Rent::get()?;
        let lamports = rent.try_minimum_balance(UserPosition::SIZE)?;

        let bump_bytes = [self.position_bump];
        let seeds: [Seed; 4] = [
            Seed::from(b"position" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(user_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        CreateAccount {
            from: &accounts[0],
            to: &accounts[2],
            lamports,
            space: UserPosition::SIZE as u64,
            owner: program_id,
        }
        .invoke_signed(&[signer])?;

        // Read current indices from pool for snapshots
        let (si, bi) = {
            let pool = LendingPool::from_account(&accounts[1])?;
            (pool.supply_index, pool.borrow_index)
        };

        UserPosition::init(
            &accounts[2],
            &user_addr,
            &pool_addr,
            self.position_bump,
            si,
            bi,
        )?;

        Ok(())
    }
}
