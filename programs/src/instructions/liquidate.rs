/*!
Liquidate an undercollateralised position (HF < 1.0).

repayAmount       = totalDebt × closeFactor
seizedCollateral  = repayAmount × (1 + liquidationBonus)
protocolFee       = seizedCollateral × protocolLiqFee
liquidatorGets    = seizedCollateral − protocolFee

Accounts:
  [0]  liquidator         signer, writable
  [1]  liquidator_token   writable
  [2]  vault              writable
  [3]  pool               writable
  [4]  borrower_position  writable
  [5]  pool_authority     read-only
  [6]  token_program

Instruction data (after discriminator 0x05): none
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
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct Liquidate;

#[inline(always)]
fn compute_liquidation_terms(
    pool: &LendingPool,
    pos: &UserPosition,
) -> Result<(u64, u64, u64, u64, u8), ProgramError> {
    if pos.borrow_principal == 0 {
        return Err(LendError::NoBorrow.into());
    }

    let deposit_balance = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
    let total_debt = math::current_borrow_balance(
        pos.borrow_principal,
        pool.borrow_index,
        pos.borrow_index_snapshot,
    )?;

    // Require HF < 1.0
    let hf = math::health_factor(deposit_balance, total_debt, pool.liquidation_threshold)?;
    if hf >= math::WAD {
        return Err(LendError::PositionHealthy.into());
    }

    // repayAmount = totalDebt × closeFactor (50 %)
    let repay = math::wad_mul(total_debt as u128, pool.close_factor)? as u64;
    let repay = repay.min(total_debt);

    // seizedCollateral = repayAmount × (1 + liquidationBonus)
    let one_plus_bonus = math::WAD
        .checked_add(pool.liquidation_bonus)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let seized = math::wad_mul(repay as u128, one_plus_bonus)? as u64;

    if seized > deposit_balance {
        return Err(LendError::InsufficientLiquidity.into());
    }

    let protocol_fee = math::wad_mul(seized as u128, pool.protocol_liq_fee)? as u64;
    let liquidator_gets = seized.saturating_sub(protocol_fee);
    let seized_shares = math::deposit_to_shares(seized, pool.supply_index)?;

    Ok((
        repay,
        liquidator_gets,
        protocol_fee,
        seized_shares,
        pool.authority_bump,
    ))
}

#[inline(always)]
fn apply_liquidation_to_position(
    pos: &mut UserPosition,
    borrow_index: u128,
    supply_index: u128,
    total_debt: u64,
    repay_amount: u64,
    seized_shares: u64,
) {
    pos.borrow_principal = total_debt.saturating_sub(repay_amount);
    pos.borrow_index_snapshot = borrow_index;
    pos.deposit_shares = pos.deposit_shares.saturating_sub(seized_shares);
    pos.deposit_index_snapshot = supply_index;
}

#[inline(always)]
fn apply_liquidation_to_pool(
    pool: &mut LendingPool,
    repay_amount: u64,
    protocol_fee: u64,
    liquidator_gets: u64,
) {
    // Debt reduced by repay.
    pool.total_borrows = pool.total_borrows.saturating_sub(repay_amount);
    // Protocol fee stays in vault as fees.
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
    // Liquidator received collateral (net outflow = liquidator_gets).
    pool.total_deposits = pool.total_deposits.saturating_sub(liquidator_gets);
}

impl Liquidate {
    pub const DISCRIMINATOR: u8 = 5;

    pub fn from_data(_data: &[u8]) -> Result<Self, ProgramError> {
        Ok(Liquidate)
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[3], program_id)?; // pool
        check_program_owner(&accounts[4], program_id)?; // borrower_position

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Compute amounts ───────────────────────────────────────────────
        let (repay_amount, liquidator_gets, protocol_fee, seized_shares, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            compute_liquidation_terms(pool, pos)?
        };

        // ── Step 1: liquidator repays debt → vault ────────────────────────
        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_amount).invoke()?;

        // ── Step 2: vault pays out collateral → liquidator ────────────────
        let pool_addr = *accounts[3].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[2], &accounts[1], &accounts[5], liquidator_gets)
            .invoke_signed(&[signer])?;

        // ── Update borrower position ──────────────────────────────────────
        let (borrow_index, supply_index) = {
            let pool = LendingPool::from_account(&accounts[3])?;
            (pool.borrow_index, pool.supply_index)
        };
        let total_debt = {
            let pool = LendingPool::from_account(&accounts[3])?;
            let pos = UserPosition::from_account(&accounts[4])?;
            math::current_borrow_balance(
                pos.borrow_principal,
                pool.borrow_index,
                pos.borrow_index_snapshot,
            )?
        };
        {
            let pos = UserPosition::from_account_mut(&accounts[4])?;
            apply_liquidation_to_position(
                pos,
                borrow_index,
                supply_index,
                total_debt,
                repay_amount,
                seized_shares,
            );
        }

        // ── Update pool totals ────────────────────────────────────────────
        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            apply_liquidation_to_pool(pool, repay_amount, protocol_fee, liquidator_gets);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{CLOSE_FACTOR, LIQ_BONUS, LIQ_THRESHOLD, PROTOCOL_LIQ_FEE, WAD};

    fn pool_with_defaults() -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.liquidation_bonus = LIQ_BONUS;
        pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
        pool.close_factor = CLOSE_FACTOR;
        pool.authority_bump = 7;
        pool
    }

    fn position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.deposit_shares = deposit_shares;
        pos.borrow_principal = borrow_principal;
        pos.borrow_index_snapshot = WAD;
        pos.deposit_index_snapshot = WAD;
        pos
    }

    #[test]
    fn liquidate_terms_reject_no_borrow() {
        let pool = pool_with_defaults();
        let pos = position(1_000, 0);
        assert_eq!(compute_liquidation_terms(&pool, &pos), Err(LendError::NoBorrow.into()));
    }

    #[test]
    fn liquidate_terms_reject_healthy_position() {
        let pool = pool_with_defaults();
        let pos = position(2_000, 1_000);
        assert_eq!(
            compute_liquidation_terms(&pool, &pos),
            Err(LendError::PositionHealthy.into())
        );
    }

    #[test]
    fn liquidate_terms_reject_when_seizure_exceeds_deposit() {
        let mut pool = pool_with_defaults();
        pool.liquidation_bonus = WAD;
        let pos = position(400, 900);
        assert_eq!(
            compute_liquidation_terms(&pool, &pos),
            Err(LendError::InsufficientLiquidity.into())
        );
    }

    #[test]
    fn liquidate_terms_compute_expected_amounts() {
        let pool = pool_with_defaults();
        let pos = position(1_000, 900);
        let (repay_amount, liquidator_gets, protocol_fee, seized_shares, authority_bump) =
            compute_liquidation_terms(&pool, &pos).unwrap();

        assert_eq!(repay_amount, 450);
        assert_eq!(protocol_fee, 47);
        assert_eq!(liquidator_gets, 425);
        assert_eq!(seized_shares, 472);
        assert_eq!(authority_bump, 7);
    }

    #[test]
    fn liquidate_position_update_reduces_debt_and_collateral() {
        let mut pos = position(1_000, 900);
        apply_liquidation_to_position(&mut pos, 123, 456, 900, 450, 472);

        assert_eq!(pos.borrow_principal, 450);
        assert_eq!(pos.borrow_index_snapshot, 123);
        assert_eq!(pos.deposit_shares, 528);
        assert_eq!(pos.deposit_index_snapshot, 456);
    }

    #[test]
    fn liquidate_pool_update_moves_totals_and_fees() {
        let mut pool = pool_with_defaults();
        pool.total_borrows = 900;
        pool.total_deposits = 1_000;
        pool.accumulated_fees = 10;

        apply_liquidation_to_pool(&mut pool, 450, 47, 425);

        assert_eq!(pool.total_borrows, 450);
        assert_eq!(pool.accumulated_fees, 57);
        assert_eq!(pool.total_deposits, 575);
    }
}
