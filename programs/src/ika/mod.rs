/*!
Manual CPI bindings for the Ika dWallet pre-alpha program on Solana.

Written against pinocchio 0.11.1 to avoid a type-incompatible dependency on
`ika-dwallet-pinocchio` (which targets pinocchio 0.10). The wire format
mirrors `docs/src/reference/instructions.md` in dwallet-labs/ika-pre-alpha
as of the 2026-04-13 "Redesign gRPC types, versioned attestations" change.

## Instruction discriminators
| Instruction         | Disc |
|---------------------|------|
| approve_message     |  8   |
| transfer_ownership  |  24  | (we call it transfer_dwallet)
| transfer_future_sign|  42  |

## approve_message accounts (CPI path, 6)
| idx | role             | flags           |
|-----|------------------|-----------------|
|  0  | message_approval | writable        |
|  1  | dwallet          | readonly        |
|  2  | caller_program   | readonly (exec) |
|  3  | cpi_authority    | readonly+signer |
|  4  | payer            | writable+signer |
|  5  | system_program   | readonly        |

## approve_message data (67 bytes)
| offset | size | field                |
|--------|------|----------------------|
|   0    |  1   | discriminator (8)    |
|   1    |  1   | msg_approval_bump    |
|   2    | 32   | message_hash         |
|  34    | 32   | user_pubkey          |
|  66    |  1   | signature_scheme     |

## transfer_dwallet accounts (CPI path, 3)
| idx | role           | flags           |
|-----|----------------|-----------------|
|  0  | caller_program | readonly (exec) |
|  1  | cpi_authority  | readonly+signer |
|  2  | dwallet        | writable        |

## transfer_dwallet data (33 bytes)
| offset | size | field               |
|--------|------|---------------------|
|   0    |  1   | discriminator (24)  |
|   1    | 32   | new_authority pubkey|

## transfer_future_sign accounts (CPI path, 3)
| idx | role             | flags           |
|-----|------------------|-----------------|
|  0  | partial_user_sig | writable        |
|  1  | caller_program   | readonly (exec) |
|  2  | cpi_authority    | readonly+signer |
*/

use core::{mem::MaybeUninit, slice::from_raw_parts};

