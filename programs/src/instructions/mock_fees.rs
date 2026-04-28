/*!
MockFees — Inject dummy fees into a pool for testing.
ONLY FOR TESTING/SHOWCASE.
*/

#![cfg(feature = "testing")]

use pinocchio::{account::AccountView, Address, ProgramResult};
use crate::errors::LendError;
use crate::state::LendingPool;
use super::mock_oracle::enforce_mock_admin;

pub struct MockFees;

impl MockFees {
    pub const DISCRIMINATOR: u8 = 0xFE; // 254

    pub fn process(_program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        // Hardcoded-admin check, even when `--features testing` is on. See
        // `mock_oracle::MOCK_ADMIN` for rationale.
        enforce_mock_admin(&accounts[0])?;
        let pool = LendingPool::from_account_mut(&accounts[1])?;
        pool.accumulated_fees = pool.accumulated_fees.saturating_add(100_000_000);
        Ok(())
    }
}
