/*!
Privacy-enabled repay: repay debt and update the encrypted debt balance.

Identical repay logic as `Repay`.  After plaintext state is settled:

  1. Creates an ephemeral ciphertext for the repay amount.
  2. Calls `EncryptContext::sub_debt` — enc_debt ← enc_debt - repay_amount.

Accounts:
  [0]  user               signer, writable
  [1]  user_token         writable
  [2]  vault              writable
  [3]  pool               writable
  [4]  user_position      writable
  [5]  encrypted_position writable
  [6]  enc_debt_ct        writable  ← EUint64 debt ciphertext account
  [7]  amount_ct          writable  ← new ephemeral EUint64 for repay amount
  [8]  token_program
  --- Encrypt program accounts ---
  [9]  encrypt_program
  [10] encrypt_config
  [11] encrypt_deposit    writable
  [12] cpi_authority
  [13] caller_program
  [14] network_enc_key
  [15] event_authority
  [16] system_program

Instruction data (after discriminator 0x0B):
  amount:        u64 LE   (capped at current debt)
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
    fhe::context::{verify_ciphertext_owner, EncryptContext, CPI_AUTHORITY_SEED},
    math,
    state::{encrypted_position::ENC_POS_SEED, EncryptedPosition, LendingPool, UserPosition},
};

pub struct PrivateRepay {
    pub amount: u64,
    pub cpi_auth_bump: u8,
}

impl PrivateRepay {
    pub const DISCRIMINATOR: u8 = 11;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
            cpi_auth_bump: data[8],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
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

        // ── Verify ciphertext account ─────────────────────────────────────
        {
            let enc_pos = EncryptedPosition::from_account(&accounts[5])?;
            enc_pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            enc_pos.verify_debt_ct(&accounts[6])?;

            // Re-derive the EncryptedPosition PDA from its stored bump.
            let expected_enc_pos = Address::derive_address(
                &[
                    ENC_POS_SEED,
                    accounts[0].address().as_ref(),
                    accounts[3].address().as_ref(),
                ],
                Some(enc_pos.bump),
                program_id,
            );
            if expected_enc_pos != *accounts[5].address() {
                return Err(LendError::InvalidPda.into());
            }
        }

        // ── Validate cpi_authority bump matches the supplied PDA address ────
        let expected_cpi = Address::derive_address(
            &[CPI_AUTHORITY_SEED],
            Some(self.cpi_auth_bump),
            program_id,
        );
        if expected_cpi != *accounts[12].address() {
            return Err(LendError::InvalidPda.into());
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

        // ── Token transfer: user_token → vault ────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_amount).invoke()?;

        // ── Update plaintext state ────────────────────────────────────────
        let new_debt = total_debt - repay_amount;
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.borrow_principal = new_debt;
            pos.borrow_index_snapshot = borrow_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
            pool.total_deposits = pool.total_deposits.saturating_add(repay_amount);
        }

        // ── Update encrypted state via Encrypt CPI ────────────────────────
        let ctx = EncryptContext {
            encrypt_program:        &accounts[9],
            config:                 &accounts[10],
            deposit:                &accounts[11],
            cpi_authority:          &accounts[12],
            caller_program:         &accounts[13],
            network_encryption_key: &accounts[14],
            payer:                  &accounts[0],
            event_authority:        &accounts[15],
            system_program:         &accounts[16],
            cpi_authority_bump:     self.cpi_auth_bump,
        };

        // Create a plaintext ciphertext for the actual repay amount.
        ctx.create_plaintext_u64(repay_amount, &accounts[7])?;
        verify_ciphertext_owner(&accounts[7])?;

        // enc_debt ← enc_debt - repay_amount  (saturates at 0 inside FHE).
        ctx.sub_debt(&accounts[6], &accounts[7], &accounts[6])?;
        verify_ciphertext_owner(&accounts[6])?;

        Ok(())
    }
}