use pinocchio::{
    account::AccountView,
    cpi::{CpiAccount, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    Address, ProgramResult,
};

// Re-export invoke_signed_unchecked from pinocchio::cpi
use pinocchio::cpi::invoke_signed_unchecked;

/// Ika dWallet pre-alpha program ID on Solana devnet.
///
/// # Security context (audit 05, finding I-2)
///
/// This is the **devnet pre-alpha** Ika program ID. The on-chain Veil
/// program cannot tell which cluster it is deployed on, so the operator
/// MUST verify this constant matches the target cluster before deploying:
///
/// - **Devnet pre-alpha**: `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`
/// - **Mainnet**: not yet announced — Ika MPC network is still mock-signed
///   pre-alpha and is **not** ready for mainnet (see security gate #2 in
///   `docs/internal/ika-integration-roadmap.md`).
///
/// `Address::from_str_const` is `const`-eval and cannot accept `env!()`
/// input, so a build-time override (the `MOCK_ADMIN` pattern in
/// `instructions/mock_oracle.rs` is also a literal) is not possible
/// without a `build.rs` codegen step. The defence-in-depth instead:
///
/// 1. Every IKA-touching instruction (`ika_register`, `ika_sign`,
///    `ika_release`) compares dWallet/program account addresses to this
///    constant. A devnet-ID build pointed at a mainnet RPC will fail
///    `IncorrectProgramId` rather than silently CPI to a wrong program.
/// 2. The deployer checklist in
///    `docs/internal/ika-integration-roadmap.md` requires updating this
///    constant before any non-devnet deployment.
pub const IKA_PROGRAM_ID: Address =
    Address::from_str_const("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");

/// PDA seed used to derive Veil's CPI authority.
/// Derivation: `find_program_address(&[CPI_AUTHORITY_SEED], &VEIL_PROGRAM_ID)`
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";

/// DWalletCoordinator PDA seed (on the Ika program).
pub const COORDINATOR_SEED: &[u8] = b"dwallet_coordinator";

// ── Discriminators ────────────────────────────────────────────────────────────
// Mirrors `chains/solana/program-sdk/native/src/lib.rs` in the Ika pre-alpha
// SDK (pinocchio 0.10). These bindings live independently so Veil can stay on
// pinocchio 0.11 without forking the SDK; the wire format is identical.
pub(crate) const IX_APPROVE_MESSAGE:     u8 = 8;
pub(crate) const IX_TRANSFER_DWALLET:    u8 = 24; // SDK calls it TRANSFER_OWNERSHIP
pub(crate) const IX_TRANSFER_FUTURE_SIGN: u8 = 42;

// ── approve_message ───────────────────────────────────────────────────────────

/// CPI: `approve_message` — request a cross-chain signature from the dWallet MPC network.
///
/// Creates a `MessageApproval` PDA; the MPC network will later populate it with
/// the completed signature.
///
/// `cpi_authority` must be Veil's CPI authority PDA
/// (`seeds = [CPI_AUTHORITY_SEED]` on Veil's program ID).
#[allow(clippy::too_many_arguments)]
pub fn approve_message(
    ika_program:             &AccountView,
    message_approval:        &AccountView,
    dwallet:                 &AccountView,
    caller_program:          &AccountView,
    cpi_authority:           &AccountView,
    payer:                   &AccountView,
    system_program:          &AccountView,
    message_hash:            &[u8; 32],
    user_pubkey:             &[u8; 32],
    signature_scheme:        u8,
    msg_approval_bump:       u8,
    cpi_authority_bump:      u8,
) -> ProgramResult {
    // ── Build instruction data (67 bytes) ────────────────────────────────────
    let mut data = [MaybeUninit::<u8>::uninit(); 67];
    data[0].write(IX_APPROVE_MESSAGE);
    data[1].write(msg_approval_bump);
    for (i, &b) in message_hash.iter().enumerate() { data[2  + i].write(b); }
    for (i, &b) in user_pubkey.iter().enumerate()  { data[34 + i].write(b); }
    data[66].write(signature_scheme);

    // ── Build instruction accounts (6 entries) ───────────────────────────────
    let mut ix_accs = [const { MaybeUninit::<InstructionAccount>::uninit() }; 6];
    ix_accs[0].write(InstructionAccount::writable(message_approval.address()));
    ix_accs[1].write(InstructionAccount::readonly(dwallet.address()));
    ix_accs[2].write(InstructionAccount::readonly(caller_program.address()));
    ix_accs[3].write(InstructionAccount::readonly_signer(cpi_authority.address()));
    ix_accs[4].write(InstructionAccount::writable_signer(payer.address()));
    ix_accs[5].write(InstructionAccount::readonly(system_program.address()));

    // ── Build CPI accounts ───────────────────────────────────────────────────
    let mut cpi_accs = [MaybeUninit::<CpiAccount>::uninit(); 6];
    CpiAccount::init_from_account_view(message_approval, &mut cpi_accs[0]);
    CpiAccount::init_from_account_view(dwallet,          &mut cpi_accs[1]);
    CpiAccount::init_from_account_view(caller_program,   &mut cpi_accs[2]);
    CpiAccount::init_from_account_view(cpi_authority,    &mut cpi_accs[3]);
    CpiAccount::init_from_account_view(payer,            &mut cpi_accs[4]);
    CpiAccount::init_from_account_view(system_program,   &mut cpi_accs[5]);

    // ── PDA signer seeds ─────────────────────────────────────────────────────
    let bump_bytes = [cpi_authority_bump];
    let seeds = [
        Seed::from(CPI_AUTHORITY_SEED),
        Seed::from(&bump_bytes as &[u8]),
    ];
    let signer = Signer::from(&seeds);

    // ── Invoke ───────────────────────────────────────────────────────────────
    unsafe {
        invoke_signed_unchecked(
            &InstructionView {
                program_id: ika_program.address(),
                accounts:   from_raw_parts(ix_accs.as_ptr()  as _, 6),
                data:       from_raw_parts(data.as_ptr()     as _, 67),
            },
            from_raw_parts(cpi_accs.as_ptr() as _, 6),
            &[signer],
        );
    }

    Ok(())
}

// ── transfer_dwallet ──────────────────────────────────────────────────────────

/// CPI: `transfer_dwallet` — hand the dWallet's authority back to `new_authority`.
///
/// Used by `IkaRelease` to return the dWallet to its original owner after the
/// collateral is unlocked.
pub fn transfer_dwallet(
    ika_program:        &AccountView,
    caller_program:     &AccountView,
    cpi_authority:      &AccountView,
    dwallet:            &AccountView,
    new_authority:      &Address,
    cpi_authority_bump: u8,
) -> ProgramResult {
    // ── Build instruction data (33 bytes) ────────────────────────────────────
    let mut data = [MaybeUninit::<u8>::uninit(); 33];
    data[0].write(IX_TRANSFER_DWALLET);
    for (i, &b) in new_authority.as_ref().iter().enumerate() {
        data[1 + i].write(b);
    }

    // ── Build instruction accounts (3 entries) ───────────────────────────────
    let mut ix_accs = [const { MaybeUninit::<InstructionAccount>::uninit() }; 3];
    ix_accs[0].write(InstructionAccount::readonly(caller_program.address()));
    ix_accs[1].write(InstructionAccount::readonly_signer(cpi_authority.address()));
    ix_accs[2].write(InstructionAccount::writable(dwallet.address()));

    // ── Build CPI accounts ───────────────────────────────────────────────────
    let mut cpi_accs = [MaybeUninit::<CpiAccount>::uninit(); 3];
    CpiAccount::init_from_account_view(caller_program, &mut cpi_accs[0]);
    CpiAccount::init_from_account_view(cpi_authority,  &mut cpi_accs[1]);
    CpiAccount::init_from_account_view(dwallet,        &mut cpi_accs[2]);

    // ── PDA signer seeds ─────────────────────────────────────────────────────
    let bump_bytes = [cpi_authority_bump];
    let seeds = [
        Seed::from(CPI_AUTHORITY_SEED),
        Seed::from(&bump_bytes as &[u8]),
    ];
    let signer = Signer::from(&seeds);

    // ── Invoke ───────────────────────────────────────────────────────────────
    unsafe {
        invoke_signed_unchecked(
            &InstructionView {
                program_id: ika_program.address(),
                accounts:   from_raw_parts(ix_accs.as_ptr()  as _, 3),
                data:       from_raw_parts(data.as_ptr()     as _, 33),
            },
            from_raw_parts(cpi_accs.as_ptr() as _, 3),
            &[signer],
        );
    }

    Ok(())
}

// ── transfer_future_sign ──────────────────────────────────────────────────────

/// CPI: `transfer_future_sign` — hand the completion authority of a
/// PartialUserSignature to a new pubkey. Same shape as `transfer_dwallet`
/// (disc 42 instead of 24); included for SDK parity.
pub fn transfer_future_sign(
    ika_program:        &AccountView,
    caller_program:     &AccountView,
    cpi_authority:      &AccountView,
    partial_signature:  &AccountView,
    new_authority:      &Address,
    cpi_authority_bump: u8,
) -> ProgramResult {
    let mut data = [MaybeUninit::<u8>::uninit(); 33];
    data[0].write(IX_TRANSFER_FUTURE_SIGN);
    for (i, &b) in new_authority.as_ref().iter().enumerate() {
        data[1 + i].write(b);
    }

    let mut ix_accs = [const { MaybeUninit::<InstructionAccount>::uninit() }; 3];
    ix_accs[0].write(InstructionAccount::writable(partial_signature.address()));
    ix_accs[1].write(InstructionAccount::readonly(caller_program.address()));
    ix_accs[2].write(InstructionAccount::readonly_signer(cpi_authority.address()));

    let mut cpi_accs = [MaybeUninit::<CpiAccount>::uninit(); 3];
    CpiAccount::init_from_account_view(partial_signature, &mut cpi_accs[0]);
    CpiAccount::init_from_account_view(caller_program,    &mut cpi_accs[1]);
    CpiAccount::init_from_account_view(cpi_authority,     &mut cpi_accs[2]);

    let bump_bytes = [cpi_authority_bump];
    let seeds = [
        Seed::from(CPI_AUTHORITY_SEED),
        Seed::from(&bump_bytes as &[u8]),
    ];
    let signer = Signer::from(&seeds);

    unsafe {
        invoke_signed_unchecked(
            &InstructionView {
                program_id: ika_program.address(),
                accounts:   from_raw_parts(ix_accs.as_ptr()  as _, 3),
                data:       from_raw_parts(data.as_ptr()     as _, 33),
            },
            from_raw_parts(cpi_accs.as_ptr() as _, 3),
            &[signer],
        );
    }

    Ok(())
}

