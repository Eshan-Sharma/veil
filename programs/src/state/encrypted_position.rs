/*!
`EncryptedPosition` — per-user encrypted mirror of deposit and debt.

When a user enables privacy, an `EncryptedPosition` PDA is created
alongside their existing `UserPosition`.  It holds the 32-byte public keys
of two on-chain ciphertext accounts (one for enc_deposit, one for enc_debt)
managed by the Encrypt program.

The `UserPosition` remains the authoritative source of truth for solvency
enforcement (health factor checks happen in plaintext).  The encrypted
position provides observer confidentiality: an RPC call cannot read the
amounts from the ciphertext accounts.

Layout (repr C, 144 bytes):

| offset | size | field          |
|--------|------|----------------|
|   0    |   8  | discriminator  |
|   8    |  32  | owner          |
|  40    |  32  | pool           |
|  72    |  32  | enc_deposit    |  ← pubkey of EUint64 ciphertext account
| 104    |  32  | enc_debt       |  ← pubkey of EUint64 ciphertext account
| 136    |   1  | bump           |
| 137    |   7  | _pad           |
| 144    |      | (end)          |

PDA seeds: [b"enc_pos", owner, pool]
*/

use pinocchio::{account::AccountView, error::ProgramError, Address};

#[repr(C)]
pub struct EncryptedPosition {
    pub discriminator: [u8; 8],

    /// User who owns this position.
    pub owner: Address,
    /// Lending pool this position belongs to.
    pub pool: Address,

    /// Public key of the EUint64 ciphertext account holding the encrypted
    /// deposit balance.  Pass this account to EncryptContext operations as
    /// the `deposit_ct` argument.
    pub enc_deposit: [u8; 32],

    /// Public key of the EUint64 ciphertext account holding the encrypted
    /// debt balance.  Pass this account to EncryptContext operations as
    /// the `debt_ct` argument.
    pub enc_debt: [u8; 32],

    /// PDA bump.
    pub bump: u8,
    pub _pad: [u8; 7],
}

impl EncryptedPosition {
    pub const DISCRIMINATOR: [u8; 8] = *b"VEILENC!";
    pub const SIZE: usize = 144;

    /// Borrow a shared reference from an account.
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

    /// Borrow a mutable reference from an account.
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

    /// Initialise a freshly-allocated (zeroed) account.
    pub fn init(
        account: &AccountView,
        owner: &Address,
        pool: &Address,
        enc_deposit_key: [u8; 32],
        enc_debt_key: [u8; 32],
        bump: u8,
    ) -> Result<(), ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let raw = unsafe {
            core::slice::from_raw_parts_mut(account.data_ptr() as *mut u8, Self::SIZE)
        };
        raw.fill(0);

        let pos = unsafe { &mut *(account.data_ptr() as *mut Self) };
        pos.discriminator = Self::DISCRIMINATOR;
        pos.owner = *owner;
        pos.pool = *pool;
        pos.enc_deposit = enc_deposit_key;
        pos.enc_debt = enc_debt_key;
        pos.bump = bump;

        Ok(())
    }

    /// Verify that a provided ciphertext account matches the stored enc_deposit key.
    #[inline(always)]
    pub fn verify_deposit_ct(&self, account: &AccountView) -> Result<(), ProgramError> {
        if account.address().as_array() != &self.enc_deposit {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    /// Verify that a provided ciphertext account matches the stored enc_debt key.
    #[inline(always)]
    pub fn verify_debt_ct(&self, account: &AccountView) -> Result<(), ProgramError> {
        if account.address().as_array() != &self.enc_debt {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_matches_layout() {
        assert_eq!(core::mem::size_of::<EncryptedPosition>(), EncryptedPosition::SIZE);
    }

    #[test]
    fn discriminator_is_correct() {
        assert_eq!(&EncryptedPosition::DISCRIMINATOR, b"VEILENC!");
    }

    #[test]
    fn zero_handles_report_zero() {
        let pos: EncryptedPosition = unsafe { core::mem::zeroed() };
        assert_eq!(pos.enc_deposit, [0u8; 32]);
        assert_eq!(pos.enc_debt, [0u8; 32]);
    }
}
