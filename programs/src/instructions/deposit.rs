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
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
};

pub struct Deposit {
    pub amount: u64,
    pub position_bump: u8,
}

#[inline(always)]
pub(crate) fn validate_new_position_pda(
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
pub(crate) fn validate_existing_position(
    pos: &UserPosition,
    user_addr: &Address,
    pool_addr: &Address,
) -> Result<(), ProgramError> {
    pos.verify_binding(user_addr, pool_addr)
}

/// Smallest acceptable share count produced by a deposit. Below this, the
/// classic ERC-4626 inflation attack lets a first depositor mint a single
/// share, donate tokens directly to the vault, and dilute all subsequent
/// depositors to zero. Rejecting tiny share counts keeps the inflation cost
/// for the attacker prohibitively high.
const MIN_DEPOSIT_SHARES: u64 = 1_000;

#[inline(always)]
pub(crate) fn compute_deposit_shares(amount: u64, supply_index: u128) -> Result<u64, ProgramError> {
    let shares = math::deposit_to_shares(amount, supply_index)?;
    if shares < MIN_DEPOSIT_SHARES {
        return Err(LendError::ZeroAmount.into());
    }
    Ok(shares)
}

#[inline(always)]
pub(crate) fn apply_deposit_to_position(pos: &mut UserPosition, shares: u64, supply_index: u128) {
    pos.deposit_shares = pos.deposit_shares.saturating_add(shares);
    pos.deposit_index_snapshot = supply_index;
}

#[inline(always)]
pub(crate) fn apply_deposit_to_pool(pool: &mut LendingPool, amount: u64) {
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

        check_program_owner(&accounts[3], program_id)?;
        check_token_program(&accounts[6])?;

        let clock = Clock::get()?;
        let (supply_index, borrow_index) = {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
            if pool.paused != 0 {
                return Err(LendError::PoolPaused.into());
            }
            pool.accrue_interest(clock.unix_timestamp)?;
            (pool.supply_index, pool.borrow_index)
        };

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

            UserPosition::init(
                &accounts[4],
                &user_addr,
                &pool_addr,
                self.position_bump,
                supply_index,
                borrow_index,
            )?;
        } else {
            let pos = UserPosition::from_account(&accounts[4])?;
            validate_existing_position(pos, &user_addr, &pool_addr)?;
        }

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

