/*!
`EncryptContext` — CPI context for the Encrypt program.

This struct mirrors `encrypt_pinocchio::EncryptContext` exactly.  When the
SDK supports pinocchio 0.11.x:

1. Remove this file.
2. Replace `use crate::fhe::context::EncryptContext` with
   `use encrypt_pinocchio::EncryptContext`.
3. Replace `execute_graph_stub` calls with the real `execute_graph` CPI.

# Account layout (matches SDK)

```text
[0]  encrypt_program         -- Encrypt program itself (CPI target)
[1]  config                  -- Encrypt program config PDA
[2]  deposit                 -- writable: fee handling
[3]  cpi_authority           -- PDA: seeds = [CPI_AUTHORITY_SEED, bump]
[4]  caller_program          -- this program's own address
[5]  network_encryption_key  -- network-wide encryption key account
[6]  payer                   -- signer; pays for new ciphertext accounts
[7]  event_authority         -- event emission
[8]  system_program
```

# Encrypt program ID (Solana devnet)
`4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`
*/

use pinocchio::{account::AccountView, ProgramResult};

/// PDA seed for the CPI signer authority.
/// Same constant as `encrypt_pinocchio::CPI_AUTHORITY_SEED`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__encrypt_cpi_authority";

/// Encrypt program ID on Solana devnet.
pub const ENCRYPT_PROGRAM_ID_BYTES: [u8; 32] = [
    0x38, 0x96, 0x5c, 0x4c, 0x55, 0x93, 0xe1, 0xa3,
    0xd7, 0x78, 0x40, 0x8c, 0x14, 0x75, 0xb3, 0x45,
    0x48, 0x22, 0xf5, 0x4e, 0xef, 0x2c, 0x6a, 0x71,
    0x32, 0xa9, 0xef, 0x07, 0x11, 0xf6, 0x23, 0x44,
];

/// CPI context for interacting with the Encrypt on-chain program.
///
/// Construct one per instruction handler that calls into the FHE layer,
/// then call the generated `<GraphName>Cpi` methods on it.
pub struct EncryptContext<'a> {
    /// The Encrypt program account.
    pub encrypt_program: &'a AccountView,
    /// Encrypt config PDA (created by the Encrypt program at init).
    pub config: &'a AccountView,
    /// Fee / deposit account (writable).
    pub deposit: &'a AccountView,
    /// CPI signer PDA — seeds: `[CPI_AUTHORITY_SEED, &[bump]]`.
    pub cpi_authority: &'a AccountView,
    /// This Veil lending program (caller).
    pub caller_program: &'a AccountView,
    /// Network-wide encryption public key account.
    pub network_encryption_key: &'a AccountView,
    /// Payer for new ciphertext accounts (must be signer).
    pub payer: &'a AccountView,
    /// Emit-event authority PDA.
    pub event_authority: &'a AccountView,
    /// Solana system program.
    pub system_program: &'a AccountView,
    /// Bump for the CPI authority PDA.
    pub cpi_authority_bump: u8,
}

impl<'a> EncryptContext<'a> {
    // ── Graph execution ───────────────────────────────────────────────────────

