/*!
`IkaDwalletPosition` — tracks BTC/ETH collateral held via an Ika dWallet.

One PDA per (owner, dwallet) pair.  The dWallet's authority must have been
transferred to Veil's CPI authority PDA (`["__ika_cpi_authority"]` seeded on
the Veil program ID) before this account is created.

Layout (repr C, 128 bytes):

| offset | size | field            |
|--------|------|------------------|
|   0    |   8  | discriminator    |
|   8    |  32  | owner            |
|  40    |  32  | pool             |
|  72    |  32  | dwallet          |
| 104    |   8  | usd_value        |
| 112    |   2  | curve            |
| 114    |   2  | signature_scheme |
| 116    |   1  | status           |
| 117    |   1  | bump             |
| 118    |  10  | _pad             |
| 128    |      | (end)            |
*/

use pinocchio::{account::AccountView, error::ProgramError, Address};

/// Status of a dWallet position.
pub mod status {
    pub const ACTIVE: u8     = 0;
    pub const RELEASED: u8   = 1;
    pub const LIQUIDATED: u8 = 2;
}

/// Curve type, matching Ika's DWalletCurve enum.
pub mod curve {
    pub const SECP256K1: u16  = 0; // Bitcoin, Ethereum
    pub const SECP256R1: u16  = 1; // WebAuthn
    pub const CURVE25519: u16 = 2; // Solana, Ed25519
    pub const RISTRETTO: u16  = 3; // Substrate / sr25519
}

/// Signature scheme, matching Ika's DWalletSignatureScheme enum.
pub mod scheme {
    pub const ECDSA_KECCAK256:    u16 = 0; // Ethereum
    pub const ECDSA_SHA256:       u16 = 1; // Bitcoin legacy / WebAuthn
    pub const ECDSA_DOUBLE_SHA256:u16 = 2; // Bitcoin BIP143
    pub const TAPROOT_SHA256:     u16 = 3; // Bitcoin Taproot
    pub const ECDSA_BLAKE2B256:   u16 = 4; // Zcash
    pub const EDDSA_SHA512:       u16 = 5; // Ed25519 (Solana)
    pub const SCHNORRKEL_MERLIN:  u16 = 6; // Substrate sr25519
}

/// On-chain offsets inside the Ika dWallet account for fields Veil needs.
pub mod dwallet_layout {
    pub const DISCRIMINATOR: usize = 0;  // 1 byte (= 2)
    pub const VERSION: usize       = 1;  // 1 byte (= 1)
    pub const AUTHORITY: usize     = 2;  // 32 bytes
    pub const CURVE: usize         = 34; // 2 bytes u16 LE
    pub const STATE: usize         = 36; // 1 byte: 0=DKGInProgress, 1=Active, 2=Frozen

    pub const DWALLET_DISCRIMINATOR: u8 = 2;
    pub const STATE_ACTIVE: u8          = 1;
}

#[repr(C)]
pub struct IkaDwalletPosition {
    pub discriminator:    [u8; 8],
    pub owner:            Address,
    pub pool:             Address,
    /// The Ika dWallet account's public key.
    pub dwallet:          Address,
    /// USD value of the cross-chain collateral at registration time (in cents, u64).
    pub usd_value:        u64,
    /// Ika curve type (curve::* constants).
    pub curve:            u16,
    /// Ika signature scheme (scheme::* constants).
    pub signature_scheme: u16,
    /// Current status (status::* constants).
    pub status:           u8,
    pub bump:             u8,
    pub _pad:             [u8; 10],
}

impl IkaDwalletPosition {
    pub const DISCRIMINATOR: [u8; 8] = *b"VEILIKA!";
    pub const SIZE: usize = 128;

    #[inline(always)]
    pub fn from_account(account: &AccountView) -> Result<&Self, ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let pos = unsafe { &*(account.data_ptr() as *const Self) };
        if pos.discriminator != Self::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(pos)
    }

    #[inline(always)]
    pub fn from_account_mut(account: &AccountView) -> Result<&mut Self, ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let pos = unsafe { &mut *(account.data_ptr() as *mut Self) };
        if pos.discriminator != Self::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(pos)
    }

    pub fn init(
        account:          &AccountView,
        owner:            &Address,
        pool:             &Address,
        dwallet:          &Address,
        usd_value:        u64,
        curve:            u16,
        signature_scheme: u16,
        bump:             u8,
    ) -> Result<(), ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let raw = unsafe {
            core::slice::from_raw_parts_mut(account.data_ptr() as *mut u8, Self::SIZE)
        };
        raw.fill(0);

        let pos = unsafe { &mut *(account.data_ptr() as *mut Self) };
        pos.discriminator    = Self::DISCRIMINATOR;
        pos.owner            = *owner;
        pos.pool             = *pool;
        pos.dwallet          = *dwallet;
        pos.usd_value        = usd_value;
        pos.curve            = curve;
        pos.signature_scheme = signature_scheme;
        pos.status           = status::ACTIVE;
        pos.bump             = bump;
        Ok(())
    }
}
