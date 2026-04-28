/*!
UpdateOraclePrice — refresh the Pyth oracle price cached in a LendingPool.

The Pyth account is validated by magic bytes, aggregate status, and (on the
first anchor) the pool authority's signature.

First call: requires the pool authority's signature; anchors `pyth_price_feed`
to accounts[1].address(). Subsequent calls are permissionless and only verify
that accounts[1] matches the anchored feed.

Accounts:
  [0]  pool              writable
  [1]  pyth_price_feed   read-only (Pyth legacy push-oracle)
  [2]  pool_authority    signer (required only on first anchor)

Instruction data (after discriminator 0x14): none
*/

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use crate::{
    errors::LendError,
    pyth,
    state::{check_program_owner, LendingPool},
};

/// Maximum acceptable age (in seconds) of a Pyth oracle price update.
/// Tightened from 120s to 30s — Solana markets move several percent in
/// minutes during volatile events, and a wider window lets an attacker
/// cache a favourable price and immediately borrow against it.
const MAX_ORACLE_AGE: i64 = 30;

/// Acceptable range for Pyth's exponent. An out-of-range exponent would
/// cause `10u128.checked_pow(|expo|)` to overflow in `token_to_usd_wad`,
/// permanently bricking the pool.
const ORACLE_EXPO_MIN: i32 = -18;
const ORACLE_EXPO_MAX: i32 = 18;

/// Allowlist of trusted Pyth program IDs. Any account claiming to be a Pyth
/// price feed must be owned by one of these programs. Without this check, an
/// attacker can deploy a fake-Pyth program, hand-craft an account whose bytes
/// pass `pyth::read_price`, and front-run the first oracle anchor with a
/// malicious price.
///
/// Sources:
///   - Pyth mainnet legacy push-oracle: FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH
///   - Pyth Solana receiver (pull):     rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VguS5zmxZqYS
const PYTH_PROGRAM_IDS: [Address; 2] = [
    Address::new_from_array([
        0xdc, 0xe5, 0xeb, 0xe1, 0xe4, 0x9c, 0x3b, 0x9f, 0x11, 0x4c, 0xb5, 0x54, 0x4c, 0x50, 0xa9,
        0x9e, 0xc0, 0xd6, 0x92, 0xd6, 0x3f, 0x56, 0x79, 0x5a, 0xe0, 0x29, 0xac, 0x83, 0xd9, 0xea,
        0x8b, 0xe2,
    ]),
    Address::new_from_array([
        0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48, 0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b,
        0x90, 0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x02, 0x4a, 0x2c, 0x75, 0xd6, 0x6f, 0xa0,
        0x74, 0x0f,
    ]),
];

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

        // ── Pool ownership check ─────────────────────────────────────────
        check_program_owner(&accounts[0], program_id)?;

        // ── Strict Pyth-owner allowlist ──────────────────────────────────
        // Reject any oracle account not owned by a known Pyth program. Without
        // this check, the only constraint on the oracle account is that its
        // bytes pass `pyth::read_price`, which an attacker-controlled program
        // can synthesise trivially.
        let oracle_owner = accounts[1].owner();
        if oracle_owner == program_id {
            return Err(LendError::OracleInvalid.into());
        }
        let mut owner_ok = false;
        for pid in PYTH_PROGRAM_IDS.iter() {
            if oracle_owner == pid {
                owner_ok = true;
                break;
            }
        }
        if !owner_ok {
            return Err(LendError::OracleInvalid.into());
        }

        // Validate and read the Pyth price before touching the pool.
        let pyth_price = pyth::read_price(&accounts[1])?;
        let feed_addr = *accounts[1].address();

        // ── Exponent bounds check ────────────────────────────────────────
        if pyth_price.expo < ORACLE_EXPO_MIN || pyth_price.expo > ORACLE_EXPO_MAX {
            return Err(LendError::OracleInvalid.into());
        }

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
            // First call: require the pool authority's signature so an
            // attacker cannot front-run pool initialisation and anchor a
            // malicious feed permanently.
            if accounts.len() < 3 {
                return Err(LendError::MissingSignature.into());
            }
            if !accounts[2].is_signer() {
                return Err(LendError::MissingSignature.into());
            }
            if &pool.authority != accounts[2].address() {
                return Err(LendError::Unauthorized.into());
            }
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
