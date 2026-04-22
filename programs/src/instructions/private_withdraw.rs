/*!
Privacy-enabled withdraw: withdraw tokens and update the encrypted deposit balance.

Identical HF / liquidity checks and token flow as `Withdraw`.  After
plaintext state is updated:

  1. Creates an ephemeral ciphertext for the withdrawn token amount.
  2. Calls `EncryptContext::sub_deposit` — enc_deposit ← enc_deposit - amount.
  3. Submits an async `EncryptContext::is_healthy` graph so verifiers can
     confirm the post-withdrawal HF over encrypted data.

Accounts:
  [0]  user               signer, writable
  [1]  user_token         writable
  [2]  vault              writable
  [3]  pool               writable
  [4]  user_position      writable
  [5]  encrypted_position writable
  [6]  enc_deposit_ct     writable  ← EUint64 deposit ciphertext account
  [7]  enc_debt_ct        read-only ← EUint64 debt ciphertext account
  [8]  amount_ct          writable  ← new ephemeral EUint64 for withdrawn amount
  [9]  healthy_out_ct     writable  ← output EBool from is_healthy graph
  [10] pool_authority     read-only
  [11] token_program
  --- Encrypt program accounts ---
  [12] encrypt_program
  [13] encrypt_config
  [14] encrypt_deposit    writable
  [15] cpi_authority
  [16] caller_program
  [17] network_enc_key
  [18] event_authority
  [19] system_program

Instruction data (after discriminator 0x0C):
  shares:        u64 LE
  cpi_auth_bump: u8
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
    fhe::context::EncryptContext,
    math,
    state::{EncryptedPosition, LendingPool, UserPosition},
};

pub struct PrivateWithdraw {
    pub shares: u64,
    pub cpi_auth_bump: u8,
}

impl PrivateWithdraw {
    pub const DISCRIMINATOR: u8 = 12;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            shares: u64::from_le_bytes(data[..8].try_into().unwrap()),
            cpi_auth_bump: data[8],
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 20 {
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

        // ── Verify ciphertext accounts ────────────────────────────────────
        {
            let enc_pos = EncryptedPosition::from_account(&accounts[5])?;
            enc_pos.verify_deposit_ct(&accounts[6])?;
            enc_pos.verify_debt_ct(&accounts[7])?;
        }

        // ── Compute withdrawal amount and check HF (plaintext) ────────────
        let (token_amount, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;

            if pos.deposit_shares < self.shares {
                return Err(LendError::ExceedsDepositBalance.into());
            }

            let token_amount = math::current_deposit_balance(self.shares, pool.supply_index)?;

            let available = pool
                .total_deposits
                .saturating_sub(pool.total_borrows)
                .saturating_sub(pool.accumulated_fees);
            if token_amount > available {
                return Err(LendError::InsufficientLiquidity.into());
            }

            let remaining_shares = pos.deposit_shares - self.shares;
            let remaining_deposit =
                math::current_deposit_balance(remaining_shares, pool.supply_index)?;
            let debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;
            if debt > 0 {
                let hf =
                    math::health_factor(remaining_deposit, debt, pool.liquidation_threshold)?;
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

        Transfer::new(&accounts[2], &accounts[1], &accounts[10], token_amount)
            .invoke_signed(&[signer])?;

        // ── Update plaintext state ────────────────────────────────────────
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

        // ── Update encrypted state via Encrypt CPI ────────────────────────
        let ctx = EncryptContext {
            encrypt_program:        &accounts[12],
            config:                 &accounts[13],
            deposit:                &accounts[14],
            cpi_authority:          &accounts[15],
            caller_program:         &accounts[16],
            network_encryption_key: &accounts[17],
            payer:                  &accounts[0],
            event_authority:        &accounts[18],
            system_program:         &accounts[19],
            cpi_authority_bump:     self.cpi_auth_bump,
        };

        // Create a plaintext ciphertext for the withdrawn token amount.
        ctx.create_plaintext_u64_stub(token_amount, &accounts[8])?;

        // enc_deposit ← enc_deposit - token_amount  (saturates at 0).
        ctx.sub_deposit(&accounts[6], &accounts[8], &accounts[6])?;

        // Async HF check over encrypted data.
        ctx.is_healthy(&accounts[6], &accounts[7], &accounts[9])?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_data_parses_shares_and_bump() {
        let mut d = 10_000u64.to_le_bytes().to_vec();
        d.push(99);
        let ix = PrivateWithdraw::from_data(&d).unwrap();
        assert_eq!(ix.shares, 10_000);
        assert_eq!(ix.cpi_auth_bump, 99);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(PrivateWithdraw::from_data(&[0u8; 8]).is_err());
    }

    #[test]
    fn discriminator_is_twelve() {
        assert_eq!(PrivateWithdraw::DISCRIMINATOR, 12);
    }
}
