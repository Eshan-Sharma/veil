/*!
Deposit tokens; mint supply shares.

shares = amount × WAD / supplyIndex

Accounts:
  [0]  user             signer, writable
  [1]  user_token       writable  – depositor's token account
  [2]  vault            writable  – pool vault
  [3]  pool             writable  – LendingPool PDA
  [4]  user_position    writable  – UserPosition PDA (created if needed)
  [5]  system_program
  [6]  token_program

Instruction data (after discriminator 0x01):
  amount:        u64 LE
  position_bump: u8
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::LendError,
    math,
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct Deposit {
    pub amount: u64,
    pub position_bump: u8,
}

#[inline(always)]
fn validate_new_position_pda(
    program_id: &Address,
    pool_addr: &Address,
    user_addr: &Address,
    position_addr: &Address,
    position_bump: u8,
) -> Result<(), ProgramError> {
    let derived = Address::derive_address(
        &[b"position", pool_addr.as_ref(), user_addr.as_ref()],
        Some(position_bump),
        program_id,
    );
    if derived != *position_addr {
        return Err(LendError::InvalidPda.into());
    }
    Ok(())
}

#[inline(always)]
fn validate_existing_position(
    pos: &UserPosition,
    user_addr: &Address,
    pool_addr: &Address,
) -> Result<(), ProgramError> {
    pos.verify_binding(user_addr, pool_addr)
}

#[inline(always)]
fn compute_deposit_shares(amount: u64, supply_index: u128) -> Result<u64, ProgramError> {
    math::deposit_to_shares(amount, supply_index)
}

#[inline(always)]
fn apply_deposit_to_position(pos: &mut UserPosition, shares: u64, supply_index: u128) {
    pos.deposit_shares = pos.deposit_shares.saturating_add(shares);
    pos.deposit_index_snapshot = supply_index;
}

#[inline(always)]
fn apply_deposit_to_pool(pool: &mut LendingPool, amount: u64) {
    pool.total_deposits = pool.total_deposits.saturating_add(amount);
}

impl Deposit {
    pub const DISCRIMINATOR: u8 = 1;

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
            position_bump: data[8],
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?; // pool

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            if pool.paused != 0 {
                return Err(LendError::PoolPaused.into());
            }
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Create UserPosition if absent ─────────────────────────────────
        let bump_bytes = [self.position_bump];
        let pool_addr = *accounts[3].address();
        let user_addr = *accounts[0].address();

        if accounts[4].lamports() == 0 {
            validate_new_position_pda(
                program_id,
                &pool_addr,
                &user_addr,
                accounts[4].address(),
                self.position_bump,
            )?;

            let rent = Rent::get()?;
            let lamports = rent.try_minimum_balance(UserPosition::SIZE)?;

            let seeds: [Seed; 4] = [
                Seed::from(b"position" as &[u8]),
                Seed::from(pool_addr.as_ref()),
                Seed::from(user_addr.as_ref()),
                Seed::from(&bump_bytes as &[u8]),
            ];
            let signer = Signer::from(seeds.as_slice());

            CreateAccount {
                from: &accounts[0],
                to: &accounts[4],
                lamports,
                space: UserPosition::SIZE as u64,
                owner: program_id,
            }
            .invoke_signed(&[signer])?;

            // Capture current indices BEFORE initializing position.
            let (si, bi) = {
                let pool = LendingPool::from_account(&accounts[3])?;
                (pool.supply_index, pool.borrow_index)
            };

            UserPosition::init(
                &accounts[4],
                &user_addr,
                &pool_addr,
                self.position_bump,
                si,
                bi,
            )?;
        } else {
            let pos = UserPosition::from_account(&accounts[4])?;
            validate_existing_position(pos, &user_addr, &pool_addr)?;
        }

        // ── Compute shares ────────────────────────────────────────────────
        let supply_index = LendingPool::from_account(&accounts[3])?.supply_index;
        let shares = compute_deposit_shares(self.amount, supply_index)?;

        // ── Token transfer: user → vault ──────────────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], self.amount).invoke()?;

        // ── Update state ──────────────────────────────────────────────────
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            apply_deposit_to_position(pos, shares, supply_index);
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            apply_deposit_to_pool(pool, self.amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::WAD;

    fn position() -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.owner = Address::new_from_array([1u8; 32]);
        pos.pool = Address::new_from_array([2u8; 32]);
        pos
    }

    #[test]
    fn deposit_validate_new_position_pda_rejects_wrong_address() {
        assert_eq!(
            validate_new_position_pda(
                &Address::new_from_array([9u8; 32]),
                &Address::new_from_array([2u8; 32]),
                &Address::new_from_array([1u8; 32]),
                &Address::new_from_array([3u8; 32]),
                7,
            ),
            Err(LendError::InvalidPda.into())
        );
    }

    #[test]
    fn deposit_validate_existing_position_checks_binding() {
        let pos = position();
        assert_eq!(
            validate_existing_position(&pos, &Address::new_from_array([1u8; 32]), &Address::new_from_array([2u8; 32])),
            Ok(())
        );
        assert_eq!(
            validate_existing_position(&pos, &Address::new_from_array([8u8; 32]), &Address::new_from_array([2u8; 32])),
            Err(LendError::Unauthorized.into())
        );
    }

    #[test]
    fn deposit_compute_shares_matches_math() {
        assert_eq!(compute_deposit_shares(1_100, WAD + WAD / 10), Ok(1_000));
    }

    #[test]
    fn deposit_apply_position_updates_shares_and_snapshot() {
        let mut pos = position();
        apply_deposit_to_position(&mut pos, 500, 123);
        assert_eq!(pos.deposit_shares, 500);
        assert_eq!(pos.deposit_index_snapshot, 123);
    }

    #[test]
    fn deposit_apply_pool_updates_total_deposits() {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        apply_deposit_to_pool(&mut pool, 700);
        assert_eq!(pool.total_deposits, 700);
    }
}
