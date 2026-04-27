/*!
Withdraw collateral from a pool that is part of a cross-collateral arrangement.

Re-checks global HF across all pools after withdrawal to ensure solvency.

Accounts:
  [0]  user              signer, writable
  [1]  withdraw_pool     writable
  [2]  withdraw_position writable
  [3]  vault             writable
  [4]  user_token        writable
  [5]  pool_authority    read-only  — PDA that owns vault
  [6]  token_program
  [7..N]  related pairs: (pool, position) — all other positions for global HF check

Instruction data (after discriminator 0x17):
  shares: u64 LE
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

pub struct CrossWithdraw {
    pub shares: u64,
}

/// Compute global HF after withdrawal.
/// Returns (token_amount, authority_bump).
#[inline(always)]
fn validate_cross_withdraw(
    pool: &LendingPool,
    pos: &UserPosition,
    shares: u64,
) -> Result<(u64, u8), ProgramError> {
    if pos.deposit_shares < shares {
        return Err(LendError::ExceedsDepositBalance.into());
    }

    let token_amount = math::current_deposit_balance(shares, pool.supply_index)?;

    let available = pool
        .total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    if token_amount > available {
        return Err(LendError::InsufficientLiquidity.into());
    }

    Ok((token_amount, pool.authority_bump))
}

/// Read a pool's oracle and compute WAD-scaled USD value.
#[inline(always)]
fn pool_token_to_usd(pool: &LendingPool, amount: u64) -> Result<u128, ProgramError> {
    if pool.pyth_price_feed == [0u8; 32].into() {
        return Err(LendError::OracleNotAnchored.into());
    }
    math::token_to_usd_wad(amount, pool.oracle_price, pool.oracle_expo, pool.token_decimals)
}

impl CrossWithdraw {
    pub const DISCRIMINATOR: u8 = 0x17; // 23

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(LendError::InvalidInstructionData.into());
        }
        Ok(Self {
            shares: u64::from_le_bytes(data[..8].try_into().unwrap()),
        })
    }

    pub fn process(self, program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 7 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }
        if self.shares == 0 {
            return Err(LendError::ZeroAmount.into());
        }

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[1], program_id)?; // withdraw_pool
        check_program_owner(&accounts[2], program_id)?; // withdraw_position

        // ── Accrue interest ───────────────────────────────────────────────
        let clock = Clock::get()?;
        {
            let pool = LendingPool::from_account_mut(&accounts[1])?;
            pool.accrue_interest(clock.unix_timestamp)?;
        }

        // ── Validate withdrawal ──────────────────────────────────────────
        let (token_amount, authority_bump) = {
            let pool = LendingPool::from_account(&accounts[1])?;
            let pos = UserPosition::from_account(&accounts[2])?;
            pos.verify_binding(accounts[0].address(), accounts[1].address())?;
            validate_cross_withdraw(pool, pos, self.shares)?
        };

        // ── Compute global HF after withdrawal ──────────────────────────
        let user_addr = *accounts[0].address();
        let mut total_collateral_usd: u128 = 0;
        let mut total_debt_usd: u128 = 0;

        // Include the withdraw pool's position (after withdrawal)
        {
            let pool = LendingPool::from_account(&accounts[1])?;
            let pos = UserPosition::from_account(&accounts[2])?;

            let remaining_shares = pos.deposit_shares - self.shares;
            let remaining_deposit = math::current_deposit_balance(remaining_shares, pool.supply_index)?;
            if remaining_deposit > 0 {
                let deposit_usd = pool_token_to_usd(pool, remaining_deposit)?;
                total_collateral_usd = total_collateral_usd
                    .checked_add(math::wad_mul(deposit_usd, pool.liquidation_threshold)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }

            if pos.borrow_principal > 0 {
                let debt = math::current_borrow_balance(
                    pos.borrow_principal,
                    pool.borrow_index,
                    pos.borrow_index_snapshot,
                )?;
                let debt_usd = pool_token_to_usd(pool, debt)?;
                total_debt_usd = total_debt_usd
                    .checked_add(debt_usd)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // Include all related positions
        let related_accounts = &accounts[7..];
        if related_accounts.len() % 2 != 0 {
            return Err(LendError::InvalidInstructionData.into());
        }

        let num_pairs = related_accounts.len() / 2;
        for i in 0..num_pairs {
            let pool_idx = 7 + i * 2;
            let pos_idx = 7 + i * 2 + 1;

            check_program_owner(&accounts[pool_idx], program_id)?;
            check_program_owner(&accounts[pos_idx], program_id)?;

            let rel_pool = LendingPool::from_account(&accounts[pool_idx])?;
            let rel_pos = UserPosition::from_account(&accounts[pos_idx])?;
            let rel_pool_addr = *accounts[pool_idx].address();
            rel_pos.verify_binding(&user_addr, &rel_pool_addr)?;

            if rel_pos.deposit_shares > 0 {
                let deposit = math::current_deposit_balance(rel_pos.deposit_shares, rel_pool.supply_index)?;
                let deposit_usd = pool_token_to_usd(rel_pool, deposit)?;
                total_collateral_usd = total_collateral_usd
                    .checked_add(math::wad_mul(deposit_usd, rel_pool.liquidation_threshold)?)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }

            if rel_pos.borrow_principal > 0 {
                let debt = math::current_borrow_balance(
                    rel_pos.borrow_principal,
                    rel_pool.borrow_index,
                    rel_pos.borrow_index_snapshot,
                )?;
                let debt_usd = pool_token_to_usd(rel_pool, debt)?;
                total_debt_usd = total_debt_usd
                    .checked_add(debt_usd)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }

        // Check global HF if any debt exists
        if total_debt_usd > 0 {
            let hf = math::cross_health_factor(total_collateral_usd, total_debt_usd)?;
            if hf < math::WAD {
                return Err(LendError::Undercollateralised.into());
            }
        }

        // ── Token transfer: vault → user ──────────────────────────────────
        let pool_addr = *accounts[1].address();
        let bump_bytes = [authority_bump];
        let seeds: [Seed; 3] = [
            Seed::from(b"authority" as &[u8]),
            Seed::from(pool_addr.as_ref()),
            Seed::from(&bump_bytes as &[u8]),
        ];
        let signer = Signer::from(seeds.as_slice());

        Transfer::new(&accounts[3], &accounts[4], &accounts[5], token_amount)
            .invoke_signed(&[signer])?;

        // ── Update state ──────────────────────────────────────────────────
        let supply_index = LendingPool::from_account(&accounts[1])?.supply_index;
        {
            let pos = UserPosition::from_account_mut(&accounts[2])?;
            pos.deposit_shares = pos.deposit_shares.saturating_sub(self.shares);
            pos.deposit_index_snapshot = supply_index;

            // Clear cross_collateral flag if position is fully empty
            if pos.deposit_shares == 0 && pos.borrow_principal == 0 {
                pos.cross_collateral = 0;
            }
        }
        {
            let pool = LendingPool::from_account_mut(&accounts[1])?;
            pool.total_deposits = pool.total_deposits.saturating_sub(token_amount);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{LIQ_THRESHOLD, WAD};

    fn pool(total_deposits: u64) -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.authority_bump = 5;
        pool.total_deposits = total_deposits;
        pool.pyth_price_feed = [1u8; 32].into();
        pool.oracle_price = 100_000_000;
        pool.oracle_expo = -8;
        pool.token_decimals = 6;
        pool
    }

    fn position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.deposit_shares = deposit_shares;
        pos.borrow_principal = borrow_principal;
        pos.deposit_index_snapshot = WAD;
        pos.borrow_index_snapshot = WAD;
        pos
    }

    #[test]
    fn cross_withdraw_rejects_excess_shares() {
        let p = pool(10_000_000);
        assert_eq!(
            validate_cross_withdraw(&p, &position(100, 0), 101),
            Err(LendError::ExceedsDepositBalance.into())
        );
    }

    #[test]
    fn cross_withdraw_rejects_insufficient_liquidity() {
        let mut p = pool(500_000);
        p.total_borrows = 100_000;
        p.accumulated_fees = 50_000;
        assert_eq!(
            validate_cross_withdraw(&p, &position(1_000_000, 0), 600_000),
            Err(LendError::InsufficientLiquidity.into())
        );
    }

    #[test]
    fn cross_withdraw_returns_token_amount_and_bump() {
        let p = pool(10_000_000);
        assert_eq!(
            validate_cross_withdraw(&p, &position(1_000, 0), 500),
            Ok((500, 5))
        );
    }

    // ── Positive: withdraw all shares when no debt ──────────────────────

    #[test]
    fn cross_withdraw_all_shares_no_debt() {
        let p = pool(10_000_000);
        let result = validate_cross_withdraw(&p, &position(5_000, 0), 5_000);
        assert!(result.is_ok());
        let (amount, bump) = result.unwrap();
        assert_eq!(amount, 5_000);
        assert_eq!(bump, 5);
    }

    // ── Negative: withdraw exactly one more than available ──────────────

    #[test]
    fn cross_withdraw_one_over_deposit() {
        let p = pool(10_000_000);
        assert_eq!(
            validate_cross_withdraw(&p, &position(1_000, 0), 1_001),
            Err(LendError::ExceedsDepositBalance.into())
        );
    }

    // ── Negative: pool fully utilized — no available tokens ─────────────

    #[test]
    fn cross_withdraw_zero_available() {
        let mut p = pool(1_000);
        p.total_borrows = 1_000; // 100% utilized
        assert_eq!(
            validate_cross_withdraw(&p, &position(1_000, 0), 1),
            Err(LendError::InsufficientLiquidity.into())
        );
    }

    // ── Positive: partial withdraw leaves enough collateral ─────────────

    #[test]
    fn cross_withdraw_partial_with_debt_ok() {
        let p = pool(10_000);
        // Position: 2000 deposit shares, 0 borrow in this pool
        // (Debt is in another pool — validated in process(), not here)
        let result = validate_cross_withdraw(&p, &position(2_000, 0), 500);
        assert!(result.is_ok());
    }
}
