/*!
FHE (Fully Homomorphic Encryption) privacy layer — Encrypt SDK integration.

When a user enables privacy on their position, deposit and debt balances
are mirrored as ciphertext on-chain via Encrypt's pre-alpha SDK.  Health
factor logic can then run over encrypted data without exposing position
details to validators, indexers, or RPC observers.

# SDK status

Wired against the vendored `encrypt-pinocchio` crate (under
`vendor/encrypt/`). `EncryptContext::{add_deposit, sub_deposit, add_debt,
sub_debt, is_healthy}` build instruction data via `fhe::graph_builder` and
forward to `encrypt_pinocchio::EncryptContext::execute_graph`. Plaintext
`create_plaintext_u64` uses `create_plaintext_typed::<Uint64>`.

# Architecture

```text
User calls PrivateDeposit
      |
      v
Veil lending program
  |- Accrues interest (same as Deposit)
  |- Validates and transfers tokens (same as Deposit)
  |- Updates UserPosition (plaintext -- enforces solvency)
  |- Updates LendingPool totals
  +- Calls EncryptContext::add_deposit_graph
              |
              v CPI
        Encrypt program (devnet: 4ebfzW...)
              |
              v off-chain executor
        FHE eval: enc_deposit <- enc_deposit + amount
        Commit new ciphertext to enc_deposit account
```

The plaintext UserPosition is always kept consistent; it is the source of
truth for on-chain solvency enforcement.  The encrypted position provides
confidentiality — an observer cannot read the values from the ciphertext.

# Encrypt program ID (Solana devnet)
4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8
*/

pub mod context;
pub mod graph_builder;
pub mod graphs;
pub mod types;

/// Basis-point denominator used inside FHE graphs (avoids WAD-scale u128
/// arithmetic which is expensive inside EUint64 operations).
pub const BPS_DENOM: u64 = 10_000;

/// Liquidation threshold in BPS (80 %).
pub const LIQ_THRESHOLD_BPS: u64 = 8_000;

/// LTV in BPS (75 %).
pub const LTV_BPS: u64 = 7_500;
