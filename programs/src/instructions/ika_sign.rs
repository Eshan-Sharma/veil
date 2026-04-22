/*!
Request a cross-chain signature via the dWallet MPC network.

Creates a `MessageApproval` PDA on the Ika program; the MPC network will later
fill in the signature.  Callers poll the `MessageApproval` account status
(offset 172, 0=Pending → 1=Signed) to learn when signing is complete.

The dWallet position must be ACTIVE (not released or liquidated).

Accounts:
  [0]  user             signer, writable   – fee payer
  [1]  coordinator      readonly           – Ika DWalletCoordinator PDA
  [2]  message_approval writable           – new MessageApproval PDA (on Ika program)
  [3]  dwallet          readonly           – Ika dWallet account
  [4]  ika_position     readonly           – IkaDwalletPosition PDA
  [5]  caller_program   readonly           – Veil program account
  [6]  cpi_authority    readonly           – Veil CPI authority PDA
  [7]  system_program
  [8]  ika_program      readonly           – Ika dWallet program

Instruction data (after discriminator 0x13):
  message_digest:          [u8; 32]
  message_metadata_digest: [u8; 32]
  user_pubkey:             [u8; 32]  – the key that initiated the cross-chain tx
  signature_scheme:        u16 LE
  msg_approval_bump:       u8
  cpi_authority_bump:      u8
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
    pub message_digest:          [u8; 32],
    pub message_metadata_digest: [u8; 32],
    pub user_pubkey:             [u8; 32],
    pub signature_scheme:        u16,
    pub msg_approval_bump:       u8,
    pub cpi_authority_bump:      u8,
}

impl IkaSign {
    pub const DISCRIMINATOR: u8 = 0x13; // 19

    /// Data layout after discriminator:
    ///   32 + 32 + 32 + 2 + 1 + 1 = 100 bytes
    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 100 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            message_digest:          data[0..32].try_into().unwrap(),
            message_metadata_digest: data[32..64].try_into().unwrap(),
            user_pubkey:             data[64..96].try_into().unwrap(),
            signature_scheme:        u16::from_le_bytes(data[96..98].try_into().unwrap()),
            msg_approval_bump:       data[98],
            cpi_authority_bump:      data[99],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 9 {
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
        if expected_cpi != *accounts[6].address() {
            return Err(LendError::InvalidPda.into());
        }

        // ── Validate ika_program account ──────────────────────────────────────
        if *accounts[8].address() != IKA_PROGRAM_ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // ── Validate the position ─────────────────────────────────────────────
        {
            let pos = IkaDwalletPosition::from_account(&accounts[4])?;

            if pos.owner != *accounts[0].address() {
                return Err(LendError::Unauthorized.into());
            }
            if pos.dwallet != *accounts[3].address() {
                return Err(ProgramError::InvalidAccountData);
            }
            if pos.status != status::ACTIVE {
                return Err(LendError::Unauthorized.into());
            }
        }

        // ── CPI: approve_message ──────────────────────────────────────────────
        ika::approve_message(
            &accounts[8], // ika_program
            &accounts[1], // coordinator
            &accounts[2], // message_approval
            &accounts[3], // dwallet
            &accounts[5], // caller_program (Veil)
            &accounts[6], // cpi_authority
            &accounts[0], // payer (user)
            &accounts[7], // system_program
            &self.message_digest,
            &self.message_metadata_digest,
            &self.user_pubkey,
            self.signature_scheme,
            self.msg_approval_bump,
            self.cpi_authority_bump,
        )?;

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn make_data() -> Vec<u8> {
        let mut d = vec![0u8; 100];
        d[0..32].copy_from_slice(&[1u8; 32]);  // message_digest
        d[32..64].copy_from_slice(&[2u8; 32]); // metadata_digest
        d[64..96].copy_from_slice(&[3u8; 32]); // user_pubkey
        d[96] = 1; d[97] = 0;                  // sig scheme = 1 LE
        d[98] = 250;                            // msg_approval_bump
        d[99] = 251;                            // cpi_authority_bump
        d
    }

    #[test]
    fn from_data_parses() {
        let d = make_data();
        let ix = IkaSign::from_data(&d).unwrap();
        assert_eq!(ix.message_digest,          [1u8; 32]);
        assert_eq!(ix.message_metadata_digest, [2u8; 32]);
        assert_eq!(ix.user_pubkey,             [3u8; 32]);
        assert_eq!(ix.signature_scheme, 1);
        assert_eq!(ix.msg_approval_bump, 250);
        assert_eq!(ix.cpi_authority_bump, 251);
    }

    #[test]
    fn from_data_too_short() {
        assert!(IkaSign::from_data(&[0u8; 99]).is_err());
    }

    #[test]
    fn discriminator() {
        assert_eq!(IkaSign::DISCRIMINATOR, 19);
    }
}
