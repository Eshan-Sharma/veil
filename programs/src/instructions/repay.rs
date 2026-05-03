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
  [6..N]  cross-collateral positions to release (writable) — optional

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
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
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

        check_program_owner(&accounts[3], program_id)?;
        check_program_owner(&accounts[4], program_id)?;
        check_token_program(&accounts[5])?;

        let clock = Clock::get()?;
        let (total_debt, borrow_index) = {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
            pool.accrue_interest(clock.unix_timestamp)?;

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

        // Silently cap the repay at the outstanding debt. This matches
        // `cross_repay`'s behaviour and avoids reverting txs that race
        // against borrow-side interest accrual (the user's quoted amount
        // can momentarily exceed the freshly accrued debt).
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
        // total_deposits is NOT incremented: depositor claims are unchanged by
        // a repay. Interest already updated total_deposits via accrue_interest.
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
        }

        // ── Release cross-collateral flags when debt is fully cleared ────
        // Without this, collateral pools that were marked during a CrossBorrow
        // remain locked and the user is forced through CrossWithdraw forever.
        if new_debt == 0 {
            // Clear the flag on the local position too (it may have been set
            // when this position served as cross-collateral elsewhere).
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
