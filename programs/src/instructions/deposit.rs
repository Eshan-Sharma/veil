/*!
Deposit tokens; mint supply shares.

shares = amount × WAD / supplyIndex

Accounts:
  [0]  user             signer, writable
  [1]  user_token       writable  – depositor's token account
  [2]  vault            writable  – pool vault
  [3]  pool             writable  – LendingPool PDA
  [4]  user_position    writable  – UserPosition PDA (created if needed)
  [5]  system_program
  [6]  token_program

Instruction data (after discriminator 0x01):
  amount:        u64 LE
  position_bump: u8
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::LendError,
    math,
    state::{LendingPool, UserPosition},
};

pub struct Deposit {
    pub amount: u64,
    pub position_bump: u8,
}

impl Deposit {
    pub const DISCRIMINATOR: u8 = 1;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
            position_bump: data[8],
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

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            if pool.paused != 0 {
                return Err(LendError::PoolPaused.into());
            }
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Create UserPosition if absent ─────────────────────────────────
        let bump_bytes = [self.position_bump];
        let pool_addr = *accounts[3].address();
        let user_addr = *accounts[0].address();

        if accounts[4].lamports() == 0 {
            let derived = Address::derive_address(
                &[b"position", pool_addr.as_ref(), user_addr.as_ref()],
                Some(self.position_bump),
                program_id,
            );
            if derived != *accounts[4].address() {
                return Err(LendError::InvalidPda.into());
            }

            let rent = Rent::get()?;
            let lamports = rent.try_minimum_balance(UserPosition::SIZE)?;

            let seeds: [Seed; 4] = [
                Seed::from(b"position" as &[u8]),
                Seed::from(pool_addr.as_ref()),
                Seed::from(user_addr.as_ref()),
                Seed::from(&bump_bytes as &[u8]),
            ];
            let signer = Signer::from(seeds.as_slice());

            CreateAccount {
                from: &accounts[0],
                to: &accounts[4],
                lamports,
                space: UserPosition::SIZE as u64,
                owner: program_id,
            }
            .invoke_signed(&[signer])?;

            // Capture current indices BEFORE initializing position.
            let (si, bi) = {
                let pool = LendingPool::from_account(&accounts[3])?;
                (pool.supply_index, pool.borrow_index)
            };

            UserPosition::init(
                &accounts[4],
                &user_addr,
                &pool_addr,
                self.position_bump,
                si,
                bi,
            )?;
        }

        // ── Compute shares ────────────────────────────────────────────────
        let supply_index = LendingPool::from_account(&accounts[3])?.supply_index;
        let shares = math::deposit_to_shares(self.amount, supply_index)?;

        // ── Token transfer: user → vault ──────────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], self.amount).invoke()?;

        // ── Update state ──────────────────────────────────────────────────
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.deposit_shares = pos.deposit_shares.saturating_add(shares);
            pos.deposit_index_snapshot = supply_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_deposits = pool.total_deposits.saturating_add(self.amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_data(amount: u64, bump: u8) -> Vec<u8> {
        let mut d = amount.to_le_bytes().to_vec();
        d.push(bump);
        d
    }

    #[test]
    fn from_data_parses_correctly() {
        let d = make_data(500_000, 254);
        let ix = Deposit::from_data(&d).unwrap();
        assert_eq!(ix.amount, 500_000);
        assert_eq!(ix.position_bump, 254);
    }

    #[test]
    fn from_data_zero_amount() {
        let d = make_data(0, 1);
        let ix = Deposit::from_data(&d).unwrap();
        assert_eq!(ix.amount, 0);
    }

    #[test]
    fn from_data_max_amount() {
        let d = make_data(u64::MAX, 255);
        let ix = Deposit::from_data(&d).unwrap();
        assert_eq!(ix.amount, u64::MAX);
        assert_eq!(ix.position_bump, 255);
    }

    #[test]
    fn from_data_little_endian_amount() {
        // 0x0102_0000_0000_0000 = 513 in little-endian
        let d = [1u8, 2, 0, 0, 0, 0, 0, 0, 7];
        let ix = Deposit::from_data(&d).unwrap();
        assert_eq!(ix.amount, 0x0000_0000_0000_0201);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(Deposit::from_data(&[1, 2, 3, 4, 5, 6, 7, 8]).is_err()); // 8 bytes, need 9
    }

    #[test]
    fn from_data_empty_returns_err() {
        assert!(Deposit::from_data(&[]).is_err());
    }

    #[test]
    fn discriminator_is_one() {
        assert_eq!(Deposit::DISCRIMINATOR, 1);
    }
}
