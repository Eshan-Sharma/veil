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
| 140    |   4  | _pad                   |
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
    pub _pad: [u8; 4],

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

        let (new_borrow_idx, new_supply_idx) = crate::math::accrue_indices(
            self.borrow_index,
            self.supply_index,
            b_rate,
            s_rate,
            elapsed,
        )?;

        // Virtual interest on the borrow book.
        let interest_u128 = (self.total_borrows as u128)
            .checked_mul(b_rate)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_mul(elapsed as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?
            / crate::math::SECONDS_PER_YEAR
            / WAD;

        let interest = interest_u128.min(u64::MAX as u128) as u64;
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::*;

    /// Build a zeroed pool with all default parameters and WAD indices.
    fn default_pool() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.base_rate = BASE_RATE;
        pool.optimal_utilization = OPTIMAL_UTIL;
        pool.slope1 = SLOPE1;
        pool.slope2 = SLOPE2;
        pool.reserve_factor = RESERVE_FACTOR;
        pool.ltv = LTV;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.liquidation_bonus = LIQ_BONUS;
        pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
        pool.close_factor = CLOSE_FACTOR;
        pool.last_update_timestamp = 0;
        pool
    }

    // ── Default values ────────────────────────────────────────────────────────

    #[test]
    fn default_pool_starts_with_wad_indices() {
        let pool = default_pool();
        assert_eq!(pool.borrow_index, WAD);
        assert_eq!(pool.supply_index, WAD);
    }

    #[test]
    fn default_pool_ltv_is_75_percent() {
        let pool = default_pool();
        assert_eq!(pool.ltv, LTV);
        // 75% of WAD
        assert_eq!(pool.ltv, WAD * 75 / 100);
    }

    #[test]
    fn default_pool_liq_threshold_is_80_percent() {
        let pool = default_pool();
        assert_eq!(pool.liquidation_threshold, LIQ_THRESHOLD);
        assert_eq!(pool.liquidation_threshold, WAD * 80 / 100);
    }

    #[test]
    fn default_pool_close_factor_is_50_percent() {
        let pool = default_pool();
        assert_eq!(pool.close_factor, CLOSE_FACTOR);
        assert_eq!(pool.close_factor, WAD / 2);
    }

    // ── accrue_interest: no-op cases ─────────────────────────────────────────

    #[test]
    fn accrue_noop_same_timestamp() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 500_000;
        pool.accrue_interest(0).unwrap();
        // Elapsed = 0 → no change
        assert_eq!(pool.borrow_index, WAD);
        assert_eq!(pool.supply_index, WAD);
        assert_eq!(pool.total_deposits, 1_000_000);
        assert_eq!(pool.total_borrows, 500_000);
    }

    #[test]
    fn accrue_noop_backwards_timestamp() {
        let mut pool = default_pool();
        pool.last_update_timestamp = 1000;
        pool.total_borrows = 500_000;
        pool.total_deposits = 1_000_000;
        let bi_before = pool.borrow_index;
        // Timestamp goes backward → function returns Ok but does nothing
        pool.accrue_interest(999).unwrap();
        assert_eq!(pool.borrow_index, bi_before);
    }

    // ── accrue_interest: no borrows ──────────────────────────────────────────

    #[test]
    fn accrue_no_borrows_indices_stay_at_wad() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 0;
        pool.accrue_interest(86_400).unwrap(); // 1 day
        // Utilization = 0 → supply rate = 0 → supply index stays at WAD
        // Borrow index grows by BASE_RATE × 1day / 1year (very small)
        // but with 0 borrows, the fee/deposit additions are 0
        assert_eq!(pool.accumulated_fees, 0);
        assert_eq!(pool.total_deposits, 1_000_000);
        // Supply index should not grow when utilization is zero
        assert_eq!(pool.supply_index, WAD);
    }

    // ── accrue_interest: with borrows ────────────────────────────────────────

    #[test]
    fn accrue_with_borrows_borrow_index_grows() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 800_000; // 80% utilization (at kink)
        pool.accrue_interest(86_400).unwrap(); // 1 day
        // At kink: borrow_rate = BASE_RATE + SLOPE1 = 1% + 4% = 5% annual
        // borrow_index grows by 5% × 1/365 ≈ 0.0137%
        assert!(pool.borrow_index > WAD, "borrow index must grow");
        assert!(pool.supply_index > WAD, "supply index must grow (some borrows)");
    }

    #[test]
    fn accrue_with_borrows_fees_accrue() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 500_000; // 50% utilization
        pool.accrue_interest(86_400 * 30).unwrap(); // 30 days
        assert!(pool.accumulated_fees > 0, "fees must accrue over 30 days");
    }

    #[test]
    fn accrue_total_deposits_grows_with_interest() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 500_000;
        pool.accrue_interest(86_400 * 365).unwrap(); // 1 year
        // Depositors earn some interest (net of reserve factor)
        assert!(pool.total_deposits > 1_000_000);
    }

    #[test]
    fn accrue_total_borrows_grows_with_interest() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 500_000;
        pool.accrue_interest(86_400 * 365).unwrap(); // 1 year
        // Borrowers owe more after a year
        assert!(pool.total_borrows > 500_000);
    }

    #[test]
    fn accrue_updates_timestamp() {
        let mut pool = default_pool();
        pool.last_update_timestamp = 0;
        pool.accrue_interest(12_345).unwrap();
        assert_eq!(pool.last_update_timestamp, 12_345);
    }

    // ── accrue_interest: above kink ──────────────────────────────────────────

    #[test]
    fn accrue_above_kink_higher_borrow_index_growth() {
        // At 95% utilization borrow rate is much higher than at 50%
        let mut pool_low = default_pool();
        pool_low.total_deposits = 1_000_000;
        pool_low.total_borrows = 500_000; // 50% util
        pool_low.accrue_interest(86_400).unwrap();
        let low_growth = pool_low.borrow_index - WAD;

        let mut pool_high = default_pool();
        pool_high.total_deposits = 1_000_000;
        pool_high.total_borrows = 950_000; // 95% util (above kink)
        pool_high.accrue_interest(86_400).unwrap();
        let high_growth = pool_high.borrow_index - WAD;

        assert!(
            high_growth > low_growth,
            "above-kink borrow index growth ({}) must exceed below-kink ({})",
            high_growth,
            low_growth
        );
    }

    #[test]
    fn accrue_full_utilization_maximum_rate() {
        let mut pool = default_pool();
        pool.total_deposits = 1_000_000;
        pool.total_borrows = 1_000_000; // 100% utilization
        pool.accrue_interest(86_400 * 365).unwrap();
        // At 100% util: borrow_rate = BASE_RATE + SLOPE1 + SLOPE2 = 1+4+75 = 80% annual
        // After 1 year borrow_index ≈ WAD × 1.8
        let expected_approx = WAD + WAD * 8 / 10; // 1.8 × WAD
        // Allow ±1% tolerance for integer rounding
        let tolerance = expected_approx / 100;
        assert!(
            pool.borrow_index > expected_approx - tolerance,
            "borrow index {} too low",
            pool.borrow_index
        );
        assert!(
            pool.borrow_index < expected_approx + tolerance,
            "borrow index {} too high",
            pool.borrow_index
        );
    }

    // ── Incremental vs batch accrual ─────────────────────────────────────────

    #[test]
    fn accrue_two_steps_equals_one_step_approx() {
        // Accruing in two steps of 12h should be close to one step of 24h.
        // (Not exactly equal due to compounding, but within 0.1% for short periods.)
        let deposits = 1_000_000u64;
        let borrows = 600_000u64;

        let mut single = default_pool();
        single.total_deposits = deposits;
        single.total_borrows = borrows;
        single.accrue_interest(86_400).unwrap();

        let mut incremental = default_pool();
        incremental.total_deposits = deposits;
        incremental.total_borrows = borrows;
        incremental.accrue_interest(43_200).unwrap();
        incremental.accrue_interest(86_400).unwrap();

        // Borrow indices should be within 0.001% of each other
        let diff = single.borrow_index.abs_diff(incremental.borrow_index);
        let tolerance = WAD / 100_000; // 0.001%
        assert!(
            diff < tolerance,
            "borrow index divergence too large: {} vs {}",
            single.borrow_index,
            incremental.borrow_index
        );
    }

    // ── SIZE constant ────────────────────────────────────────────────────────

    #[test]
    fn lending_pool_size_matches_struct() {
        assert_eq!(core::mem::size_of::<LendingPool>(), LendingPool::SIZE);
    }
}
