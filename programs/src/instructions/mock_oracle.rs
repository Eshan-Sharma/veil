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

/// Hardcoded admin pubkey allowed to invoke testing-only Mock* handlers.
///
/// Even when built with `--features testing`, only this exact signer can
/// rewrite oracle/fee state. The default (all zeros) is deliberately
/// unreachable — any real signer's address differs from the system program.
/// Set it to your dev wallet's pubkey-bytes before running localnet tests.
///
/// This second wall is what the audit calls for: a CI mistake that ships a
/// `--features testing` build to mainnet does not, by itself, hand the pool
/// over to anyone with a signed transaction.
pub(crate) const MOCK_ADMIN: Address = Address::new_from_array([0u8; 32]);

#[inline(always)]
pub(crate) fn enforce_mock_admin(account: &AccountView) -> Result<(), ProgramError> {
    if !account.is_signer() {
        return Err(LendError::MissingSignature.into());
    }
    if account.address() != &MOCK_ADMIN {
        return Err(LendError::NotMockAdmin.into());
    }
    Ok(())
}

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
        enforce_mock_admin(&accounts[0])?;
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
