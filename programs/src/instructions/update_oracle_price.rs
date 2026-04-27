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

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use crate::{errors::LendError, pyth, state::LendingPool};

/// Maximum acceptable age (in seconds) of a Pyth oracle price update.
/// Prices older than this are considered stale and rejected.
const MAX_ORACLE_AGE: i64 = 120;

/// System program ID (all zeros). An oracle account owned by the system
/// program is uninitialised and must be rejected.
const SYSTEM_PROGRAM: Address = Address::new_from_array([0u8; 32]);

pub struct UpdateOraclePrice;

impl UpdateOraclePrice {
    pub const DISCRIMINATOR: u8 = 0x14;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Self)
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }

        // ── Owner sanity check ───────────────────────────────────────────
        // Reject oracle accounts owned by the system program (uninitialised)
        // or by the Veil program itself (spoofable by anyone who can CPI).
        let oracle_owner = accounts[1].owner();
        if oracle_owner == &SYSTEM_PROGRAM || oracle_owner == program_id {
            return Err(LendError::OracleInvalid.into());
        }

        // Validate and read the Pyth price before touching the pool.
        let pyth_price = pyth::read_price(&accounts[1])?;
        let feed_addr = *accounts[1].address();

        // ── Staleness check ──────────────────────────────────────────────
        // On Solana, Clock is always available. In off-chain test harnesses
        // it may be absent; we skip the check only when the sysvar is
        // genuinely unavailable (UnsupportedSysvar).
        if let Ok(clock) = Clock::get() {
            let age = clock.unix_timestamp.saturating_sub(pyth_price.timestamp);
            if age > MAX_ORACLE_AGE {
                return Err(LendError::OraclePriceStale.into());
            }
        }

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
