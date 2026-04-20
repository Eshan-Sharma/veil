/*!
Flash-borrow tokens from the pool.

The caller receives `amount` tokens and MUST include a FlashRepay
instruction later in the same transaction.  The pool records the
in-flight amount; if FlashRepay is never reached the transaction
reverts and no state change persists.

Fee = amount × pool.flash_fee_bps / 10_000  (default 0.09 %).
Fee split on repay: 90 % to LPs, 10 % to protocol.

Accounts:
  [0]  borrower        signer, writable
  [1]  borrower_token  writable
  [2]  vault           writable
  [3]  pool            writable
  [4]  pool_authority  read-only
  [5]  token_program

Instruction data (after discriminator 0x06):
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
    state::LendingPool,
};

pub struct FlashBorrow {
    pub amount: u64,
}

impl FlashBorrow {
    pub const DISCRIMINATOR: u8 = 6;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
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

        // ── Validate and record ───────────────────────────────────────────
        let authority_bump = {
            let pool = LendingPool::from_account(&accounts[3])?;

            // Only one flash loan per pool per transaction.
            if pool.flash_loan_amount != 0 {
                return Err(LendError::FlashLoanActive.into());
            }

            // Pool must have enough free liquidity.
            let available = pool
                .total_deposits
                .saturating_sub(pool.total_borrows)
                .saturating_sub(pool.accumulated_fees);
            if self.amount > available {
                return Err(LendError::InsufficientLiquidity.into());
            }

            pool.authority_bump
        };

        // ── Record the in-flight loan ─────────────────────────────────────
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.flash_loan_amount = self.amount;
        }

        // ── Transfer tokens: vault → borrower ────────────────────────────
        let pool_addr = *accounts[3].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[2], &accounts[1], &accounts[4], self.amount)
            .invoke_signed(&[signer])?;

        Ok(())
    }
}
