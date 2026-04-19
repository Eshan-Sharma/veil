/*!
Initialize a new lending pool.

Accounts:
  [0]  payer           signer, writable
  [1]  authority       signer
  [2]  pool            writable  – PDA: ["pool", token_mint, pool_bump]
  [3]  token_mint      read-only
  [4]  vault           read-only  – pre-created SPL token account
  [5]  system_program

Instruction data (after discriminator 0x00):
  pool_bump:       u8
  authority_bump:  u8
  vault_bump:      u8
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{errors::LendError, state::LendingPool};
use pinocchio::sysvars::clock::Clock;

pub struct Initialize {
    pub pool_bump: u8,
    pub authority_bump: u8,
    pub vault_bump: u8,
}

impl Initialize {
    pub const DISCRIMINATOR: u8 = 0;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 3 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            pool_bump: data[0],
            authority_bump: data[1],
            vault_bump: data[2],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
            return Err(LendError::InvalidInstructionData.into());
        }

        let payer = &accounts[0];
        let authority = &accounts[1];
        let pool = &accounts[2];
        let token_mint = &accounts[3];
        let vault = &accounts[4];

        // ── Signers ───────────────────────────────────────────────────────
        if !payer.is_signer() || !authority.is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Verify pool PDA ───────────────────────────────────────────────
        let derived = Address::derive_address(
            &[b"pool", token_mint.address().as_ref()],
            Some(self.pool_bump),
            program_id,
        );
        if derived != *pool.address() {
            return Err(LendError::InvalidPda.into());
        }
        let pool_bump_bytes = [self.pool_bump];

        // ── Create pool account ───────────────────────────────────────────
        let rent = Rent::get()?;
        let lamports = rent.try_minimum_balance(LendingPool::SIZE)?;

        let seeds: [Seed; 3] = [
            Seed::from(b"pool" as &[u8]),
            Seed::from(token_mint.address().as_ref()),
            Seed::from(&pool_bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        CreateAccount {
            from: payer,
            to: pool,
            lamports,
            space: LendingPool::SIZE as u64,
            owner: program_id,
        }
        .invoke_signed(&[signer])?;

        // ── Initialise pool state ─────────────────────────────────────────
        let clock = Clock::get()?;
        LendingPool::init(
            pool,
            authority.address(),
            token_mint.address(),
            vault.address(),
            clock.unix_timestamp,
            self.authority_bump,
            self.pool_bump,
            self.vault_bump,
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_three_bytes() {
        let data = [7u8, 13u8, 42u8];
        let ix = Initialize::from_data(&data).unwrap();
        assert_eq!(ix.pool_bump, 7);
        assert_eq!(ix.authority_bump, 13);
        assert_eq!(ix.vault_bump, 42);
    }

    #[test]
    fn from_data_uses_only_first_three_bytes() {
        // Extra bytes beyond 3 are ignored
        let data = [1u8, 2u8, 3u8, 99u8, 100u8];
        let ix = Initialize::from_data(&data).unwrap();
        assert_eq!(ix.pool_bump, 1);
        assert_eq!(ix.authority_bump, 2);
        assert_eq!(ix.vault_bump, 3);
    }

    #[test]
    fn from_data_empty_returns_err() {
        assert!(Initialize::from_data(&[]).is_err());
    }

    #[test]
    fn from_data_one_byte_returns_err() {
        assert!(Initialize::from_data(&[1]).is_err());
    }

    #[test]
    fn from_data_two_bytes_returns_err() {
        assert!(Initialize::from_data(&[1, 2]).is_err());
    }

    #[test]
    fn discriminator_is_zero() {
        assert_eq!(Initialize::DISCRIMINATOR, 0);
    }

    #[test]
    fn from_data_max_bump_values() {
        let data = [255u8, 255u8, 255u8];
        let ix = Initialize::from_data(&data).unwrap();
        assert_eq!(ix.pool_bump, 255);
        assert_eq!(ix.authority_bump, 255);
        assert_eq!(ix.vault_bump, 255);
    }
}
