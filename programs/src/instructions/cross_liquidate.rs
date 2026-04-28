/*!
Liquidate a cross-collateral position where global HF < 1.0.

Liquidator repays debt tokens in the debt pool and receives collateral tokens
from a different (collateral) pool. Seized amount is converted via oracle prices.

repayAmount (debt tokens) → repay_usd → collateral_usd × (1 + bonus) → collateral tokens

Accounts:
  [0]   liquidator            signer, writable
  [1]   liquidator_debt_token writable  — liquidator pays debt tokens
  [2]   liquidator_coll_token writable  — liquidator receives collateral tokens
  [3]   debt_pool             writable
  [4]   debt_position         writable  — borrower's position in debt pool
  [5]   debt_vault            writable
  [6]   coll_pool             writable
  [7]   coll_position         writable  — borrower's position in collateral pool
  [8]   coll_vault            writable
  [9]   coll_pool_authority   read-only — PDA
  [10]  token_program
  [11..N]  other (pool, position) pairs for global HF check

Instruction data (after discriminator 0x19):
  repay_amount: u64 LE  (in debt token units)
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

pub struct CrossLiquidate {
    pub repay_amount: u64,
}

/// Read a pool's oracle and compute WAD-scaled USD value.
#[inline(always)]
pub(crate) fn pool_token_to_usd(pool: &LendingPool, amount: u64) -> Result<u128, ProgramError> {
    if pool.pyth_price_feed == [0u8; 32].into() {
        return Err(LendError::OracleNotAnchored.into());
    }
    math::token_to_usd_wad(amount, pool.oracle_price, pool.oracle_expo, pool.token_decimals)
}

/// Compute cross-liquidation terms.
/// Returns (capped_repay, collateral_seized_tokens, protocol_fee_tokens, seized_shares).
#[inline(always)]
pub(crate) fn compute_cross_liquidation_terms(
    debt_pool: &LendingPool,
    debt_pos: &UserPosition,
    coll_pool: &LendingPool,
    coll_pos: &UserPosition,
    requested_repay: u64,
    global_collateral_usd: u128,
    global_debt_usd: u128,
) -> Result<(u64, u64, u64, u64), ProgramError> {
    if debt_pos.borrow_principal == 0 {
        return Err(LendError::NoBorrow.into());
    }

    // Check global HF < 1.0
    let hf = math::cross_health_factor(global_collateral_usd, global_debt_usd)?;
    if hf >= math::WAD {
        return Err(LendError::PositionHealthy.into());
    }

    let total_debt = math::current_borrow_balance(
        debt_pos.borrow_principal,
        debt_pool.borrow_index,
        debt_pos.borrow_index_snapshot,
    )?;

    // Enforce close_factor
    let max_repay = math::wad_mul(total_debt as u128, debt_pool.close_factor)? as u64;
    let repay = requested_repay.min(max_repay).min(total_debt);

    // Convert repay to USD
    let repay_usd = pool_token_to_usd(debt_pool, repay)?;

    // Apply liquidation bonus: seized_usd = repay_usd × (1 + bonus)
    let one_plus_bonus = math::WAD
        .checked_add(coll_pool.liquidation_bonus)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let seized_usd = math::wad_mul(repay_usd, one_plus_bonus)?;

    // Convert seized USD to collateral tokens
    let seized_tokens = math::usd_wad_to_tokens(
        seized_usd,
        coll_pool.oracle_price,
        coll_pool.oracle_expo,
        coll_pool.token_decimals,
    )?;

    // Check borrower has enough collateral
    let coll_deposit = math::current_deposit_balance(coll_pos.deposit_shares, coll_pool.supply_index)?;
    if seized_tokens > coll_deposit {
        return Err(LendError::InsufficientLiquidity.into());
    }

    // Protocol fee on seized collateral
    let protocol_fee = math::wad_mul(seized_tokens as u128, coll_pool.protocol_liq_fee)? as u64;
    let seized_shares = math::deposit_to_shares(seized_tokens, coll_pool.supply_index)?;

    Ok((repay, seized_tokens.saturating_sub(protocol_fee), protocol_fee, seized_shares))
}

impl CrossLiquidate {
    pub const DISCRIMINATOR: u8 = 0x19; // 25

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            repay_amount: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 11 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.repay_amount == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner / identity checks ──────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?;  // debt_pool
        check_program_owner(&accounts[4], program_id)?;  // debt_position
        check_program_owner(&accounts[6], program_id)?;  // coll_pool
        check_program_owner(&accounts[7], program_id)?;  // coll_position
        check_token_program(&accounts[10])?;
        {
            let debt_pool = LendingPool::from_account(&accounts[3])?;
            check_vault(&accounts[5], debt_pool)?;
        }
        {
            let coll_pool = LendingPool::from_account(&accounts[6])?;
            check_vault(&accounts[8], coll_pool)?;
        }

        // ── Accrue interest on both pools ─────────────────────────────────
        let clock = Clock::get()?;
        {
            let debt_pool = LendingPool::from_account_mut(&accounts[3])?;
            debt_pool.accrue_interest(clock.unix_timestamp)?;
        }
        {
            let coll_pool = LendingPool::from_account_mut(&accounts[6])?;
            coll_pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Compute global HF from all borrower positions ────────────────
        let mut global_collateral_usd: u128 = 0;
        let mut global_debt_usd: u128 = 0;

        // Borrower address from debt_position
        let borrower_addr = {
            let debt_pos = UserPosition::from_account(&accounts[4])?;
            debt_pos.owner
        };

        // Self-liquidation is forbidden: combined with vault validation gone
        // wrong elsewhere it becomes a primitive for seizing pool collateral
        // against attacker-controlled phantom debt.
        if &borrower_addr == accounts[0].address() {
            return Err(LendError::SelfLiquidation.into());
        }

        // Include debt pool position
        {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            let pool_addr = *accounts[3].address();
            pos.verify_binding(&borrower_addr, &pool_addr)?;

            if pos.deposit_shares > 0 {
                let dep = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
                let dep_usd = pool_token_to_usd(pool, dep)?;
                global_collateral_usd = global_collateral_usd
                    .checked_add(math::wad_mul(dep_usd, pool.liquidation_threshold)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
            if pos.borrow_principal > 0 {
                let debt = math::current_borrow_balance(
                    pos.borrow_principal, pool.borrow_index, pos.borrow_index_snapshot,
                )?;
                global_debt_usd = global_debt_usd
                    .checked_add(pool_token_to_usd(pool, debt)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // Include collateral pool position
        {
            let pool = LendingPool::from_account(&accounts[6])?;
            let pos = UserPosition::from_account(&accounts[7])?;
            let pool_addr = *accounts[6].address();
            pos.verify_binding(&borrower_addr, &pool_addr)?;

            if pos.deposit_shares > 0 {
                let dep = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
                let dep_usd = pool_token_to_usd(pool, dep)?;
                global_collateral_usd = global_collateral_usd
                    .checked_add(math::wad_mul(dep_usd, pool.liquidation_threshold)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
            if pos.borrow_principal > 0 {
                let debt = math::current_borrow_balance(
                    pos.borrow_principal, pool.borrow_index, pos.borrow_index_snapshot,
                )?;
                global_debt_usd = global_debt_usd
                    .checked_add(pool_token_to_usd(pool, debt)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // ── Cross-collateral registry checks ─────────────────────────────
        // The borrower's debt position drives the cross-set: every trailing
        // pair must share its set_id, and the total count (debt + collateral
        // + trailing) must equal the recorded cross_count. Otherwise an
        // attacker omits a heavy collateral pool to fake an unhealthy HF and
        // steal collateral.
        let trailing = &accounts[11..];
        if trailing.len() % 2 != 0 {
            return Err(LendError::InvalidInstructionData.into());
        }
        let num_pairs = trailing.len() / 2;

        let (debt_set_id, debt_count, debt_cross) = {
            let pos = UserPosition::from_account(&accounts[4])?;
            (pos.cross_set_id, pos.cross_count, pos.cross_collateral)
        };

        if debt_cross != 0 {
            let supplied: u8 = (num_pairs + 2)
                .try_into()
                .map_err(|_| ProgramError::InvalidArgument)?;
            if supplied != debt_count {
                return Err(LendError::CrossPositionCountMismatch.into());
            }
            // Collateral position must share the same cross-set.
            let coll_pos_set = UserPosition::from_account(&accounts[7])?.cross_set_id;
            if coll_pos_set != debt_set_id {
                return Err(LendError::CrossPositionCountMismatch.into());
            }
        }

        // Reject duplicate pool addresses across all supplied pools.
        let head_debt_pool = *accounts[3].address();
        let head_coll_pool = *accounts[6].address();
        if head_debt_pool == head_coll_pool {
            return Err(LendError::DuplicateCrossPosition.into());
        }
        for i in 0..num_pairs {
            let pool_i = *accounts[11 + i * 2].address();
            if pool_i == head_debt_pool || pool_i == head_coll_pool {
                return Err(LendError::DuplicateCrossPosition.into());
            }
            for j in (i + 1)..num_pairs {
                let pool_j = *accounts[11 + j * 2].address();
                if pool_i == pool_j {
                    return Err(LendError::DuplicateCrossPosition.into());
                }
            }
        }

        for i in 0..num_pairs {
            let p_idx = 11 + i * 2;
            let pos_idx = 11 + i * 2 + 1;
            check_program_owner(&accounts[p_idx], program_id)?;
            check_program_owner(&accounts[pos_idx], program_id)?;

            let pool = LendingPool::from_account(&accounts[p_idx])?;
            let pos = UserPosition::from_account(&accounts[pos_idx])?;
            let pool_addr = *accounts[p_idx].address();
            pos.verify_binding(&borrower_addr, &pool_addr)?;

            if debt_cross != 0 && pos.cross_set_id != debt_set_id {
                return Err(LendError::CrossPositionCountMismatch.into());
            }

            if pos.deposit_shares > 0 {
                let dep = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
                let dep_usd = pool_token_to_usd(pool, dep)?;
                global_collateral_usd = global_collateral_usd
                    .checked_add(math::wad_mul(dep_usd, pool.liquidation_threshold)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
            if pos.borrow_principal > 0 {
                let debt = math::current_borrow_balance(
                    pos.borrow_principal, pool.borrow_index, pos.borrow_index_snapshot,
                )?;
                global_debt_usd = global_debt_usd
                    .checked_add(pool_token_to_usd(pool, debt)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // ── Compute liquidation terms ────────────────────────────────────
        let (repay, liquidator_gets, protocol_fee, seized_shares) = {
            let debt_pool = LendingPool::from_account(&accounts[3])?;
            let debt_pos = UserPosition::from_account(&accounts[4])?;
            let coll_pool = LendingPool::from_account(&accounts[6])?;
            let coll_pos = UserPosition::from_account(&accounts[7])?;

            compute_cross_liquidation_terms(
                debt_pool,
                debt_pos,
                coll_pool,
                coll_pos,
                self.repay_amount,
                global_collateral_usd,
                global_debt_usd,
            )?
        };

        // ── Step 1: liquidator repays debt → debt_vault ──────────────────
        Transfer::new(&accounts[1], &accounts[5], &accounts[0], repay).invoke()?;

        // ── Step 2: collateral_vault → liquidator ────────────────────────
        let coll_pool_addr = *accounts[6].address();
        let coll_bump = {
            let coll_pool = LendingPool::from_account(&accounts[6])?;
            coll_pool.authority_bump
        };
        let bump_bytes = [coll_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(coll_pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[8], &accounts[2], &accounts[9], liquidator_gets)
            .invoke_signed(&[signer])?;

        // ── Update debt position ─────────────────────────────────────────
        {
            let debt_pool = LendingPool::from_account(&accounts[3])?;
            let total_debt = {
                let pos = UserPosition::from_account(&accounts[4])?;
                math::current_borrow_balance(
                    pos.borrow_principal,
                    debt_pool.borrow_index,
                    pos.borrow_index_snapshot,
                )?
            };
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            pos.borrow_principal = total_debt.saturating_sub(repay);
            pos.borrow_index_snapshot = debt_pool.borrow_index;
        }

        // ── Update debt pool totals ──────────────────────────────────────
        // Depositor claims unchanged by repay; interest already credited via accrue.
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.total_borrows = pool.total_borrows.saturating_sub(repay);
        }

        // ── Update collateral position ───────────────────────────────────
        {
            let coll_pool = LendingPool::from_account(&accounts[6])?;
            let pos = UserPosition::from_account_mut(&accounts[7])?;
            pos.deposit_shares = pos.deposit_shares.saturating_sub(seized_shares);
            pos.deposit_index_snapshot = coll_pool.supply_index;
        }

        // ── Update collateral pool totals ────────────────────────────────
        {
            let pool = LendingPool::from_account_mut(&accounts[6])?;
            pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
            pool.total_deposits = pool.total_deposits.saturating_sub(liquidator_gets);
        }

        Ok(())
    }
}