    /// Execute a pre-compiled computation graph via CPI.
    ///
    /// `graph_bytes` — serialized DAG produced by the `#[encrypt_fn]` macro.
    /// `accounts`    — slice of [input ciphertexts..., output ciphertexts...].
    ///
    /// **Current state**: stub — emits no CPI until `encrypt-pinocchio` is
    /// compatible with pinocchio 0.11.x.
    ///
    /// **Activation**: replace the body with:
    /// ```rust,ignore
    /// use encrypt_pinocchio::EncryptCpi;
    /// self.as_real_ctx().execute_graph(graph_bytes, accounts)
    /// ```
    pub fn execute_graph_stub(
        &self,
        _graph_bytes: &[u8],
        _accounts: &[&'a AccountView],
    ) -> ProgramResult {
        // TODO: real CPI once encrypt-pinocchio supports pinocchio 0.11.x
        // When activated this will:
        //  1. Build a Solana instruction with:
        //       accounts = [config, deposit, cpi_authority, caller_program,
        //                   network_encryption_key, payer, event_authority,
        //                   system_program] ++ _accounts
        //       data     = [disc(1)] ++ [graph_len(2 LE)] ++ graph_bytes ++ [n_inputs(1)]
        //  2. invoke_signed with seeds [CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]]
        Ok(())
    }

    /// Create a plaintext (unencrypted) ciphertext account with a known value.
    ///
    /// In the pre-alpha SDK, "encrypted" values are actually plaintext.
    /// The executor will later replace them with genuine ciphertext.
    ///
    /// **Activation**:
    /// ```rust,ignore
    /// self.as_real_ctx().create_plaintext_typed::<Uint64>(value, ciphertext)
    /// ```
    pub fn create_plaintext_u64_stub(
        &self,
        _value: u64,
        _ciphertext: &'a AccountView,
    ) -> ProgramResult {
        // TODO: real CPI to Encrypt program
        Ok(())
    }

    /// Create a plaintext bool ciphertext account.
    pub fn create_plaintext_bool_stub(
        &self,
        _value: bool,
        _ciphertext: &'a AccountView,
    ) -> ProgramResult {
        // TODO: real CPI
        Ok(())
    }

    // ── Lending-specific graph wrappers ───────────────────────────────���───────
    // These mirror the methods that the `#[encrypt_fn]` macro would generate.
    // When the SDK is active, delete these and use the generated `*Cpi` traits.

    /// `add_deposit`: enc_deposit ← enc_deposit + amount
    ///
    /// SDK call: `ctx.add_deposit(deposit_ct, amount_ct, out_deposit_ct)?`
    pub fn add_deposit(
        &self,
        deposit_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        // Graph: `fn add_deposit(deposit: EUint64, amount: EUint64) -> EUint64 { deposit + amount }`
        self.execute_graph_stub(b"add_deposit", &[deposit_ct, amount_ct, out_ct])
    }

    /// `sub_deposit`: enc_deposit ← enc_deposit - amount
    pub fn sub_deposit(
        &self,
        deposit_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        // Graph: `fn sub_deposit(deposit: EUint64, amount: EUint64) -> EUint64 { deposit - amount }`
        self.execute_graph_stub(b"sub_deposit", &[deposit_ct, amount_ct, out_ct])
    }

    /// `add_debt`: enc_debt ← enc_debt + amount
    pub fn add_debt(
        &self,
        debt_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        // Graph: `fn add_debt(debt: EUint64, amount: EUint64) -> EUint64 { debt + amount }`
        self.execute_graph_stub(b"add_debt", &[debt_ct, amount_ct, out_ct])
    }

    /// `sub_debt`: enc_debt ← enc_debt - amount
    pub fn sub_debt(
        &self,
        debt_ct: &'a AccountView,
        amount_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        // Graph: `fn sub_debt(debt: EUint64, amount: EUint64) -> EUint64 { debt - amount }`
        self.execute_graph_stub(b"sub_debt", &[debt_ct, amount_ct, out_ct])
    }

    /// `is_healthy`: out ← (deposit * 8_000) >= (debt * 10_000)
    ///
    /// Returns an encrypted `EBool` into `out_ct`.
    pub fn is_healthy(
        &self,
        deposit_ct: &'a AccountView,
        debt_ct: &'a AccountView,
        out_ct: &'a AccountView,
    ) -> ProgramResult {
        // Graph:
        // ```
        // fn is_healthy(deposit: EUint64, debt: EUint64) -> EBool {
        //     deposit * 8_000u64 >= debt * 10_000u64
        // }
        // ```
        self.execute_graph_stub(b"is_healthy", &[deposit_ct, debt_ct, out_ct])
    }
}
