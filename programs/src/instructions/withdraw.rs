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
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
};

pub struct Withdraw {
    pub shares: u64,
}

#[inline(always)]
pub(crate) fn compute_withdrawal_terms(
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
pub(crate) fn apply_withdrawal_to_position(pos: &mut UserPosition, shares: u64, supply_index: u128) {
    pos.deposit_shares = pos.deposit_shares.saturating_sub(shares);
    pos.deposit_index_snapshot = supply_index;
}

#[inline(always)]
pub(crate) fn apply_withdrawal_to_pool(pool: &mut LendingPool, token_amount: u64) {
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

        check_program_owner(&accounts[3], program_id)?;
        check_program_owner(&accounts[4], program_id)?;
        check_token_program(&accounts[6])?;

        let clock = Clock::get()?;
        let (token_amount, authority_bump, supply_index) = {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
            pool.accrue_interest(clock.unix_timestamp)?;

            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            if pos.cross_collateral != 0 {
                return Err(LendError::CrossCollateralActive.into());
            }
            let (amt, bump) = compute_withdrawal_terms(pool, pos, self.shares)?;
            (amt, bump, pool.supply_index)
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

