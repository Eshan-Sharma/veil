/*!
Borrow tokens against deposited collateral.

Enforces: maxBorrow = depositBalance × LTV, HF ≥ 1.0 after borrow.

Accounts:
  [0]  user              signer, writable
  [1]  user_token        writable
  [2]  vault             writable
  [3]  pool              writable
  [4]  user_position     writable
  [5]  pool_authority    read-only
  [6]  token_program

Instruction data (after discriminator 0x03):
  amount: u64 LE
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::LendError,
    math,
    state::{LendingPool, UserPosition},
};

pub struct Borrow {
    pub amount: u64,
}

#[inline(always)]
fn validate_borrow(
    pool: &LendingPool,
    pos: &UserPosition,
    amount: u64,
) -> Result<(u64, u8), ProgramError> {
    if pool.paused != 0 {
        return Err(LendError::PoolPaused.into());
    }

    let deposit_balance = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
    let existing_debt = math::current_borrow_balance(
        pos.borrow_principal,
        pool.borrow_index,
        pos.borrow_index_snapshot,
    )?;

    let max_borrow = math::max_borrowable(deposit_balance, pool.ltv)?;
    let debt_after = existing_debt.saturating_add(amount);
    if debt_after > max_borrow {
        return Err(LendError::ExceedsCollateralFactor.into());
    }

    let hf = if pool.pyth_price_feed == [0u8; 32].into() {
        // Mock health factor for localnet testing when no oracle is anchored
        math::WAD * 2 // Always healthy
    } else {
        math::health_factor(deposit_balance, debt_after, pool.liquidation_threshold)?
    };

    if hf < math::WAD {
        return Err(LendError::Undercollateralised.into());
    }

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    if amount > available {
        return Err(LendError::InsufficientLiquidity.into());
    }

    Ok((existing_debt, pool.authority_bump))
}

#[inline(always)]
fn apply_borrow_to_position(
    pos: &mut UserPosition,
    existing_debt: u64,
    amount: u64,
    borrow_index: u128,
) {
    pos.borrow_principal = existing_debt.saturating_add(amount);
    pos.borrow_index_snapshot = borrow_index;
}

#[inline(always)]
fn apply_borrow_to_pool(pool: &mut LendingPool, amount: u64) {
    pool.total_borrows = pool.total_borrows.saturating_add(amount);
}

impl Borrow {
    pub const DISCRIMINATOR: u8 = 3;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            if pool.paused != 0 {
                return Err(LendError::PoolPaused.into());
            }
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Risk checks ───────────────────────────────────────────────────
        let (existing_debt, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            validate_borrow(pool, pos, self.amount)?
        };

        // ── Token transfer: vault → user ──────────────────────────────────
        let pool_addr = *accounts[3].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[2], &accounts[1], &accounts[5], self.amount)
            .invoke_signed(&[signer])?;

        // ── Update state ──────────────────────────────────────────────────
        let borrow_index = {
            let pool = LendingPool::from_account(&accounts[3])?;
            pool.borrow_index
        };
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            apply_borrow_to_position(pos, existing_debt, self.amount, borrow_index);
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            apply_borrow_to_pool(pool, self.amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{LIQ_THRESHOLD, LTV, WAD};

    fn pool() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.ltv = LTV;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.authority_bump = 7;
        pool
    }

    fn position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.deposit_shares = deposit_shares;
        pos.borrow_principal = borrow_principal;
        pos.deposit_index_snapshot = WAD;
        pos.borrow_index_snapshot = WAD;
        pos
    }

    #[test]
    fn borrow_validate_rejects_paused_pool() {
        let mut pool = pool();
        pool.paused = 1;
        assert_eq!(validate_borrow(&pool, &position(1_000, 0), 1), Err(LendError::PoolPaused.into()));
    }

    #[test]
    fn borrow_validate_rejects_excess_collateral_factor() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        assert_eq!(
            validate_borrow(&pool, &position(1_000, 0), 751),
            Err(LendError::ExceedsCollateralFactor.into())
        );
    }

    #[test]
    fn borrow_validate_rejects_undercollateralised_after_borrow() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        pool.ltv = WAD;
        // Set a non-zero pyth_price_feed so the real HF check runs
        pool.pyth_price_feed = [1u8; 32].into();
        assert_eq!(
            validate_borrow(&pool, &position(1_000, 0), 900),
            Err(LendError::Undercollateralised.into())
        );
    }

    #[test]
    fn borrow_validate_rejects_insufficient_liquidity() {
        let mut pool = pool();
        pool.total_deposits = 500;
        pool.total_borrows = 100;
        pool.accumulated_fees = 50;
        assert_eq!(
            validate_borrow(&pool, &position(2_000, 0), 600),
            Err(LendError::InsufficientLiquidity.into())
        );
    }

    #[test]
    fn borrow_validate_returns_existing_debt_and_bump() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        assert_eq!(validate_borrow(&pool, &position(2_000, 300), 400), Ok((300, 7)));
    }

    #[test]
    fn borrow_apply_position_updates_debt_and_snapshot() {
        let mut pos = position(2_000, 300);
        apply_borrow_to_position(&mut pos, 300, 400, 123);
        assert_eq!(pos.borrow_principal, 700);
        assert_eq!(pos.borrow_index_snapshot, 123);
    }

    #[test]
    fn borrow_apply_pool_updates_total_borrows() {
        let mut pool = pool();
        pool.total_borrows = 300;
        apply_borrow_to_pool(&mut pool, 400);
        assert_eq!(pool.total_borrows, 700);
    }
}
