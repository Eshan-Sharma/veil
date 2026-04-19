/*!
UpdateOraclePrice — refresh the Pyth oracle price cached in a LendingPool.

Anyone may call this instruction; the Pyth account is validated by its magic
bytes and aggregate status, not by a signer.

First call: anchors pyth_price_feed to accounts[1].address().
Subsequent calls: verifies accounts[1] matches the anchored feed.

Accounts:
  [0]  pool              writable
  [1]  pyth_price_feed   read-only (Pyth legacy push-oracle)

Instruction data (after discriminator 0x14): none
*/

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use crate::{errors::LendError, pyth, state::LendingPool};

pub struct UpdateOraclePrice;

impl UpdateOraclePrice {
    pub const DISCRIMINATOR: u8 = 0x14;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Self)
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }

        // Validate and read the Pyth price before touching the pool.
        let pyth_price = pyth::read_price(&accounts[1])?;
        let feed_addr = *accounts[1].address();

        let pool = LendingPool::from_account_mut(&accounts[0])?;

        let zero: Address = [0u8; 32].into();
        if pool.pyth_price_feed == zero {
            // First call: anchor this feed address to the pool.
            pool.pyth_price_feed = feed_addr;
        } else if pool.pyth_price_feed != feed_addr {
            return Err(LendError::OraclePriceFeedMismatch.into());
        }

        pool.oracle_price = pyth_price.price;
        pool.oracle_conf  = pyth_price.conf;
        pool.oracle_expo  = pyth_price.expo;

        Ok(())
    }
}
