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
    instructions::update_oracle_price::MAX_ORACLE_AGE,
    math,
    state::{check_program_owner, check_token_program, check_vault, LendingPool, UserPosition},
};

pub struct Liquidate;

#[inline(always)]
pub(crate) fn compute_liquidation_terms(
    pool: &LendingPool,
    pos: &UserPosition,
) -> Result<(u64, u64, u64, u64, u8, u64), ProgramError> {
    if pos.borrow_principal == 0 {
        return Err(LendError::NoBorrow.into());
    }

    let deposit_balance = math::current_deposit_balance(pos.deposit_shares, pool.supply_index)?;
    let total_debt = math::current_borrow_balance(
        pos.borrow_principal,
        pool.borrow_index,
        pos.borrow_index_snapshot,
    )?;

    let hf = math::health_factor(deposit_balance, total_debt, pool.liquidation_threshold)?;
    if hf >= math::WAD {
        return Err(LendError::PositionHealthy.into());
    }

    let repay = math::wad_mul(total_debt as u128, pool.close_factor)? as u64;
    let repay = repay.min(total_debt);

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
        total_debt,
    ))
}

#[inline(always)]
pub(crate) fn apply_liquidation_to_position(
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
pub(crate) fn apply_liquidation_to_pool(
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

        check_program_owner(&accounts[3], program_id)?;
        check_program_owner(&accounts[4], program_id)?;
        check_token_program(&accounts[6])?;

        let clock = Clock::get()?;
        let (
            repay_amount,
            liquidator_gets,
            protocol_fee,
            seized_shares,
            authority_bump,
            total_debt,
            borrow_index,
            supply_index,
        ) = {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            check_vault(&accounts[2], pool)?;
            // Per-tx oracle freshness gate. Without this, a liquidator could
            // wait for the cached price to drift in their favour and trigger
            // liquidation on a price that no longer reflects reality.
            // oracle_updated_at == 0 means the pool was just initialised and
            // no one has run update_oracle_price; treat that as stale.
            if pool.oracle_updated_at == 0
                || clock.unix_timestamp.saturating_sub(pool.oracle_updated_at) > MAX_ORACLE_AGE
            {
                return Err(LendError::OraclePriceStale.into());
            }
            pool.accrue_interest(clock.unix_timestamp)?;

            let pos = UserPosition::from_account(&accounts[4])?;
            if &pos.pool != accounts[3].address() {
                return Err(ProgramError::InvalidAccountData);
            }
            // Self-liquidation lets the borrower preempt other liquidators and
            // skim the bonus they would have lost anyway. Reject it.
            if &pos.owner == accounts[0].address() {
                return Err(LendError::SelfLiquidation.into());
            }
            let (repay, gets, fee, shares, bump, debt) = compute_liquidation_terms(pool, pos)?;
            (
                repay, gets, fee, shares, bump, debt,
                pool.borrow_index, pool.supply_index,
            )
        };

        Transfer::new(&accounts[1], &accounts[2], &accounts[0], repay_amount).invoke()?;

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

        {
            let pool = LendingPool::from_account_mut(&accounts[3])?;
            apply_liquidation_to_pool(pool, repay_amount, protocol_fee, liquidator_gets);
        }

        Ok(())
    }
}

