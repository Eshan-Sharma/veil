/*!
Borrow tokens from one pool using deposits in other pool(s) as collateral.

Health factor is computed across all collateral positions using oracle prices:
  HF = Σ(deposit_usd_i × liq_threshold_i) / Σ(debt_usd_j)

Accounts:
  [0]  user                signer, writable
  [1]  borrow_pool         writable
  [2]  borrow_position     writable  — user's position in borrow_pool
  [3]  borrow_vault        writable
  [4]  user_borrow_token   writable  — user's token account for borrowed asset
  [5]  borrow_pool_auth    read-only — PDA that owns borrow_vault
  [6]  token_program
  [7..N]  collateral pairs: (pool, position) — 2 accounts per collateral pool

Instruction data (after discriminator 0x16):
  amount: u64 LE
*/

use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::LendError,
    math,
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
};

pub struct CrossBorrow {
    pub amount: u64,
}

/// Aggregated cross-collateral risk metrics (all WAD-scaled USD).
pub(crate) struct CrossRisk {
    pub(crate) ltv_weighted_collateral_usd: u128,
    pub(crate) liq_weighted_collateral_usd: u128,
    pub(crate) total_debt_usd: u128,
}

/// Read a pool's oracle data and compute the WAD-scaled USD value of a token amount.
#[inline(always)]
pub(crate) fn pool_token_to_usd(pool: &LendingPool, amount: u64) -> Result<u128, ProgramError> {
    if pool.pyth_price_feed == [0u8; 32].into() {
        return Err(LendError::OracleNotAnchored.into());
    }
    math::token_to_usd_wad(amount, pool.oracle_price, pool.oracle_expo, pool.token_decimals)
}

/// Accumulate collateral USD values from a (pool, position) pair.
#[inline(always)]
pub(crate) fn accumulate_collateral(
    pool: &LendingPool,
    pos: &UserPosition,
    user: &Address,
    pool_addr: &Address,
    risk: &mut CrossRisk,
) -> Result<(), ProgramError> {
    pos.verify_binding(user, pool_addr)?;

    let deposit_balance = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
    if deposit_balance == 0 {
        return Ok(());
    }

    let deposit_usd = pool_token_to_usd(pool, deposit_balance)?;

    risk.ltv_weighted_collateral_usd = risk
        .ltv_weighted_collateral_usd
        .checked_add(math::wad_mul(deposit_usd, pool.ltv)?)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    risk.liq_weighted_collateral_usd = risk
        .liq_weighted_collateral_usd
        .checked_add(math::wad_mul(deposit_usd, pool.liquidation_threshold)?)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    Ok(())
}

/// Validate cross-borrow risk constraints.
/// Returns (existing_debt, authority_bump).
#[inline(always)]
pub(crate) fn validate_cross_borrow(
    borrow_pool: &LendingPool,
    borrow_pos: &UserPosition,
    amount: u64,
    risk: &CrossRisk,
) -> Result<(u64, u8), ProgramError> {
    if borrow_pool.paused != 0 {
        return Err(LendError::PoolPaused.into());
    }

    let existing_debt = math::current_borrow_balance(
        borrow_pos.borrow_principal,
        borrow_pool.borrow_index,
        borrow_pos.borrow_index_snapshot,
    )?;

    let existing_debt_usd = pool_token_to_usd(borrow_pool, existing_debt)?;
    let new_borrow_usd = pool_token_to_usd(borrow_pool, amount)?;
    let total_debt_after = risk
        .total_debt_usd
        .checked_add(existing_debt_usd)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_add(new_borrow_usd)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // LTV check: total debt must not exceed LTV-weighted collateral
    let max_borrow_usd = math::cross_max_borrowable_usd(
        risk.ltv_weighted_collateral_usd,
        risk.total_debt_usd.checked_add(existing_debt_usd).ok_or(ProgramError::ArithmeticOverflow)?,
    )?;
    if new_borrow_usd > max_borrow_usd {
        return Err(LendError::ExceedsCollateralFactor.into());
    }

    // Health factor check
    let hf = math::cross_health_factor(risk.liq_weighted_collateral_usd, total_debt_after)?;
    if hf < math::WAD {
        return Err(LendError::Undercollateralised.into());
    }

    // Liquidity check
    let available = borrow_pool
        .total_deposits
        .saturating_sub(borrow_pool.total_borrows)
        .saturating_sub(borrow_pool.accumulated_fees);
    if amount > available {
        return Err(LendError::InsufficientLiquidity.into());
    }

    Ok((existing_debt, borrow_pool.authority_bump))
}

impl CrossBorrow {
    pub const DISCRIMINATOR: u8 = 0x16; // 22

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        // Minimum: 7 fixed accounts + at least 1 collateral pair (2 accounts)
        if accounts.len() < 9 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner / identity checks ──────────────────────────────────────
        check_program_owner(&accounts[1], program_id)?; // borrow_pool
        check_program_owner(&accounts[2], program_id)?; // borrow_position
        check_token_program(&accounts[6])?;
        {
            let pool = LendingPool::from_account(&accounts[1])?;
            check_vault(&accounts[3], pool)?;
        }

        // ── Accrue interest on borrow pool ───────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[1])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Aggregate collateral from trailing account pairs ─────────────
        let collateral_accounts = &accounts[7..];
        if collateral_accounts.len() % 2 != 0 || collateral_accounts.is_empty() {
            return Err(LendError::InvalidInstructionData.into());
        }

        let mut risk = CrossRisk {
            ltv_weighted_collateral_usd: 0,
            liq_weighted_collateral_usd: 0,
            total_debt_usd: 0,
        };

