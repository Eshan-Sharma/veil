/*!
Set the per-position cap on Ika dWallet USD value for a lending pool.

Defaults to 0 at pool init — Ika registration against this pool is rejected
until the authority explicitly opts in. Closes the "register at u64::MAX,
drain vault" attack vector identified in `docs/IKA_COLLATERAL_WIRING.md`
(gate #3).

Accounts:
  [0]  authority  signer
  [1]  pool       writable

Instruction data (after discriminator 0x1B):
  max_ika_usd_cents: u64 LE
*/

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use crate::{
    errors::LendError,
    state::{check_program_owner, LendingPool},
};

pub struct SetIkaCollateralCap {
    pub max_ika_usd_cents: u64,
}

impl SetIkaCollateralCap {
    pub const DISCRIMINATOR: u8 = 0x1B;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            max_ika_usd_cents: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        check_program_owner(&accounts[1], program_id)?;

        // Sanity bound on the cap: $100M per position is well above any
        // legitimate use and prevents an authority typo (or a bug in admin
        // tooling) from setting `u64::MAX` and re-opening the drain-vault
        // attack vector this field exists to close.
        const MAX_CAP_CENTS: u64 = 10_000_000_000; // $100M
        if self.max_ika_usd_cents > MAX_CAP_CENTS {
            return Err(LendError::ParameterOutOfBounds.into());
        }

        let pool = LendingPool::from_account_mut(&accounts[1])?;
        if pool.authority != *accounts[0].address() {
            return Err(LendError::Unauthorized.into());
        }

        pool.max_ika_usd_cents = self.max_ika_usd_cents;
        Ok(())
    }
}
