/*!
`LendingPool` — one account per token market.

Layout (repr C, 408 bytes, 16-byte aligned throughout):

| offset | size | field                  |
|--------|------|------------------------|
|   0    |   8  | discriminator          |
|   8    |  32  | authority              |
|  40    |  32  | token_mint             |
|  72    |  32  | vault                  |
| 104    |   8  | total_deposits         |
| 112    |   8  | total_borrows          |
| 120    |   8  | accumulated_fees       |
| 128    |   8  | last_update_timestamp  |
| 136    |   1  | authority_bump         |
| 137    |   1  | pool_bump              |
| 138    |   1  | vault_bump             |
| 139    |   1  | paused                 |
| 140    |   1  | token_decimals         |
| 141    |   3  | _pad                   |
| 144    |  16  | borrow_index           |
| 160    |  16  | supply_index           |
| 176    |  16  | base_rate              |
| 192    |  16  | optimal_utilization    |
| 208    |  16  | slope1                 |
| 224    |  16  | slope2                 |
| 240    |  16  | reserve_factor         |
| 256    |  16  | ltv                    |
| 272    |  16  | liquidation_threshold  |
| 288    |  16  | liquidation_bonus      |
| 304    |  16  | protocol_liq_fee       |
| 320    |  16  | close_factor           |
| 336    |   8  | flash_loan_amount      |
| 344    |   8  | flash_fee_bps          |
| 352    |  32  | pyth_price_feed        |
| 384    |   8  | oracle_price           |
| 392    |   8  | oracle_conf            |
| 400    |   4  | oracle_expo            |
| 404    |  12  | _oracle_pad            |
| 416    |      | (end)                  |
*/

use crate::math::WAD;
use pinocchio::{account::AccountView, error::ProgramError, Address};

#[repr(C)]
pub struct LendingPool {
    pub discriminator: [u8; 8],

    /// Protocol admin.
    pub authority: Address,
    /// SPL-token mint this pool lends.
    pub token_mint: Address,
    /// Token vault (owned by pool_authority PDA).
    pub vault: Address,

    // ── Pool state ────────────────────────────────────────────────────────
    /// Sum of deposited tokens (grows with depositor interest on accrual).
    pub total_deposits: u64,
    /// Virtual outstanding borrows including accrued interest.
    pub total_borrows: u64,
    /// Protocol fees accumulated.
    pub accumulated_fees: u64,
    /// Unix timestamp of last interest accrual.
    pub last_update_timestamp: i64,

    // ── PDA bumps ─────────────────────────────────────────────────────────
    pub authority_bump: u8,
    pub pool_bump: u8,
    pub vault_bump: u8,
    /// Non-zero when the pool is paused; deposits and borrows are blocked.
    pub paused: u8,
    /// SPL-token mint decimals (6 for USDC, 9 for SOL, 8 for BTC).
    /// Used to normalize token amounts to USD in cross-collateral calculations.
    pub token_decimals: u8,
    pub _pad: [u8; 3],

    // ── Interest indices (WAD = 1e18) ─────────────────────────────────────
    pub borrow_index: u128,
    pub supply_index: u128,

    // ── Interest-rate parameters (WAD-scaled annual rates) ────────────────
    pub base_rate: u128,
    pub optimal_utilization: u128,
    pub slope1: u128,
    pub slope2: u128,
    pub reserve_factor: u128,

    // ── Risk parameters (WAD-scaled) ──────────────────────────────────────
    pub ltv: u128,
    pub liquidation_threshold: u128,
    pub liquidation_bonus: u128,
    pub protocol_liq_fee: u128,
    pub close_factor: u128,

    // ── Flash loan state ──────────────────────────────────────────────────
    /// Amount currently lent via an in-flight flash loan (0 = none active).
    pub flash_loan_amount: u64,
    /// Flash loan fee in basis points (default 9 = 0.09 %).
    pub flash_fee_bps: u64,

    // ── Pyth oracle ───────────────────────────────────────────────────────
    /// Pyth legacy push-oracle price feed account address.
    /// All-zeros means no feed has been anchored yet.
    pub pyth_price_feed: Address,
    /// Last cached aggregate price (raw, apply oracle_expo for USD value).
    pub oracle_price: i64,
    /// Last cached aggregate confidence interval.
    pub oracle_conf: u64,
    /// Price exponent (negative — price_usd = oracle_price × 10^oracle_expo).
    pub oracle_expo: i32,
    pub _oracle_pad: [u8; 12],
}

impl LendingPool {
    pub const DISCRIMINATOR: [u8; 8] = *b"VEILPOOL";
    pub const SIZE: usize = 416;

    // ── Zero-copy account access ──────────────────────────────────────────

