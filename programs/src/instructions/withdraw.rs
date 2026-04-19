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
    state::{LendingPool, UserPosition},
};

pub struct Withdraw {
    pub shares: u64,
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

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.shares == 0 {
            return Err(LendError::ZeroAmount.into());
        }

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

            if pos.deposit_shares < self.shares {
                return Err(LendError::ExceedsDepositBalance.into());
            }

            let token_amount = math::current_deposit_balance(self.shares, pool.supply_index)?;

            // Vault liquidity check.
            let available = pool
                .total_deposits
                .saturating_sub(pool.total_borrows)
                .saturating_sub(pool.accumulated_fees);
            if token_amount > available {
                return Err(LendError::InsufficientLiquidity.into());
            }

            // Health factor after withdrawal.
            let remaining_shares = pos.deposit_shares - self.shares;
            let remaining_deposit =
                math::current_deposit_balance(remaining_shares, pool.supply_index)?;
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

            (token_amount, pool.authority_bump)
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
            pos.deposit_shares = pos.deposit_shares.saturating_sub(self.shares);
            pos.deposit_index_snapshot = supply_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_deposits = pool.total_deposits.saturating_sub(token_amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_shares() {
        let d = 999_000u64.to_le_bytes();
        let ix = Withdraw::from_data(&d).unwrap();
        assert_eq!(ix.shares, 999_000);
    }

    #[test]
    fn from_data_max_shares() {
        let d = u64::MAX.to_le_bytes();
        let ix = Withdraw::from_data(&d).unwrap();
        assert_eq!(ix.shares, u64::MAX);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(Withdraw::from_data(&[0u8; 7]).is_err());
    }

    #[test]
    fn from_data_empty_returns_err() {
        assert!(Withdraw::from_data(&[]).is_err());
    }

    #[test]
    fn discriminator_is_two() {
        assert_eq!(Withdraw::DISCRIMINATOR, 2);
    }
}
