/*!
Repay an in-flight flash loan including the fee.

Must be called in the same transaction as FlashBorrow (discriminator 0x06).
Transfers `flash_loan_amount + fee` from the borrower back to the vault.

Fee distribution:
  90 % → LPs  (total_deposits increases)
  10 % → protocol (accumulated_fees increases)

Accounts:
  [0]  borrower        signer, writable
  [1]  borrower_token  writable
  [2]  vault           writable
  [3]  pool            writable
  [4]  token_program

Instruction data (after discriminator 0x07): none
*/

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::LendError,
    math,
    state::{check_program_owner, check_token_program, check_vault, LendingPool},
};

pub struct FlashRepay;

impl FlashRepay {
    pub const DISCRIMINATOR: u8 = 7;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(FlashRepay)
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 5 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        check_program_owner(&accounts[3], program_id)?;
        check_token_program(&accounts[4])?;

        let (loan_amount, fee, lp_fee, protocol_fee) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            check_vault(&accounts[2], pool)?;

            if pool.flash_loan_amount == 0 {
                return Err(LendError::FlashLoanNotActive.into());
            }

            let loan_amount = pool.flash_loan_amount;
            let fee = math::flash_fee(loan_amount, pool.flash_fee_bps)?;
            let (lp_fee, protocol_fee) = math::split_flash_fee(fee);
            (loan_amount, fee, lp_fee, protocol_fee)
        };

        let repay_total = loan_amount
            .checked_add(fee)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // ── Transfer: borrower_token → vault ─────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_total).invoke()?;

        // ── Update pool state ─────────────────────────────────────────────
        // Use checked_add for both fee writes so the LP and protocol updates
        // succeed atomically (or the tx aborts). saturating_add could silently
        // truncate the protocol's share while crediting LPs in full, leaving
        // the pool's bookkeeping inconsistent.
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            // LPs earn their share of the fee.
            pool.total_deposits = pool
                .total_deposits
                .checked_add(lp_fee)
                .ok_or(LendError::MathOverflow)?;
            // Protocol earns its share.
            pool.accumulated_fees = pool
                .accumulated_fees
                .checked_add(protocol_fee)
                .ok_or(LendError::MathOverflow)?;
            // Loan is settled.
            pool.flash_loan_amount = 0;
        }

        Ok(())
    }
}
