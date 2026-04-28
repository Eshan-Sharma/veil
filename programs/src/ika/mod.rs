/*!
Manual CPI bindings for the Ika dWallet pre-alpha program on Solana.

Written against pinocchio 0.11.1 to avoid a type-incompatible dependency on
`ika-dwallet-pinocchio` (which targets pinocchio 0.10).

## Instruction discriminators (from Ika SDK source)
| Instruction         | Disc |
|---------------------|------|
| approve_message     |  8   |
| transfer_dwallet    |  24  |
| transfer_future_sign|  42  |

## approve_message accounts
| idx | role             | flags           |
|-----|------------------|-----------------|
|  0  | coordinator      | readonly        |
|  1  | message_approval | writable        |
|  2  | dwallet          | readonly        |
|  3  | caller_program   | readonly        |
|  4  | cpi_authority    | readonly+signer |
|  5  | payer            | writable+signer |
|  6  | system_program   | readonly        |

## approve_message data (100 bytes)
| offset | size | field                   |
|--------|------|-------------------------|
|   0    |  1   | discriminator (8)       |
|   1    |  1   | msg_approval_bump       |
|   2    | 32   | message_digest          |
|  34    | 32   | message_metadata_digest |
|  66    | 32   | user_pubkey             |
|  98    |  2   | signature_scheme (LE)   |

## transfer_dwallet accounts
| idx | role           | flags           |
|-----|----------------|-----------------|
|  0  | caller_program | readonly        |
|  1  | cpi_authority  | readonly+signer |
|  2  | dwallet        | writable        |

## transfer_dwallet data (33 bytes)
| offset | size | field               |
|--------|------|---------------------|
|   0    |  1   | discriminator (24)  |
|   1    | 32   | new_authority pubkey|
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
pub const IKA_PROGRAM_ID: Address =
    Address::from_str_const("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");

/// PDA seed used to derive Veil's CPI authority.
/// Derivation: `find_program_address(&[CPI_AUTHORITY_SEED], &VEIL_PROGRAM_ID)`
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";

/// DWalletCoordinator PDA seed (on the Ika program).
pub const COORDINATOR_SEED: &[u8] = b"dwallet_coordinator";

// ── Discriminators ────────────────────────────────────────────────────────────
pub(crate) const IX_APPROVE_MESSAGE:  u8 = 8;
pub(crate) const IX_TRANSFER_DWALLET: u8 = 24;

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
    coordinator:             &AccountView,
    message_approval:        &AccountView,
    dwallet:                 &AccountView,
    caller_program:          &AccountView,
    cpi_authority:           &AccountView,
    payer:                   &AccountView,
    system_program:          &AccountView,
    message_digest:          &[u8; 32],
    message_metadata_digest: &[u8; 32],
    user_pubkey:             &[u8; 32],
    signature_scheme:        u16,
    msg_approval_bump:       u8,
    cpi_authority_bump:      u8,
) -> ProgramResult {
    // ── Build instruction data (100 bytes) ───────────────────────────────────
    let mut data = [MaybeUninit::<u8>::uninit(); 100];
    data[0].write(IX_APPROVE_MESSAGE);
    data[1].write(msg_approval_bump);
    for (i, &b) in message_digest.iter().enumerate()          { data[2  + i].write(b); }
    for (i, &b) in message_metadata_digest.iter().enumerate() { data[34 + i].write(b); }
    for (i, &b) in user_pubkey.iter().enumerate()             { data[66 + i].write(b); }
    let scheme_le = signature_scheme.to_le_bytes();
    data[98].write(scheme_le[0]);
    data[99].write(scheme_le[1]);

    // ── Build instruction accounts (7 entries) ───────────────────────────────
    let mut ix_accs = [const { MaybeUninit::<InstructionAccount>::uninit() }; 7];
    ix_accs[0].write(InstructionAccount::readonly(coordinator.address()));
    ix_accs[1].write(InstructionAccount::writable(message_approval.address()));
    ix_accs[2].write(InstructionAccount::readonly(dwallet.address()));
    ix_accs[3].write(InstructionAccount::readonly(caller_program.address()));
    ix_accs[4].write(InstructionAccount::readonly_signer(cpi_authority.address()));
    ix_accs[5].write(InstructionAccount::writable_signer(payer.address()));
    ix_accs[6].write(InstructionAccount::readonly(system_program.address()));

    // ── Build CPI accounts ───────────────────────────────────────────────────
    let mut cpi_accs = [MaybeUninit::<CpiAccount>::uninit(); 7];
    CpiAccount::init_from_account_view(coordinator,      &mut cpi_accs[0]);
    CpiAccount::init_from_account_view(message_approval, &mut cpi_accs[1]);
    CpiAccount::init_from_account_view(dwallet,          &mut cpi_accs[2]);
    CpiAccount::init_from_account_view(caller_program,   &mut cpi_accs[3]);
    CpiAccount::init_from_account_view(cpi_authority,    &mut cpi_accs[4]);
    CpiAccount::init_from_account_view(payer,            &mut cpi_accs[5]);
    CpiAccount::init_from_account_view(system_program,   &mut cpi_accs[6]);

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
                accounts:   from_raw_parts(ix_accs.as_ptr()  as _, 7),
                data:       from_raw_parts(data.as_ptr()     as _, 100),
            },
            from_raw_parts(cpi_accs.as_ptr() as _, 7),
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