    /// Borrow a shared reference from an account.
    /// Safety: caller ensures no concurrent mutable access to the same account.
    #[inline(always)]
    pub fn from_account(account: &AccountView) -> Result<&Self, ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let pool = unsafe { &*(account.data_ptr() as *const Self) };
        if pool.discriminator != Self::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(pool)
    }

    /// Borrow a mutable reference from an account.
    /// Safety: caller ensures exclusive access; raw-pointer cast bypasses
    /// Rust's aliasing rules intentionally (pinocchio pattern).
    #[inline(always)]
    pub fn from_account_mut(account: &AccountView) -> Result<&mut Self, ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let pool = unsafe { &mut *(account.data_ptr() as *mut Self) };
        if pool.discriminator != Self::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(pool)
    }

    /// Initialise a freshly-allocated (zeroed) account with default parameters.
    pub fn init(
        account: &AccountView,
        authority: &Address,
        token_mint: &Address,
        vault: &Address,
        timestamp: i64,
        authority_bump: u8,
        pool_bump: u8,
        vault_bump: u8,
    ) -> Result<(), ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        // Zero the whole allocation first.
        let raw =
            unsafe { core::slice::from_raw_parts_mut(account.data_ptr() as *mut u8, Self::SIZE) };
        raw.fill(0);

        let pool = unsafe { &mut *(account.data_ptr() as *mut Self) };

        pool.discriminator = Self::DISCRIMINATOR;
        pool.authority = *authority;
        pool.token_mint = *token_mint;
        pool.vault = *vault;
        pool.last_update_timestamp = timestamp;
        pool.authority_bump = authority_bump;
        pool.pool_bump = pool_bump;
        pool.vault_bump = vault_bump;

        // Indices start at 1.0 (WAD).
        pool.borrow_index = WAD;
        pool.supply_index = WAD;

        // Default interest-rate parameters.
        pool.base_rate = crate::math::BASE_RATE;
        pool.optimal_utilization = crate::math::OPTIMAL_UTIL;
        pool.slope1 = crate::math::SLOPE1;
        pool.slope2 = crate::math::SLOPE2;
        pool.reserve_factor = crate::math::RESERVE_FACTOR;

        // Default risk parameters.
        pool.ltv = crate::math::LTV;
        pool.liquidation_threshold = crate::math::LIQ_THRESHOLD;
        pool.liquidation_bonus = crate::math::LIQ_BONUS;
        pool.protocol_liq_fee = crate::math::PROTOCOL_LIQ_FEE;
        pool.close_factor = crate::math::CLOSE_FACTOR;

        // Flash loan defaults.
        pool.flash_loan_amount = 0;
        pool.flash_fee_bps = crate::math::FLASH_FEE_BPS;

        Ok(())
    }

    // ── Interest accrual ──────────────────────────────────────────────────

    /// Advance interest indices and virtual pool totals.
    /// Must be called at the start of every state-mutating instruction.
    pub fn accrue_interest(&mut self, current_timestamp: i64) -> Result<(), ProgramError> {
        if current_timestamp < self.last_update_timestamp {
            return Ok(());
        }
        let elapsed = (current_timestamp - self.last_update_timestamp) as u64;
        if elapsed == 0 {
            return Ok(());
        }

        let util = crate::math::utilization_rate(self.total_borrows, self.total_deposits)?;
        let b_rate = crate::math::borrow_rate(
            util,
            self.base_rate,
            self.optimal_utilization,
            self.slope1,
            self.slope2,
        )?;
        let s_rate = crate::math::supply_rate(b_rate, util, self.reserve_factor)?;

        let prev_borrow_idx = self.borrow_index;
        let (new_borrow_idx, new_supply_idx) = crate::math::accrue_indices(
            self.borrow_index,
            self.supply_index,
            b_rate,
            s_rate,
            elapsed,
        )?;

        // Derive virtual interest from the actual index delta — this keeps
        // total_borrows perfectly consistent with what current_borrow_balance
        // reports for every individual position. Computing it independently
        // (rate × elapsed × principal) drifts from the index due to integer
        // truncation and can overflow u128 on large borrow books.
        let interest = if prev_borrow_idx == 0 {
            0u64
        } else {
            let delta_idx = new_borrow_idx.saturating_sub(prev_borrow_idx);
            // interest = total_borrows × delta_idx / prev_borrow_idx  (clamped to u64)
            let scaled = (self.total_borrows as u128)
                .checked_mul(delta_idx)
                .ok_or(ProgramError::ArithmeticOverflow)?
                / prev_borrow_idx;
            scaled.min(u64::MAX as u128) as u64
        };

        let fees = crate::math::wad_mul(interest as u128, self.reserve_factor)? as u64;
        let dep_int = interest.saturating_sub(fees);

        self.total_borrows = self.total_borrows.saturating_add(interest);
        self.accumulated_fees = self.accumulated_fees.saturating_add(fees);
        self.total_deposits = self.total_deposits.saturating_add(dep_int);

        self.borrow_index = new_borrow_idx;
        self.supply_index = new_supply_idx;
        self.last_update_timestamp = current_timestamp;

        Ok(())
    }
}
