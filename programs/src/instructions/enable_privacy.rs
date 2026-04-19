/*!
Enable privacy on an existing position.

Creates an `EncryptedPosition` PDA and initialises two ciphertext accounts
(enc_deposit, enc_debt) seeded with the current plaintext values from
`UserPosition`.  After this instruction, the private deposit / borrow /
repay / withdraw variants keep the ciphertext accounts in sync.

The `UserPosition` is NOT removed — it continues to serve as the plaintext
source of truth for health-factor enforcement.

Accounts:
  [0]  user               signer, writable
  [1]  user_position      read-only
  [2]  encrypted_position writable (new PDA: seeds = ["enc_pos", user, pool])
  [3]  enc_deposit_ct     writable (new ciphertext account — owned by Encrypt program)
  [4]  enc_debt_ct        writable (new ciphertext account — owned by Encrypt program)
  [5]  pool               read-only
  --- Encrypt program accounts (required once SDK is active) ---
  [6]  encrypt_program    read-only
  [7]  encrypt_config     read-only
  [8]  encrypt_deposit    writable
  [9]  cpi_authority      read-only (PDA)
  [10] caller_program     read-only
  [11] network_enc_key    read-only
  [12] event_authority    read-only
  [13] system_program     read-only

Instruction data (after discriminator 0x08):
  enc_pos_bump:    u8
  cpi_auth_bump:   u8
*/

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use crate::{
    errors::LendError,
    fhe::context::EncryptContext,
    state::{EncryptedPosition, LendingPool, UserPosition},
};

pub struct EnablePrivacy {
    pub enc_pos_bump: u8,
    pub cpi_auth_bump: u8,
}

impl EnablePrivacy {
    pub const DISCRIMINATOR: u8 = 8;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            enc_pos_bump: data[0],
            cpi_auth_bump: data[1],
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 14 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Read current plaintext position ───────────────────────────────
        let (deposit_balance, debt_balance, pool_addr) = {
            let pool = LendingPool::from_account(&accounts[5])?;

            // Accrue so the seed values are up to date.
            let clock = Clock::get()?;
            {
                let pool = LendingPool::from_account_mut(&accounts[5])?;
                pool.accrue_interest(clock.unix_timestamp)?;
            }
            let pool = LendingPool::from_account(&accounts[5])?;
            let pos = UserPosition::from_account(&accounts[1])?;

            let deposit = crate::math::current_deposit_balance(
                pos.deposit_shares,
                pool.supply_index,
            )?;
            let debt = crate::math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;
            (deposit, debt, *accounts[5].address())
        };

        // ── Set up Encrypt CPI context ────────────────────────────────────
        let ctx = EncryptContext {
            encrypt_program: &accounts[6],
            config: &accounts[7],
            deposit: &accounts[8],
            cpi_authority: &accounts[9],
            caller_program: &accounts[10],
            network_encryption_key: &accounts[11],
            payer: &accounts[0],
            event_authority: &accounts[12],
            system_program: &accounts[13],
            cpi_authority_bump: self.cpi_auth_bump,
        };

        // ── Initialise ciphertext accounts via Encrypt CPI ────────────────
        // Creates enc_deposit_ct with value = current deposit balance.
        ctx.create_plaintext_u64_stub(deposit_balance, &accounts[3])?;
        // Creates enc_debt_ct with value = current debt balance.
        ctx.create_plaintext_u64_stub(debt_balance, &accounts[4])?;

        // ── Create EncryptedPosition account ──────────────────────────────
        let enc_deposit_key = *accounts[3].address().as_array();
        let enc_debt_key = *accounts[4].address().as_array();
        let user_addr = *accounts[0].address();

        EncryptedPosition::init(
            &accounts[2],
            &user_addr,
            &pool_addr,
            enc_deposit_key,
            enc_debt_key,
            self.enc_pos_bump,
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_bumps() {
        let d = [0x42u8, 0xFFu8];
        let ix = EnablePrivacy::from_data(&d).unwrap();
        assert_eq!(ix.enc_pos_bump, 0x42);
        assert_eq!(ix.cpi_auth_bump, 0xFF);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(EnablePrivacy::from_data(&[0u8; 1]).is_err());
        assert!(EnablePrivacy::from_data(&[]).is_err());
    }

    #[test]
    fn from_data_ignores_extra_bytes() {
        let d = [1u8, 2u8, 99u8, 99u8];
        let ix = EnablePrivacy::from_data(&d).unwrap();
        assert_eq!(ix.enc_pos_bump, 1);
        assert_eq!(ix.cpi_auth_bump, 2);
    }

    #[test]
    fn discriminator_is_eight() {
        assert_eq!(EnablePrivacy::DISCRIMINATOR, 8);
    }
}
