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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;

    fn default_position() -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.deposit_index_snapshot = WAD;
        pos.borrow_index_snapshot = WAD;
        pos
    }

    #[test]
    fn size_matches_layout() {
        assert_eq!(core::mem::size_of::<UserPosition>(), UserPosition::SIZE);
    }

    #[test]
    fn discriminator_is_correct() {
        assert_eq!(UserPosition::DISCRIMINATOR, *b"VEILPOS!");
    }

    #[test]
    fn default_position_zero_shares_and_debt() {
        let pos = default_position();
        assert_eq!(pos.deposit_shares, 0);
        assert_eq!(pos.borrow_principal, 0);
    }

    #[test]
    fn default_position_index_snapshots_at_wad() {
        let pos = default_position();
        assert_eq!(pos.deposit_index_snapshot, WAD);
        assert_eq!(pos.borrow_index_snapshot, WAD);
    }

    #[test]
    fn deposit_shares_accumulate() {
        let mut pos = default_position();
        pos.deposit_shares = pos.deposit_shares.saturating_add(1_000);
        pos.deposit_shares = pos.deposit_shares.saturating_add(2_000);
        assert_eq!(pos.deposit_shares, 3_000);
    }

    #[test]
    fn borrow_principal_can_be_updated() {
        let mut pos = default_position();
        pos.borrow_principal = 500_000;
        assert_eq!(pos.borrow_principal, 500_000);
    }

    #[test]
    fn deposit_shares_saturating_sub_no_underflow() {
        let mut pos = default_position();
        pos.deposit_shares = 100;
        pos.deposit_shares = pos.deposit_shares.saturating_sub(200);
        assert_eq!(pos.deposit_shares, 0, "saturating_sub must not underflow");
    }

    #[test]
    fn borrow_principal_repay_to_zero() {
        let mut pos = default_position();
        pos.borrow_principal = 1_000;
        let debt = pos.borrow_principal;
        pos.borrow_principal = debt.saturating_sub(debt); // full repay
        assert_eq!(pos.borrow_principal, 0);
    }
}
