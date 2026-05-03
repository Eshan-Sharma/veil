/*!
Request a cross-chain signature via the dWallet MPC network.

Creates a `MessageApproval` PDA on the Ika program; the MPC network will later
fill in the signature.  Callers poll the `MessageApproval` account status
to learn when signing is complete.

The dWallet position must be ACTIVE (not released or liquidated).

Accounts:
  [0]  user             signer, writable   – fee payer
  [1]  message_approval writable           – new MessageApproval PDA (on Ika program)
  [2]  dwallet          readonly           – Ika dWallet account
  [3]  ika_position     readonly           – IkaDwalletPosition PDA
  [4]  caller_program   readonly           – Veil program account
  [5]  cpi_authority    readonly           – Veil CPI authority PDA
  [6]  system_program
  [7]  ika_program      readonly           – Ika dWallet program

Instruction data (after discriminator 0x13):
  message_hash:       [u8; 32]
  user_pubkey:        [u8; 32]  – the key that initiated the cross-chain tx
  signature_scheme:   u8
  msg_approval_bump:  u8
  cpi_authority_bump: u8
  Total = 67 bytes
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

pub struct IkaSign {
    pub message_hash:        [u8; 32],
    pub user_pubkey:         [u8; 32],
    pub signature_scheme:    u8,
    pub msg_approval_bump:   u8,
    pub cpi_authority_bump:  u8,
}

impl IkaSign {
    pub const DISCRIMINATOR: u8 = 0x13; // 19

    /// Data layout after discriminator:
    ///   32 + 32 + 1 + 1 + 1 = 67 bytes
    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 67 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            message_hash:        data[0..32].try_into().unwrap(),
            user_pubkey:         data[32..64].try_into().unwrap(),
            signature_scheme:    data[64],
            msg_approval_bump:   data[65],
            cpi_authority_bump:  data[66],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 8 {
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
        // Defence-in-depth (audit 05, finding I-5): the CPI authority MUST be
        // a Veil-owned PDA. If Veil is upgraded and the seed is reused with
        // different ownership semantics, this guard catches the mismatch
        // before the IKA CPI fires.
        if accounts[5].owner() != program_id {
            return Err(LendError::InvalidAccountOwner.into());
        }

        // ── Validate ika_program account ──────────────────────────────────────
        if *accounts[7].address() != IKA_PROGRAM_ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // ── Validate the position ─────────────────────────────────────────────
        {
            let pos = IkaDwalletPosition::from_account(&accounts[3])?;

            if pos.owner != *accounts[0].address() {
                return Err(LendError::Unauthorized.into());
            }
            if pos.dwallet != *accounts[2].address() {
                return Err(ProgramError::InvalidAccountData);
            }
            if pos.status != status::ACTIVE {
                return Err(LendError::Unauthorized.into());
            }
        }

        // ── CPI: approve_message ──────────────────────────────────────────────
        ika::approve_message(
            &accounts[7], // ika_program
            &accounts[1], // message_approval
            &accounts[2], // dwallet
            &accounts[4], // caller_program (Veil)
            &accounts[5], // cpi_authority
            &accounts[0], // payer (user)
            &accounts[6], // system_program
            &self.message_hash,
            &self.user_pubkey,
            self.signature_scheme,
            self.msg_approval_bump,
            self.cpi_authority_bump,
        )?;

        Ok(())
    }
}
