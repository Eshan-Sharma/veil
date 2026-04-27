/*!
Withdraw tokens by redeeming supply shares.

tokenAmount = shares × supplyIndex / WAD
Health factor is checked after withdrawal.

Accounts:
  [0]  user              signer, writable
  [1]  user_token        writable
  [2]  vault             writable
  [3]  pool              writable
  [4]  user_position     writable
  [5]  pool_authority    read-only – PDA that owns vault
  [6]  token_program

Instruction data (after discriminator 0x02):
  shares: u64 LE
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
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct Withdraw {
    pub shares: u64,
}

#[inline(always)]
fn compute_withdrawal_terms(
    pool: &LendingPool,
    pos: &UserPosition,
    shares: u64,
) -> Result<(u64, u8), ProgramError> {
    if pos.deposit_shares < shares {
        return Err(LendError::ExceedsDepositBalance.into());
    }

    let token_amount = math::current_deposit_balance(shares, pool.supply_index)?;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    if token_amount > available {
        return Err(LendError::InsufficientLiquidity.into());
    }

    let remaining_shares = pos.deposit_shares - shares;
    let remaining_deposit = math::current_deposit_balance(remaining_shares, pool.supply_index)?;
    let debt = math::current_borrow_balance(
        pos.borrow_principal,
        pool.borrow_index,
        pos.borrow_index_snapshot,
    )?;
    if debt > 0 {
        let hf = math::health_factor(remaining_deposit, debt, pool.liquidation_threshold)?;
        if hf < math::WAD {
            return Err(LendError::Undercollateralised.into());
        }
    }

    Ok((token_amount, pool.authority_bump))
}

#[inline(always)]
fn apply_withdrawal_to_position(pos: &mut UserPosition, shares: u64, supply_index: u128) {
    pos.deposit_shares = pos.deposit_shares.saturating_sub(shares);
    pos.deposit_index_snapshot = supply_index;
}

#[inline(always)]
fn apply_withdrawal_to_pool(pool: &mut LendingPool, token_amount: u64) {
    pool.total_deposits = pool.total_deposits.saturating_sub(token_amount);
}

impl Withdraw {
    pub const DISCRIMINATOR: u8 = 2;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            shares: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.shares == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?; // pool
        check_program_owner(&accounts[4], program_id)?; // user_position

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Compute withdrawal amount and health factor ───────────────────
        let (token_amount, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            compute_withdrawal_terms(pool, pos, self.shares)?
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

        Transfer::new(&accounts[2], &accounts[1], &accounts[5], token_amount)
            .invoke_signed(&[signer])?;

        // ── Update state ──────────────────────────────────────────────────
        let supply_index = LendingPool::from_account(&accounts[3])?.supply_index;
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            apply_withdrawal_to_position(pos, self.shares, supply_index);
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            apply_withdrawal_to_pool(pool, token_amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{LIQ_THRESHOLD, WAD};

    fn pool() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.authority_bump = 5;
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
    fn withdraw_terms_reject_excess_shares() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        assert_eq!(
            compute_withdrawal_terms(&pool, &position(100, 0), 101),
            Err(LendError::ExceedsDepositBalance.into())
        );
    }

    #[test]
    fn withdraw_terms_reject_insufficient_liquidity() {
        let mut pool = pool();
        pool.total_deposits = 500;
        pool.total_borrows = 100;
        pool.accumulated_fees = 50;
        assert_eq!(
            compute_withdrawal_terms(&pool, &position(1_000, 0), 600),
            Err(LendError::InsufficientLiquidity.into())
        );
    }

    #[test]
    fn withdraw_terms_reject_undercollateralised() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        assert_eq!(
            compute_withdrawal_terms(&pool, &position(1_250, 1_000), 1),
            Err(LendError::Undercollateralised.into())
        );
    }

    #[test]
    fn withdraw_terms_return_token_amount_and_bump() {
        let mut pool = pool();
        pool.total_deposits = 10_000;
        assert_eq!(compute_withdrawal_terms(&pool, &position(1_000, 0), 500), Ok((500, 5)));
    }

    #[test]
    fn withdraw_apply_position_updates_shares_and_snapshot() {
        let mut pos = position(1_000, 0);
        apply_withdrawal_to_position(&mut pos, 500, 123);
        assert_eq!(pos.deposit_shares, 500);
        assert_eq!(pos.deposit_index_snapshot, 123);
    }

    #[test]
    fn withdraw_apply_pool_reduces_total_deposits() {
        let mut pool = pool();
        pool.total_deposits = 1_000;
        apply_withdrawal_to_pool(&mut pool, 500);
        assert_eq!(pool.total_deposits, 500);
    }
}
