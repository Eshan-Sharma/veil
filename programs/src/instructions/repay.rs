/*!
Repay outstanding debt.

currentDebt = principal × (currentBorrowIndex / snapshotIndex)
repayAmount  capped at currentDebt.

Accounts:
  [0]  user              signer, writable
  [1]  user_token        writable
  [2]  vault             writable
  [3]  pool              writable
  [4]  user_position     writable
  [5]  token_program

Instruction data (after discriminator 0x04):
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
    state::{LendingPool, UserPosition},
};

pub struct Repay {
    pub amount: u64,
}

impl Repay {
    pub const DISCRIMINATOR: u8 = 4;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
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
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Compute current debt ──────────────────────────────────────────
        let (total_debt, borrow_index) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;

            if pos.borrow_principal == 0 {
                return Err(LendError::NoBorrow.into());
            }

            let debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;
            (debt, pool.borrow_index)
        };

        let repay_amount = self.amount.min(total_debt);

        // ── Token transfer: user → vault ──────────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_amount).invoke()?;

        // ── Update position ───────────────────────────────────────────────
        let new_debt = total_debt - repay_amount;
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.borrow_principal = new_debt;
            pos.borrow_index_snapshot = borrow_index;
        }

        // ── Update pool totals ────────────────────────────────────────────
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
            pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);
        }

        Ok(())
    }
}