        let user_addr = *accounts[0].address();
        let num_pairs = collateral_accounts.len() / 2;
        for i in 0..num_pairs {
            let coll_pool_idx = 7 + i * 2;
            let coll_pos_idx = 7 + i * 2 + 1;

            check_program_owner(&accounts[coll_pool_idx], program_id)?;
            check_program_owner(&accounts[coll_pos_idx], program_id)?;

            let coll_pool = LendingPool::from_account(&accounts[coll_pool_idx])?;
            let coll_pos = UserPosition::from_account(&accounts[coll_pos_idx])?;
            let coll_pool_addr = *accounts[coll_pool_idx].address();

            accumulate_collateral(coll_pool, coll_pos, &user_addr, &coll_pool_addr, &mut risk)?;

            // Also accumulate any existing debt in collateral pools
            if coll_pos.borrow_principal > 0 {
                let coll_debt = math::current_borrow_balance(
                    coll_pos.borrow_principal,
                    coll_pool.borrow_index,
                    coll_pos.borrow_index_snapshot,
                )?;
                let coll_debt_usd = pool_token_to_usd(coll_pool, coll_debt)?;
                risk.total_debt_usd = risk
                    .total_debt_usd
                    .checked_add(coll_debt_usd)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // ── Also include borrow_pool collateral if user has deposits there
        {
            let borrow_pool = LendingPool::from_account(&accounts[1])?;
            let borrow_pos = UserPosition::from_account(&accounts[2])?;
            let borrow_pool_addr = *accounts[1].address();
            borrow_pos.verify_binding(&user_addr, &borrow_pool_addr)?;

            if borrow_pos.deposit_shares > 0 {
                accumulate_collateral(
                    borrow_pool,
                    borrow_pos,
                    &user_addr,
                    &borrow_pool_addr,
                    &mut risk,
                )?;
            }
        }

        // ── Validate borrow against aggregated risk ──────────────────────
        let (existing_debt, authority_bump) = {
            let borrow_pool = LendingPool::from_account(&accounts[1])?;
            let borrow_pos = UserPosition::from_account(&accounts[2])?;
            validate_cross_borrow(borrow_pool, borrow_pos, self.amount, &risk)?
        };

        // ── Token transfer: borrow_vault → user ──────────────────────────
        let pool_addr = *accounts[1].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[3], &accounts[4], &accounts[5], self.amount)
            .invoke_signed(&[signer])?;

        // ── Update borrow position state ─────────────────────────────────
        let borrow_index = {
            let pool = LendingPool::from_account(&accounts[1])?;
            pool.borrow_index
        };
        {
            let pos = UserPosition::from_account_mut(&accounts[2])?;
            pos.borrow_principal = existing_debt.saturating_add(self.amount);
            pos.borrow_index_snapshot = borrow_index;
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[1])?;
            pool.total_borrows = pool.total_borrows.saturating_add(self.amount);
        }

        // ── Mark every involved position with a fresh set id ─────────────
        // Total positions in the arrangement = collateral pairs + borrow pos.
        let cross_count: u8 = (num_pairs + 1)
            .try_into()
            .map_err(|_| ProgramError::InvalidArgument)?;

        // Generate a set id from the slot/timestamp. Two distinct cross-borrow
        // calls in the same slot from the same user are rejected at the
        // collision-time uniqueness check below — the id only needs to differ
        // from existing set ids on involved positions.
        let set_id: u64 = (clock.slot as u64)
            .wrapping_mul(1_000_003)
            .wrapping_add(clock.unix_timestamp as u64)
            .wrapping_add(self.amount);
        let set_id = if set_id == 0 { 1 } else { set_id };

        // Reject if any involved position is already in a different cross-set.
        // Re-using positions already cross-linked elsewhere would let a user
        // double-pledge collateral.
        for i in 0..num_pairs {
            let coll_pos_idx = 7 + i * 2 + 1;
            let coll_pos = UserPosition::from_account(&accounts[coll_pos_idx])?;
            if coll_pos.cross_collateral != 0 && coll_pos.cross_set_id != set_id {
                return Err(LendError::CrossCollateralActive.into());
            }
        }
        {
            let borrow_pos = UserPosition::from_account(&accounts[2])?;
            if borrow_pos.cross_collateral != 0 && borrow_pos.cross_set_id != set_id {
                return Err(LendError::CrossCollateralActive.into());
            }
        }

        // Reject duplicate pool addresses (substitution / double-counting).
        for i in 0..num_pairs {
            let pool_i = *accounts[7 + i * 2].address();
            if pool_i == *accounts[1].address() {
                return Err(LendError::DuplicateCrossPosition.into());
            }
            for j in (i + 1)..num_pairs {
                let pool_j = *accounts[7 + j * 2].address();
                if pool_i == pool_j {
                    return Err(LendError::DuplicateCrossPosition.into());
                }
            }
        }

        for i in 0..num_pairs {
            let coll_pos_idx = 7 + i * 2 + 1;
            let coll_pos = UserPosition::from_account_mut(&accounts[coll_pos_idx])?;
            coll_pos.cross_collateral = 1;
            coll_pos.cross_set_id = set_id;
            coll_pos.cross_count = cross_count;
        }
        // Also mark the borrow pool position so a plain Withdraw on its
        // collateral cannot bypass the global HF check.
        {
            let borrow_pos = UserPosition::from_account_mut(&accounts[2])?;
            borrow_pos.cross_collateral = 1;
            borrow_pos.cross_set_id = set_id;
            borrow_pos.cross_count = cross_count;
        }

        Ok(())
    }
}

