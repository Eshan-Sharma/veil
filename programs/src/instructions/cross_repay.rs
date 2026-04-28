/*!
Repay debt on a pool that is part of a cross-collateral arrangement.

Identical to regular Repay, but also accepts trailing collateral position
accounts to clear their `cross_collateral` flag when the borrow is fully repaid.

Accounts:
  [0]  user              signer, writable
  [1]  user_token        writable
  [2]  vault             writable
  [3]  pool              writable
  [4]  user_position     writable
  [5]  token_program
  [6..N]  collateral positions to clear (writable) — optional

Instruction data (after discriminator 0x18):
  amount: u64 LE
*/

use pinocchio::{
    account::AccountView,
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

pub struct CrossRepay {
    pub amount: u64,
}

#[inline(always)]
pub(crate) fn compute_repay(
    pool: &LendingPool,
    pos: &UserPosition,
    amount: u64,
) -> Result<(u64, u64, u128), ProgramError> {
    if pos.borrow_principal == 0 {
        return Err(LendError::NoBorrow.into());
    }
    let total_debt = math::current_borrow_balance(
        pos.borrow_principal,
        pool.borrow_index,
        pos.borrow_index_snapshot,
    )?;
    let repay_amount = amount.min(total_debt);
    let new_debt = total_debt - repay_amount;
    Ok((repay_amount, new_debt, pool.borrow_index))
}

impl CrossRepay {
    pub const DISCRIMINATOR: u8 = 0x18; // 24

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
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
        check_token_program(&accounts[5])?;
        {
            let pool = LendingPool::from_account(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
        }

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Compute repay amounts ────────────────────────────────────────
        let (repay_amount, new_debt, borrow_index) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            compute_repay(pool, pos, self.amount)?
        };

        // ── Token transfer: user → vault ──────────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_amount).invoke()?;

        // ── Update position ───────────────────────────────────────────────
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.borrow_principal = new_debt;
            pos.borrow_index_snapshot = borrow_index;
        }

        // ── Update pool totals ────────────────────────────────────────────
        // Depositor claims are unchanged on a repay; interest already grew
        // total_deposits via accrue_interest.
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
        }

        // ── Clear cross_collateral flags if fully repaid ─────────────────
        if new_debt == 0 {
            {
                let pos = UserPosition::from_account_mut(&accounts[4])?;
                pos.cross_collateral = 0;
                pos.cross_set_id = 0;
                pos.cross_count = 0;
            }
            let trailing = &accounts[6..];
            for acc in trailing {
                check_program_owner(acc, program_id)?;
                let coll_pos = UserPosition::from_account_mut(acc)?;
                if &coll_pos.owner == accounts[0].address() && coll_pos.cross_collateral != 0 {
                    coll_pos.cross_collateral = 0;
                    coll_pos.cross_set_id = 0;
                    coll_pos.cross_count = 0;
                }
            }
        }

        Ok(())
    }
}

