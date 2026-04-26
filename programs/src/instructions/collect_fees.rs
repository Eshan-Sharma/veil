/*!
Sweep all accumulated protocol fees from the pool vault to a treasury
token account controlled by the pool authority.
Only the pool authority may call this.

Vault balance invariant: vault = total_deposits - total_borrows + accumulated_fees
After sweep: vault = total_deposits - total_borrows, accumulated_fees = 0.

Accounts:
  [0]  authority       signer
  [1]  pool            writable
  [2]  vault           writable  – pool token vault (owned by pool_authority PDA)
  [3]  treasury        writable  – authority's destination token account
  [4]  pool_authority  read-only – PDA that owns the vault
  [5]  token_program

Instruction data (after discriminator 0x10): none
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{errors::LendError, state::LendingPool};

pub struct CollectFees;

#[inline(always)]
fn snapshot_fee_collection(pool: &LendingPool, authority: &Address) -> Result<(u64, u8), ProgramError> {
    if pool.authority != *authority {
        return Err(LendError::Unauthorized.into());
    }
    if pool.accumulated_fees == 0 {
        return Err(LendError::NoFeesToCollect.into());
    }
    Ok((pool.accumulated_fees, pool.authority_bump))
}

#[inline(always)]
fn clear_accumulated_fees(pool: &mut LendingPool) {
    pool.accumulated_fees = 0;
}

impl CollectFees {
    pub const DISCRIMINATOR: u8 = 16;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Self)
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 6 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Authority check and fee snapshot ─────────────────────────────
        let (fee_amount, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[1])?;
            snapshot_fee_collection(pool, accounts[0].address())?
        };

        // ── Transfer fees: vault → treasury ──────────────────────────────
        let pool_addr = *accounts[1].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[2], &accounts[3], &accounts[4], fee_amount)
            .invoke_signed(&[signer])?;

        // ── Zero out fees in pool state ───────────────────────────────────
        {
            let pool = LendingPool::from_account_mut(&accounts[1])?;
            clear_accumulated_fees(pool);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.authority = Address::new_from_array([1u8; 32]);
        pool.authority_bump = 9;
        pool
    }

    #[test]
    fn collect_fees_snapshot_rejects_wrong_authority() {
        let pool = pool();
        assert_eq!(
            snapshot_fee_collection(&pool, &Address::new_from_array([2u8; 32])),
            Err(LendError::Unauthorized.into())
        );
    }

    #[test]
    fn collect_fees_snapshot_rejects_zero_fees() {
        let pool = pool();
        assert_eq!(
            snapshot_fee_collection(&pool, &Address::new_from_array([1u8; 32])),
            Err(LendError::NoFeesToCollect.into())
        );
    }

    #[test]
    fn collect_fees_snapshot_returns_amount_and_bump() {
        let mut pool = pool();
        pool.accumulated_fees = 123;
        assert_eq!(snapshot_fee_collection(&pool, &Address::new_from_array([1u8; 32])), Ok((123, 9)));
    }

    #[test]
    fn collect_fees_clear_zeroes_accumulated_fees() {
        let mut pool = pool();
        pool.accumulated_fees = 123;
        clear_accumulated_fees(&mut pool);
        assert_eq!(pool.accumulated_fees, 0);
    }
}
