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
        let authority_bump = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;

            let deposit_balance =
                math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
            let existing_debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;

            // LTV cap.
            let max_borrow = math::max_borrowable(deposit_balance, pool.ltv)?;
            let debt_after = existing_debt.saturating_add(self.amount);
            if debt_after > max_borrow {
                return Err(LendError::ExceedsCollateralFactor.into());
            }

            // HF after borrow.
            let hf = math::health_factor(deposit_balance, debt_after, pool.liquidation_threshold)?;
            if hf < math::WAD {
                return Err(LendError::Undercollateralised.into());
            }

            // Vault liquidity.
            let available = pool
                .total_deposits
                .saturating_sub(pool.total_borrows)
                .saturating_sub(pool.accumulated_fees);
            if self.amount > available {
                return Err(LendError::InsufficientLiquidity.into());
            }

            pool.authority_bump
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
        let (borrow_index, existing_debt) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            let debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;
            (pool.borrow_index, debt)
        };
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            // Settle accrued interest into principal, then add new borrow.
            pos.borrow_principal = existing_debt.saturating_add(self.amount);
            pos.borrow_index_snapshot = borrow_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_add(self.amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_amount() {
        let amount: u64 = 1_234_567;
        let d = amount.to_le_bytes();
        let ix = Borrow::from_data(&d).unwrap();
        assert_eq!(ix.amount, 1_234_567);
    }

    #[test]
    fn from_data_max_amount() {
        let d = u64::MAX.to_le_bytes();
        let ix = Borrow::from_data(&d).unwrap();
        assert_eq!(ix.amount, u64::MAX);
    }

    #[test]
    fn from_data_zero_amount() {
        let d = 0u64.to_le_bytes();
        let ix = Borrow::from_data(&d).unwrap();
        assert_eq!(ix.amount, 0);
    }

    #[test]
    fn from_data_seven_bytes_returns_err() {
        assert!(Borrow::from_data(&[0u8; 7]).is_err());
    }

    #[test]
    fn from_data_empty_returns_err() {
        assert!(Borrow::from_data(&[]).is_err());
    }

    #[test]
    fn from_data_extra_bytes_ignored() {
        let mut d = 99u64.to_le_bytes().to_vec();
        d.extend_from_slice(&[255; 8]); // extra bytes ignored
        let ix = Borrow::from_data(&d).unwrap();
        assert_eq!(ix.amount, 99);
    }

    #[test]
    fn discriminator_is_three() {
        assert_eq!(Borrow::DISCRIMINATOR, 3);
    }
}
