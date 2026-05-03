/*!
`EncryptContext` — Encrypt-program CPI context for Veil's lending graphs.

Thin wrapper around `encrypt_pinocchio::EncryptContext` (vendored under
`vendor/encrypt/encrypt-pinocchio`). The wrapper exposes only the operations
Veil needs (deposit/debt arithmetic + health check) and builds the graph
bytes inline via `crate::fhe::graph_builder`.

# Encrypt program ID (Solana devnet)
`4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`

# Account layout (matches the SDK exactly)

```text
[0]  encrypt_program         -- Encrypt program itself (CPI target)
[1]  config                  -- Encrypt config PDA
[2]  deposit                 -- writable: fee handling
[3]  cpi_authority           -- PDA: seeds = [CPI_AUTHORITY_SEED, bump]
[4]  caller_program          -- this program's own address (read-only signer-like)
[5]  network_encryption_key  -- network-wide encryption key account
[6]  payer                   -- signer; pays for new ciphertext accounts
[7]  event_authority         -- event emission
[8]  system_program
```
*/

use encrypt_pinocchio::EncryptContext as InnerCtx;
use encrypt_types::encrypted::Uint64;
use pinocchio::{account::AccountView, Address, ProgramResult};

use crate::{errors::LendError, fhe::graph_builder};

/// PDA seed for the CPI signer authority. Same constant as
/// `encrypt_pinocchio::cpi::CPI_AUTHORITY_SEED`.
pub const CPI_AUTHORITY_SEED: &[u8] = encrypt_pinocchio::cpi::CPI_AUTHORITY_SEED;

/// Encrypt program ID on Solana devnet (`4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`).
pub const ENCRYPT_PROGRAM_ID_BYTES: [u8; 32] = [
    0x38, 0x96, 0x5c, 0x4c, 0x55, 0x93, 0xe1, 0xa3,
    0xd7, 0x78, 0x40, 0x8c, 0x14, 0x75, 0xb3, 0x45,
    0x48, 0x22, 0xf5, 0x4e, 0xef, 0x2c, 0x6a, 0x71,
    0x32, 0xa9, 0xef, 0x07, 0x11, 0xf6, 0x23, 0x44,
];

/// Encrypt program ID as a typed `Address` for ergonomic ownership checks.
pub const ENCRYPT_PROGRAM_ID: Address = Address::new_from_array(ENCRYPT_PROGRAM_ID_BYTES);

/// Verify that a ciphertext account is owned by the Encrypt program.
///
/// Ciphertext accounts are created by the Encrypt program inside the CPI;
/// post-CPI ownership MUST be the Encrypt program. A SystemProgram-owned
/// account passed here would let an attacker pollute the EncryptedPosition's
/// stored addresses (or sneak through with empty / fake ciphertext bytes
/// against a real Encrypt deployment that didn't actually run).
#[inline(always)]
pub fn verify_ciphertext_owner(account: &AccountView) -> ProgramResult {
    if account.owner() != &ENCRYPT_PROGRAM_ID {
        return Err(LendError::InvalidAccountOwner.into());
    }
    Ok(())
}

/// CPI context for the Encrypt program. Fields mirror
/// `encrypt_pinocchio::EncryptContext` 1-to-1 — instruction handlers can
/// keep populating it from their account slice.
pub struct EncryptContext<'a> {
    pub encrypt_program: &'a AccountView,
    pub config: &'a AccountView,
    pub deposit: &'a AccountView,
    pub cpi_authority: &'a AccountView,
    pub caller_program: &'a AccountView,
    pub network_encryption_key: &'a AccountView,
    pub payer: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub system_program: &'a AccountView,
    pub cpi_authority_bump: u8,
}

impl<'a> EncryptContext<'a> {
    fn inner(&self) -> InnerCtx<'a> {
        InnerCtx {
            encrypt_program: self.encrypt_program,
            config: self.config,
            deposit: self.deposit,
            cpi_authority: self.cpi_authority,
            caller_program: self.caller_program,
            network_encryption_key: self.network_encryption_key,
            payer: self.payer,
            event_authority: self.event_authority,
            system_program: self.system_program,
            cpi_authority_bump: self.cpi_authority_bump,
        }
    }

    /// Create a public-plaintext `EUint64` ciphertext account holding `value`.
    ///
    /// Wraps `EncryptContext::create_plaintext_typed::<Uint64>`. The
    /// `ciphertext` account must be a fresh signer account with enough
    /// lamports for the ciphertext layout (allocated by the user/payer).
    pub fn create_plaintext_u64(
        &self,
        value: u64,
        ciphertext: &'a AccountView,
    ) -> ProgramResult {
        self.inner().create_plaintext_typed::<Uint64>(&value, ciphertext)
    }

    /// `enc_deposit ← enc_deposit + amount` (EUint64 add).
    pub fn add_deposit(
        &self,
        deposit_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        let data = graph_builder::add_u64();
        self.inner()
            .execute_graph(&data, &[deposit_ct, amount_ct, out_ct])
    }

    /// `enc_deposit ← enc_deposit - amount` (saturates at 0 inside FHE).
    pub fn sub_deposit(
        &self,
        deposit_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        let data = graph_builder::sub_u64();
        self.inner()
            .execute_graph(&data, &[deposit_ct, amount_ct, out_ct])
    }

    /// `enc_debt ← enc_debt + amount`.
    pub fn add_debt(
        &self,
        debt_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        let data = graph_builder::add_u64();
        self.inner()
            .execute_graph(&data, &[debt_ct, amount_ct, out_ct])
    }

    /// `enc_debt ← enc_debt - amount` (saturates at 0).
    pub fn sub_debt(
        &self,
        debt_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        let data = graph_builder::sub_u64();
        self.inner()
            .execute_graph(&data, &[debt_ct, amount_ct, out_ct])
    }

    /// `out_ct = (deposit * 8000) >= (debt * 10000)` (EBool).
    ///
    /// Submits an `is_healthy` graph for asynchronous evaluation; the
    /// resulting EBool ends up in `out_ct` and can be revealed later via
    /// `request_decryption` for off-chain verifiers.
    pub fn is_healthy(
        &self,
        deposit_ct: &'a AccountView,
        debt_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        let data = graph_builder::is_healthy();
        self.inner()
            .execute_graph(&data, &[deposit_ct, debt_ct, out_ct])
    }
}
