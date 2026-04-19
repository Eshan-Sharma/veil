/*!
FHE (Fully Homomorphic Encryption) privacy layer — Encrypt SDK integration.

When a user enables privacy on their position, deposit and debt balances
are mirrored as ciphertext on-chain via Encrypt's pre-alpha SDK.  Health
factor logic can then run over encrypted data without exposing position
details to validators, indexers, or RPC observers.

# SDK status

The Encrypt SDK (https://github.com/dwallet-labs/encrypt-pre-alpha) is
pre-alpha and currently requires pinocchio 0.10.x.  Veil's core program
targets 0.11.x.  This module implements the full architecture with the
exact API shape the SDK expects.

To activate real on-chain FHE once the SDK supports pinocchio 0.11+:

1. Add to Cargo.toml [dependencies]:
   ```toml
   encrypt-types    = { git = "https://github.com/dwallet-labs/encrypt-pre-alpha" }
   encrypt-dsl      = { package = "encrypt-solana-dsl",
                        git     = "https://github.com/dwallet-labs/encrypt-pre-alpha" }
   encrypt-pinocchio = { git = "https://github.com/dwallet-labs/encrypt-pre-alpha" }
   ```
2. Replace `fhe::context::EncryptContext` with `encrypt_pinocchio::EncryptContext`.
3. Replace `fhe::context::EncryptContext::execute_graph_stub` with the real
   `execute_graph` CPI call.
4. Replace graph functions in `fhe::graphs` with `#[encrypt_fn]`-decorated
   versions (SDK-ready signatures shown in each function's doc comment).

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
pub mod graphs;
pub mod types;

/// Basis-point denominator used inside FHE graphs (avoids WAD-scale u128
/// arithmetic which is expensive inside EUint64 operations).
pub const BPS_DENOM: u64 = 10_000;

/// Liquidation threshold in BPS (80 %).
pub const LIQ_THRESHOLD_BPS: u64 = 8_000;

/// LTV in BPS (75 %).
pub const LTV_BPS: u64 = 7_500;
