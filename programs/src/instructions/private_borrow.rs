/*!
Privacy-enabled borrow: borrow tokens and update the encrypted debt balance.

Identical LTV / HF / liquidity checks and token flow as `Borrow`.  After
the plaintext state is updated, calls:

  1. `EncryptContext::create_plaintext_u64` — creates an ephemeral ciphertext
     for the borrow `amount`.
  2. `EncryptContext::add_debt` — enc_debt ← enc_debt + amount  (FHE graph).

The health factor check uses plaintext values from `UserPosition`; an async
`EncryptContext::is_healthy` graph is also submitted so off-chain verifiers
can independently verify the HF over encrypted data.

Accounts:
  [0]  user               signer, writable
  [1]  user_token         writable
  [2]  vault              writable
  [3]  pool               writable
  [4]  user_position      writable
  [5]  encrypted_position writable
  [6]  enc_debt_ct        writable  ← EUint64 debt ciphertext account
  [7]  enc_deposit_ct     read-only ← EUint64 deposit ciphertext account
  [8]  amount_ct          writable  ← new ephemeral EUint64 for borrow amount
  [9]  healthy_out_ct     writable  ← output EBool from is_healthy graph
  [10] pool_authority     read-only ← PDA that owns vault
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

Instruction data (after discriminator 0x0A):
  amount:        u64 LE
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
    fhe::context::{verify_ciphertext_owner, EncryptContext, CPI_AUTHORITY_SEED},
    math,
    state::{encrypted_position::ENC_POS_SEED, EncryptedPosition, LendingPool, UserPosition},
};

pub struct PrivateBorrow {
    pub amount: u64,
    pub cpi_auth_bump: u8,
}

impl PrivateBorrow {
    pub const DISCRIMINATOR: u8 = 10;

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
        if accounts.len() < 20 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        if LendingPool::from_account(&accounts[3])?.paused != 0 {
            return Err(LendError::PoolPaused.into());
        }

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Verify ciphertext accounts match EncryptedPosition ────────────
        {
            let enc_pos = EncryptedPosition::from_account(&accounts[5])?;
            enc_pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            enc_pos.verify_debt_ct(&accounts[6])?;
            enc_pos.verify_deposit_ct(&accounts[7])?;

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
        if expected_cpi != *accounts[15].address() {
            return Err(LendError::InvalidPda.into());
        }

        // ── Plaintext risk checks (source of truth) ───────────────────────
        let authority_bump = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;

            let deposit_balance =
                math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
            let existing_debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;

            // LTV cap.
            let max_borrow = math::max_borrowable(deposit_balance, pool.ltv)?;
            if existing_debt.saturating_add(self.amount) > max_borrow {
                return Err(LendError::ExceedsCollateralFactor.into());
            }

            // HF after borrow.
            let hf = math::health_factor(
                deposit_balance,
                existing_debt.saturating_add(self.amount),
                pool.liquidation_threshold,
            )?;
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

        Transfer::new(&accounts[2], &accounts[1], &accounts[10], self.amount)
            .invoke_signed(&[signer])?;

        // ── Update plaintext state ─────────────────────────────────────────
        let (borrow_index, existing_debt) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            pos.verify_binding(accounts[0].address(), accounts[3].address())?;
            let debt = math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?;
            (pool.borrow_index, debt)
        };
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.borrow_principal = existing_debt.saturating_add(self.amount);
            pos.borrow_index_snapshot = borrow_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_add(self.amount);
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

        // Create plaintext ciphertext for the borrow amount.
        ctx.create_plaintext_u64(self.amount, &accounts[8])?;
        verify_ciphertext_owner(&accounts[8])?;

        // enc_debt ← enc_debt + amount  (FHE add graph).
        ctx.add_debt(&accounts[6], &accounts[8], &accounts[6])?;
        verify_ciphertext_owner(&accounts[6])?;

        // Async HF check over encrypted data — result written to healthy_out_ct
        // by the off-chain executor.  Callers / verifiers can read this EBool
        // account to confirm the health factor without seeing position details.
        ctx.is_healthy(&accounts[7], &accounts[6], &accounts[9])?;
        verify_ciphertext_owner(&accounts[9])?;

        Ok(())
    }
}
