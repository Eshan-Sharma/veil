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
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct CrossRepay {
    pub amount: u64,
}

#[inline(always)]
fn compute_repay(
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

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?;
        check_program_owner(&accounts[4], program_id)?;

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
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
            pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);
        }

        // ── Clear cross_collateral flags if fully repaid ─────────────────
        if new_debt == 0 {
            let trailing = &accounts[6..];
            for acc in trailing {
                check_program_owner(acc, program_id)?;
                let coll_pos = UserPosition::from_account_mut(acc)?;
                if &coll_pos.owner == accounts[0].address() && coll_pos.cross_collateral != 0 {
                    coll_pos.cross_collateral = 0;
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;

    fn pool() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool
    }

    fn position(borrow_principal: u64) -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.borrow_principal = borrow_principal;
        pos.deposit_index_snapshot = WAD;
        pos.borrow_index_snapshot = WAD;
        pos
    }

    #[test]
    fn compute_repay_rejects_no_debt() {
        let p = pool();
        let pos = position(0);
        assert_eq!(compute_repay(&p, &pos, 100), Err(LendError::NoBorrow.into()));
    }

    #[test]
    fn compute_repay_caps_at_total_debt() {
        let p = pool();
        let pos = position(500);
        let (repay, new_debt, _) = compute_repay(&p, &pos, 1_000).unwrap();
        assert_eq!(repay, 500);
        assert_eq!(new_debt, 0);
    }

    #[test]
    fn compute_repay_partial() {
        let p = pool();
        let pos = position(1_000);
        let (repay, new_debt, _) = compute_repay(&p, &pos, 400).unwrap();
        assert_eq!(repay, 400);
        assert_eq!(new_debt, 600);
    }

    // ── Positive: repay exact debt ──────────────────────────────────────

    #[test]
    fn compute_repay_exact() {
        let p = pool();
        let pos = position(1_000);
        let (repay, new_debt, _) = compute_repay(&p, &pos, 1_000).unwrap();
        assert_eq!(repay, 1_000);
        assert_eq!(new_debt, 0);
    }

    // ── Positive: repay with accrued interest ───────────────────────────

    #[test]
    fn compute_repay_with_accrued_interest() {
        let mut p = pool();
        p.borrow_index = WAD + WAD / 10; // 1.1x (10% interest accrued)
        let pos = position(1_000); // principal = 1000, actual debt = 1100
        let (repay, new_debt, idx) = compute_repay(&p, &pos, 2_000).unwrap();
        assert_eq!(repay, 1_100); // capped at actual debt
        assert_eq!(new_debt, 0);
        assert_eq!(idx, WAD + WAD / 10);
    }

    // ── Negative: zero principal ────────────────────────────────────────

    #[test]
    fn compute_repay_zero_principal_rejected() {
        let p = pool();
        let pos = position(0);
        assert_eq!(compute_repay(&p, &pos, 100), Err(LendError::NoBorrow.into()));
    }

    // ── Positive: borrow index snapshot updated ─────────────────────────

    #[test]
    fn compute_repay_returns_current_borrow_index() {
        let mut p = pool();
        p.borrow_index = WAD * 2; // double
        let pos = position(500); // debt = 500 * 2 = 1000
        let (_, _, idx) = compute_repay(&p, &pos, 500).unwrap();
        assert_eq!(idx, WAD * 2);
    }
}
