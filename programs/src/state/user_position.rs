/*!
`UserPosition` — one PDA per (user, pool) pair.

Layout (repr C, 144 bytes):

| offset | size | field                   |
|--------|------|-------------------------|
|   0    |   8  | discriminator           |
|   8    |  32  | owner                   |
|  40    |  32  | pool                    |
|  72    |   8  | deposit_shares          |
|  80    |   8  | borrow_principal        |
|  88    |   8  | _pad0                   |
|  96    |  16  | deposit_index_snapshot  |
| 112    |  16  | borrow_index_snapshot   |
| 128    |   1  | bump                    |
| 129    |  15  | _pad_end                |
| 144    |      | (end)                   |
*/

use pinocchio::{account::AccountView, error::ProgramError, Address};

#[repr(C)]
pub struct UserPosition {
    pub discriminator: [u8; 8],

    /// The wallet that owns this position.
    pub owner: Address,
    /// The lending pool this position belongs to.
    pub pool: Address,

    // ── Deposit side ──────────────────────────────────────────────────────
    /// Shares minted at deposit time.
    /// Actual token balance = deposit_shares × supplyIndex / WAD
    pub deposit_shares: u64,

    // ── Borrow side ───────────────────────────────────────────────────────
    /// Outstanding principal at last update.
    /// Current balance = borrow_principal × currentBorrowIndex / borrow_index_snapshot
    pub borrow_principal: u64,

    pub _pad0: u64,

    // ── Index snapshots (WAD) ─────────────────────────────────────────────
    pub deposit_index_snapshot: u128,
    pub borrow_index_snapshot: u128,

    pub bump: u8,
    pub _pad_end: [u8; 15],
}

impl UserPosition {
    pub const DISCRIMINATOR: [u8; 8] = *b"VEILPOS!";
    pub const SIZE: usize = 144;

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
        account: &AccountView,
        owner: &Address,
        pool: &Address,
        bump: u8,
        deposit_index_snapshot: u128,
        borrow_index_snapshot: u128,
    ) -> Result<(), ProgramError> {
        if account.data_len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        let raw =
            unsafe { core::slice::from_raw_parts_mut(account.data_ptr() as *mut u8, Self::SIZE) };
        raw.fill(0);

        let pos = unsafe { &mut *(account.data_ptr() as *mut Self) };
        pos.discriminator = Self::DISCRIMINATOR;
        pos.owner = *owner;
        pos.pool = *pool;
        pos.bump = bump;
        pos.deposit_index_snapshot = deposit_index_snapshot;
        pos.borrow_index_snapshot = borrow_index_snapshot;
        Ok(())
    }
}
