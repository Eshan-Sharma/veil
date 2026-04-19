/*!
Local mirror of `encrypt-types` encrypted-value handles.

When the Encrypt SDK dependency is added, replace these with:
  `use encrypt_types::encrypted::{Uint64 as Uint64Type, Bool as BoolType};`
  `use encrypt_solana_dsl::types::{EUint64, EBool};`

An `EUint64` / `EBool` is a 32-byte handle whose bytes equal the public
key of the on-chain ciphertext account that stores the encrypted value.
The Encrypt program is the account owner; it writes ciphertext + digest
when an executor evaluates a computation graph.
*/

/// 32-byte handle for an encrypted `u64` ciphertext account.
///
/// SDK equivalent: `encrypt_solana_dsl::types::EUint64`
/// (which is `Encrypted<Uint64>` from `encrypt-types`).
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct EUint64(pub [u8; 32]);

impl EUint64 {
    /// Construct from raw pubkey bytes.
    #[inline(always)]
    pub fn from_pubkey(key: [u8; 32]) -> Self {
        Self(key)
    }

    /// Null / uninitialised handle (all zeroes).
    #[inline(always)]
    pub fn zero() -> Self {
        Self([0u8; 32])
    }

    /// Whether this handle points at a real ciphertext account.
    #[inline(always)]
    pub fn is_zero(&self) -> bool {
        self.0 == [0u8; 32]
    }

    /// Raw pubkey bytes — use to verify the provided ciphertext account.
    #[inline(always)]
    pub fn id(&self) -> &[u8; 32] {
        &self.0
    }
}

/// 32-byte handle for an encrypted `bool` ciphertext account.
///
/// SDK equivalent: `encrypt_solana_dsl::types::EBool`
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct EBool(pub [u8; 32]);

impl EBool {
    #[inline(always)]
    pub fn from_pubkey(key: [u8; 32]) -> Self {
        Self(key)
    }

    #[inline(always)]
    pub fn zero() -> Self {
        Self([0u8; 32])
    }

    #[inline(always)]
    pub fn id(&self) -> &[u8; 32] {
        &self.0
    }
}
