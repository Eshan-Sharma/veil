/*!
MockOracle — Set oracle price/expo directly on a pool for testing.
ONLY FOR TESTING/SHOWCASE.

Accounts:
  [0] authority   signer
  [1] pool        writable

Instruction data (after discriminator 0xFD):
  price: i64 LE
  expo:  i32 LE
*/

#![cfg(feature = "testing")]

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};
use crate::errors::LendError;
use crate::state::LendingPool;

pub struct MockOracle {
    pub price: i64,
    pub expo: i32,
}

impl MockOracle {
    pub const DISCRIMINATOR: u8 = 0xFD; // 253

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 12 {
            return Err(LendError::InvalidInstructionData.into());
        }
        let price = i64::from_le_bytes(data[..8].try_into().unwrap());
        let expo = i32::from_le_bytes(data[8..12].try_into().unwrap());
        Ok(Self { price, expo })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        let pool = LendingPool::from_account_mut(&accounts[1])?;
        // Set a non-zero feed address so cross-borrow doesn't reject OracleNotAnchored
        if pool.pyth_price_feed == [0u8; 32].into() {
            pool.pyth_price_feed = [1u8; 32].into();
        }
        pool.oracle_price = self.price;
        pool.oracle_expo = self.expo;
        pool.oracle_conf = 0;
        Ok(())
    }
}
