/*!
Register a dWallet as BTC/ETH cross-chain collateral for Veil.

Before calling this instruction the user must have:
  1. Created a dWallet via the Ika SDK (off-chain DKG).
  2. Called `transfer_dwallet` on the Ika program to hand authority of the
     dWallet to Veil's CPI authority PDA
     (`seeds = [b"__ika_cpi_authority"]` on Veil's program ID).

This instruction verifies the authority transfer and records a
`IkaDwalletPosition` PDA that tracks the collateral.

Accounts:
  [0]  user            signer, writable  – position rent payer / owner
  [1]  pool            readonly          – the LendingPool to borrow against
  [2]  dwallet         readonly          – Ika dWallet account
  [3]  ika_position    writable          – new IkaDwalletPosition PDA
                                           seeds: [b"ika_pos", pool, user]
  [4]  cpi_authority   readonly          – Veil CPI authority PDA
  [5]  system_program

Instruction data (after discriminator 0x11):
  usd_value:        u64 LE   – oracle-attested USD value in cents
  curve:            u16 LE   – Ika curve type (0=secp256k1, …)
  signature_scheme: u16 LE   – Ika sig scheme (0=ecdsa_keccak256, …)
  position_bump:    u8
  cpi_authority_bump: u8
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    errors::LendError,
    ika::{CPI_AUTHORITY_SEED, IKA_PROGRAM_ID},
    state::{
        check_program_owner,
        ika_position::{dwallet_layout, IkaDwalletPosition},
        LendingPool,
    },
};

pub struct IkaRegister {
    pub usd_value:          u64,
    pub curve:              u16,
    pub signature_scheme:   u16,
    pub position_bump:      u8,
    pub cpi_authority_bump: u8,
}

impl IkaRegister {
    pub const DISCRIMINATOR: u8 = 0x11; // 17

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        // u64(8) + u16(2) + u16(2) + u8(1) + u8(1) = 14 bytes
        if data.len() < 14 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            usd_value:          u64::from_le_bytes(data[0..8].try_into().unwrap()),
            curve:              u16::from_le_bytes(data[8..10].try_into().unwrap()),
            signature_scheme:   u16::from_le_bytes(data[10..12].try_into().unwrap()),
            position_bump:      data[12],
            cpi_authority_bump: data[13],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        let user_addr = *accounts[0].address();
        let pool_addr = *accounts[1].address();

        // ── Enforce per-pool cap on Ika USD value ─────────────────────────────
        // Defaults to 0 — registration rejected until pool authority opts in
        // via SetIkaCollateralCap. Closes the "register at u64::MAX, drain
        // vault" attack vector (gate #3 in IKA_COLLATERAL_WIRING.md).
        check_program_owner(&accounts[1], program_id)?;
        {
            let pool = LendingPool::from_account(&accounts[1])?;
            if pool.max_ika_usd_cents == 0 {
                return Err(LendError::IkaCollateralDisabled.into());
            }
            if self.usd_value > pool.max_ika_usd_cents {
                return Err(LendError::IkaCollateralExceedsCap.into());
            }
        }

        // ── Verify this really is an Ika dWallet account ─────────────────────
        let dwallet_data = accounts[2].try_borrow()
            .map_err(|_| ProgramError::InvalidAccountData)?;

        if dwallet_data.len() < dwallet_layout::STATE + 1 {
            return Err(ProgramError::InvalidAccountData);
        }
        if dwallet_data[dwallet_layout::DISCRIMINATOR] != dwallet_layout::DWALLET_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if dwallet_data[dwallet_layout::STATE] != dwallet_layout::STATE_ACTIVE {
            return Err(ProgramError::InvalidAccountData);
        }

        // ── Verify the dWallet's authority == Veil CPI authority PDA ─────────
        let dwallet_authority: &[u8; 32] = dwallet_data[dwallet_layout::AUTHORITY
            ..dwallet_layout::AUTHORITY + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        if dwallet_authority != accounts[4].address().as_ref() {
            return Err(LendError::Unauthorized.into());
        }

        // ── Verify the cpi_authority account is owned by Ika program ─────────
        // (the dWallet program transferred it; its owner should remain Ika)
        // We only check that it matches the expected PDA address.
        let expected_cpi_authority = Address::derive_address(
            &[CPI_AUTHORITY_SEED],
            Some(self.cpi_authority_bump),
            program_id,
        );
        if expected_cpi_authority != *accounts[4].address() {
            return Err(LendError::InvalidPda.into());
        }
        // Defence-in-depth (audit 05, finding I-5): the CPI authority MUST be
        // a Veil-owned PDA. Address derivation alone is not sufficient — if
        // Veil is upgraded and the seed is reused with different ownership
        // semantics, this guard catches the mismatch before the IKA CPI
        // fires. Requires the PDA to be allocated to Veil before any IKA
        // flow runs (see deployer checklist in
        // `docs/internal/ika-integration-roadmap.md`).
        if accounts[4].owner() != program_id {
            return Err(LendError::InvalidAccountOwner.into());
        }

        // ── Verify the dWallet is owned by the Ika program ───────────────────
        if accounts[2].owner() != &IKA_PROGRAM_ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        drop(dwallet_data);

        // ── Create IkaDwalletPosition PDA ─────────────────────────────────────
        let bump_bytes = [self.position_bump];
        let dwallet_addr = *accounts[2].address();

        let derived = Address::derive_address(
            &[b"ika_pos", pool_addr.as_ref(), user_addr.as_ref()],
            Some(self.position_bump),
            program_id,
        );
        if derived != *accounts[3].address() {
            return Err(LendError::InvalidPda.into());
        }

        let rent = Rent::get()?;
        let lamports = rent.try_minimum_balance(IkaDwalletPosition::SIZE)?;

        let seeds: [Seed; 4] = [
            Seed::from(b"ika_pos" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(user_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        CreateAccount {
            from:     &accounts[0],
            to:       &accounts[3],
            lamports,
            space:    IkaDwalletPosition::SIZE as u64,
            owner:    program_id,
        }
        .invoke_signed(&[signer])?;

        // ── Initialise the position ───────────────────────────────────────────
        IkaDwalletPosition::init(
            &accounts[3],
            &user_addr,
            &pool_addr,
            &dwallet_addr,
            self.usd_value,
            self.curve,
            self.signature_scheme,
            self.position_bump,
        )?;

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
