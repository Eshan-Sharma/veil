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
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
};

pub struct Borrow {
    pub amount: u64,
}

#[inline(always)]
pub(crate) fn validate_borrow(
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

    // No oracle anchored → cannot value collateral → cannot safely lend.
    // Any "mock" branch here would let mainnet-deployed pools borrow against
    // unpriced collateral.
    if pool.pyth_price_feed == [0u8; 32].into() {
        return Err(LendError::OracleNotAnchored.into());
    }

    let hf = math::health_factor(deposit_balance, debt_after, pool.liquidation_threshold)?;
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
pub(crate) fn apply_borrow_to_position(
    pos: &mut UserPosition,
    existing_debt: u64,
    amount: u64,
    borrow_index: u128,
) {
    pos.borrow_principal = existing_debt.saturating_add(amount);
    pos.borrow_index_snapshot = borrow_index;
}

#[inline(always)]
pub(crate) fn apply_borrow_to_pool(pool: &mut LendingPool, amount: u64) {
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

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner / identity checks ──────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?; // pool
        check_program_owner(&accounts[4], program_id)?; // user_position
        check_token_program(&accounts[6])?;
        {
            let pool = LendingPool::from_account(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
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

