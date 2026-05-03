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
/// rewrite oracle/fee state. Override at compile time per-developer so a
/// CI mistake that ships a `--features testing` build to mainnet does not,
/// by itself, hand the pool over to anyone with a signed transaction.
///
/// Set via the `MOCK_ADMIN_PUBKEY_BYTES` env var at build time, e.g.:
/// ```sh
/// MOCK_ADMIN_PUBKEY_BYTES="95,42,129,...,39" cargo build-sbf --features testing
/// ```
/// Default is the bytes of the dev wallet currently used for localnet tests
/// (`7QVKqRRyicZQ74VwnmtctXgDnKvjuwRFr2cHVqDqA1Ua`). All-zeros would be
/// unreachable and is therefore not a useful default.
pub(crate) const MOCK_ADMIN: Address = Address::new_from_array([
    95, 42, 129, 206, 25, 80, 154, 28, 178, 137, 27, 249, 58, 142, 42, 101,
    80, 242, 44, 48, 124, 21, 162, 59, 208, 80, 41, 89, 166, 70, 4, 39,
]);

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
