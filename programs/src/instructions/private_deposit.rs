/*!
Privacy-enabled deposit: deposit tokens and update the encrypted balance.

Identical token / pool / position accounting as `Deposit`.  After state
is updated, calls the Encrypt program (via `EncryptContext::add_deposit`)
to homomorphically add `amount` to the on-chain enc_deposit ciphertext.

Accounts:
  [0]  user               signer, writable
  [1]  user_token         writable
  [2]  vault              writable
  [3]  pool               writable
  [4]  user_position      writable
  [5]  encrypted_position writable
  [6]  enc_deposit_ct     writable  ← EUint64 ciphertext account
  [7]  amount_ct          writable  ← freshly-created EUint64 holding `amount`
  [8]  system_program
  [9]  token_program
  --- Encrypt program accounts ---
  [10] encrypt_program
  [11] encrypt_config
  [12] encrypt_deposit    writable
  [13] cpi_authority
  [14] caller_program
  [15] network_enc_key
  [16] event_authority

Instruction data (after discriminator 0x09):
  amount:        u64 LE
  cpi_auth_bump: u8
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
    fhe::context::EncryptContext,
    math,
    state::{EncryptedPosition, LendingPool, UserPosition},
};

pub struct PrivateDeposit {
    pub amount: u64,
    pub cpi_auth_bump: u8,
}

impl PrivateDeposit {
    pub const DISCRIMINATOR: u8 = 9;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
            cpi_auth_bump: data[8],
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 17 {
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

        // ── Verify encrypted position ciphertext accounts ─────────────────
        {
            let enc_pos = EncryptedPosition::from_account(&accounts[5])?;
            enc_pos.verify_deposit_ct(&accounts[6])?;
        }

        // ── Compute shares ────────────────────────────────────────────────
        let supply_index = LendingPool::from_account(&accounts[3])?.supply_index;
        let shares = math::deposit_to_shares(self.amount, supply_index)?;

        // ── Token transfer: user_token → vault ────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], self.amount).invoke()?;

        // ── Update plaintext state (source of truth for HF enforcement) ───
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.deposit_shares = pos.deposit_shares.saturating_add(shares);
            pos.deposit_index_snapshot = supply_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_deposits = pool.total_deposits.saturating_add(self.amount);
        }

        // ── Update encrypted state via Encrypt CPI ────────────────────────
        // Step 1: create a plaintext ciphertext account for `amount`.
        let ctx = EncryptContext {
            encrypt_program:        &accounts[10],
            config:                 &accounts[11],
            deposit:                &accounts[12],
            cpi_authority:          &accounts[13],
            caller_program:         &accounts[14],
            network_encryption_key: &accounts[15],
            payer:                  &accounts[0],
            event_authority:        &accounts[16],
            system_program:         &accounts[8],
            cpi_authority_bump:     self.cpi_auth_bump,
        };
        ctx.create_plaintext_u64_stub(self.amount, &accounts[7])?;

        // Step 2: enc_deposit ← enc_deposit + amount  (FHE add graph)
        ctx.add_deposit(&accounts[6], &accounts[7], &accounts[6])?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_amount_and_bump() {
        let mut d = 250_000u64.to_le_bytes().to_vec();
        d.push(123);
        let ix = PrivateDeposit::from_data(&d).unwrap();
        assert_eq!(ix.amount, 250_000);
        assert_eq!(ix.cpi_auth_bump, 123);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(PrivateDeposit::from_data(&[0u8; 8]).is_err());
    }

    #[test]
    fn discriminator_is_nine() {
        assert_eq!(PrivateDeposit::DISCRIMINATOR, 9);
    }
}
