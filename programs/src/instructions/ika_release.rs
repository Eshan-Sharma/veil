/*!
Release a dWallet position — transfer the dWallet's authority back to the user.

The position must have no outstanding borrows against it (enforced by checking
the pool's accounting for this user).  On success the `IkaDwalletPosition`
status is set to `RELEASED` and `transfer_dwallet` is CPI'd on the Ika program.

Accounts:
  [0]  user            signer, writable
  [1]  pool            readonly
  [2]  dwallet         writable   – Ika dWallet account (authority transferred back)
  [3]  ika_position    writable   – IkaDwalletPosition PDA
  [4]  caller_program  readonly   – Veil's own program account (needed by Ika CPI)
  [5]  cpi_authority   readonly   – Veil CPI authority PDA
  [6]  ika_program     readonly   – Ika dWallet program account

Instruction data (after discriminator 0x12):
  cpi_authority_bump: u8
*/

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    Address, ProgramResult,
};

use crate::{
    errors::LendError,
    ika::{self, CPI_AUTHORITY_SEED, IKA_PROGRAM_ID},
    state::ika_position::{status, IkaDwalletPosition},
};

pub struct IkaRelease {
    pub cpi_authority_bump: u8,
}

impl IkaRelease {
    pub const DISCRIMINATOR: u8 = 0x12; // 18

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self { cpi_authority_bump: data[0] })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Validate cpi_authority PDA ────────────────────────────────────────
        let expected_cpi = Address::derive_address(
            &[CPI_AUTHORITY_SEED],
            Some(self.cpi_authority_bump),
            program_id,
        );
        if expected_cpi != *accounts[5].address() {
            return Err(LendError::InvalidPda.into());
        }

        // ── Validate ika_program account ──────────────────────────────────────
        if *accounts[6].address() != IKA_PROGRAM_ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // ── Load and validate position ────────────────────────────────────────
        {
            let pos = IkaDwalletPosition::from_account(&accounts[3])?;

            if pos.owner != *accounts[0].address() {
                return Err(LendError::Unauthorized.into());
            }
            if pos.pool != *accounts[1].address() {
                return Err(ProgramError::InvalidAccountData);
            }
            if pos.dwallet != *accounts[2].address() {
                return Err(ProgramError::InvalidAccountData);
            }
            if pos.status != status::ACTIVE {
                return Err(LendError::Unauthorized.into());
            }
        }

        // ── CPI: transfer_dwallet back to user ────────────────────────────────
        let user_addr = *accounts[0].address();
        ika::transfer_dwallet(
            &accounts[6], // ika_program
            &accounts[4], // caller_program (Veil)
            &accounts[5], // cpi_authority
            &accounts[2], // dwallet
            &user_addr,
            self.cpi_authority_bump,
        )?;

        // ── Mark position as released ─────────────────────────────────────────
        {
            let pos = IkaDwalletPosition::from_account_mut(&accounts[3])?;
            pos.status = status::RELEASED;
        }

        Ok(())
    }
}
