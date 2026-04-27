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
    state::{check_program_owner, LendingPool, UserPosition},
};

pub struct CrossBorrow {
    pub amount: u64,
}

/// Aggregated cross-collateral risk metrics (all WAD-scaled USD).
struct CrossRisk {
    ltv_weighted_collateral_usd: u128,
    liq_weighted_collateral_usd: u128,
    total_debt_usd: u128,
}

/// Read a pool's oracle data and compute the WAD-scaled USD value of a token amount.
#[inline(always)]
fn pool_token_to_usd(pool: &LendingPool, amount: u64) -> Result<u128, ProgramError> {
    if pool.pyth_price_feed == [0u8; 32].into() {
        return Err(LendError::OracleNotAnchored.into());
    }
    math::token_to_usd_wad(amount, pool.oracle_price, pool.oracle_expo, pool.token_decimals)
}

/// Accumulate collateral USD values from a (pool, position) pair.
#[inline(always)]
fn accumulate_collateral(
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
fn validate_cross_borrow(
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

        // ── Owner checks ─────────────────────────────────────────────────
        check_program_owner(&accounts[1], program_id)?; // borrow_pool
        check_program_owner(&accounts[2], program_id)?; // borrow_position

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

        // ── Mark collateral positions as cross-collateral ────────────────
        for i in 0..num_pairs {
            let coll_pos_idx = 7 + i * 2 + 1;
            let coll_pos = UserPosition::from_account_mut(&accounts[coll_pos_idx])?;
            coll_pos.cross_collateral = 1;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{LIQ_THRESHOLD, LTV, WAD};

    fn make_pool(
        total_deposits: u64,
        total_borrows: u64,
        oracle_price: i64,
        oracle_expo: i32,
        token_decimals: u8,
    ) -> LendingPool {
        let mut pool: LendingPool = unsafe { core::mem::zeroed() };
        pool.discriminator = LendingPool::DISCRIMINATOR;
        pool.borrow_index = WAD;
        pool.supply_index = WAD;
        pool.ltv = LTV;
        pool.liquidation_threshold = LIQ_THRESHOLD;
        pool.authority_bump = 5;
        pool.total_deposits = total_deposits;
        pool.total_borrows = total_borrows;
        pool.pyth_price_feed = [1u8; 32].into();
        pool.oracle_price = oracle_price;
        pool.oracle_expo = oracle_expo;
        pool.token_decimals = token_decimals;
        pool
    }

    fn make_position(deposit_shares: u64, borrow_principal: u64) -> UserPosition {
        let mut pos: UserPosition = unsafe { core::mem::zeroed() };
        pos.discriminator = UserPosition::DISCRIMINATOR;
        pos.deposit_shares = deposit_shares;
        pos.borrow_principal = borrow_principal;
        pos.deposit_index_snapshot = WAD;
        pos.borrow_index_snapshot = WAD;
        pos
    }

    #[test]
    fn pool_token_to_usd_rejects_no_oracle() {
        let mut pool = make_pool(1000, 0, 100_000_000, -8, 6);
        pool.pyth_price_feed = [0u8; 32].into();
        assert!(pool_token_to_usd(&pool, 1_000_000).is_err());
    }

    #[test]
    fn pool_token_to_usd_usdc() {
        let pool = make_pool(1000, 0, 100_000_000, -8, 6);
        let usd = pool_token_to_usd(&pool, 1_000_000).unwrap();
        assert_eq!(usd, WAD); // $1.00
    }

    #[test]
    fn accumulate_collateral_adds_weighted_usd() {
        let pool = make_pool(10_000_000, 0, 100_000_000, -8, 6); // USDC pool
        let user = [42u8; 32].into();
        let pool_addr = [99u8; 32].into();
        let mut pos = make_position(10_000_000, 0); // 10 USDC
        pos.owner = user;
        pos.pool = pool_addr;

        let mut risk = CrossRisk {
            ltv_weighted_collateral_usd: 0,
            liq_weighted_collateral_usd: 0,
            total_debt_usd: 0,
        };

        accumulate_collateral(&pool, &pos, &user, &pool_addr, &mut risk).unwrap();

        // 10 USDC = $10 = 10 * WAD
        // LTV-weighted = 10 * 0.75 = 7.5 * WAD
        // Liq-weighted = 10 * 0.80 = 8.0 * WAD
        assert_eq!(risk.ltv_weighted_collateral_usd, WAD * 75 / 10);
        assert_eq!(risk.liq_weighted_collateral_usd, WAD * 8);
    }

    #[test]
    fn validate_cross_borrow_rejects_paused() {
        let mut pool = make_pool(10_000_000, 0, 15_000_000_000, -8, 9);
        pool.paused = 1;
        let pos = make_position(0, 0);
        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 1000 * WAD,
            liq_weighted_collateral_usd: 1000 * WAD,
            total_debt_usd: 0,
        };
        assert_eq!(
            validate_cross_borrow(&pool, &pos, 1, &risk),
            Err(LendError::PoolPaused.into())
        );
    }

    #[test]
    fn validate_cross_borrow_rejects_exceeds_ltv() {
        // USDC collateral: $100 × 0.75 LTV = $75 max borrow
        // Borrow SOL: try $80 worth → should fail
        let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD, // $75 LTV-weighted
            liq_weighted_collateral_usd: 80 * WAD, // $80 liq-weighted
            total_debt_usd: 0,
        };

        // $80 worth of SOL at $150 = 533_333_333 lamports ≈ 0.533 SOL
        // token_to_usd_wad(533_333_334, 15e9, -8, 9) ≈ $80
        // This exceeds $75 LTV cap
        let amount_sol = 533_333_334u64;
        let result = validate_cross_borrow(&sol_pool, &pos, amount_sol, &risk);
        assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
    }

    #[test]
    fn validate_cross_borrow_accepts_within_ltv() {
        // $100 USDC collateral, LTV $75, borrow $50 SOL → ok
        let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0,
        };

        // $50 of SOL at $150 = 333_333_333 lamports
        let amount_sol = 333_333_333u64;
        let result = validate_cross_borrow(&sol_pool, &pos, amount_sol, &risk);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_cross_borrow_rejects_insufficient_liquidity() {
        // USDC pool with limited liquidity (6 decimals, price $1)
        let usdc_pool = make_pool(1_000_000, 500_000, 100_000_000, -8, 6);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 10_000 * WAD,
            liq_weighted_collateral_usd: 10_000 * WAD,
            total_debt_usd: 0,
        };

        // Available = 1_000_000 - 500_000 = 500_000. Try borrowing 600_000.
        let result = validate_cross_borrow(&usdc_pool, &pos, 600_000, &risk);
        assert_eq!(result, Err(LendError::InsufficientLiquidity.into()));
    }

    // ── Positive: borrow exactly at LTV boundary ─────────────────────────

    #[test]
    fn validate_cross_borrow_accepts_exact_ltv_boundary() {
        // $100 USDC collateral, LTV $75, borrow exactly $75 worth of USDC
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0,
        };

        // 75 USDC = 75_000_000 units, value = $75
        let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_000, &risk);
        assert!(result.is_ok(), "should accept borrow exactly at LTV cap");
    }

    // ── Negative: borrow 1 unit over LTV boundary ───────────────────────

    #[test]
    fn validate_cross_borrow_rejects_one_over_ltv() {
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0,
        };

        // 75_000_001 USDC = $75.000001 → just over $75 cap
        let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_001, &risk);
        assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
    }

    // ── Positive: existing debt + new borrow within LTV ─────────────────

    #[test]
    fn validate_cross_borrow_with_existing_debt_within_ltv() {
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let pos = make_position(0, 30_000_000); // 30 USDC existing debt

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0, // other pools
        };

        // Existing 30 USDC debt + 40 USDC new = 70 USDC < $75 cap
        let result = validate_cross_borrow(&usdc_pool, &pos, 40_000_000, &risk);
        assert!(result.is_ok());
        let (existing_debt, _) = result.unwrap();
        assert_eq!(existing_debt, 30_000_000);
    }

    // ── Negative: existing debt + new borrow exceeds LTV ────────────────

    #[test]
    fn validate_cross_borrow_with_existing_debt_exceeds_ltv() {
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let pos = make_position(0, 50_000_000); // 50 USDC existing debt

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0,
        };

        // 50 existing + 30 new = 80 > $75 cap
        let result = validate_cross_borrow(&usdc_pool, &pos, 30_000_000, &risk);
        assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
    }

    // ── Positive: multi-collateral scenario ─────────────────────────────

    #[test]
    fn accumulate_multiple_collateral_pools() {
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);

        let user = [42u8; 32].into();
        let usdc_addr = [1u8; 32].into();
        let sol_addr = [2u8; 32].into();

        let mut usdc_pos = make_position(100_000_000, 0); // $100 USDC
        usdc_pos.owner = user;
        usdc_pos.pool = usdc_addr;

        let mut sol_pos = make_position(1_000_000_000, 0); // 1 SOL = $150
        sol_pos.owner = user;
        sol_pos.pool = sol_addr;

        let mut risk = CrossRisk {
            ltv_weighted_collateral_usd: 0,
            liq_weighted_collateral_usd: 0,
            total_debt_usd: 0,
        };

        accumulate_collateral(&usdc_pool, &usdc_pos, &user, &usdc_addr, &mut risk).unwrap();
        accumulate_collateral(&sol_pool, &sol_pos, &user, &sol_addr, &mut risk).unwrap();

        // USDC: $100 × 0.75 LTV = $75, $100 × 0.80 LT = $80
        // SOL:  $150 × 0.75 LTV = $112.5, $150 × 0.80 LT = $120
        // Total LTV = $187.5, Total LT = $200
        assert_eq!(risk.ltv_weighted_collateral_usd, WAD * 1875 / 10);
        assert_eq!(risk.liq_weighted_collateral_usd, WAD * 200);
    }

    // ── Negative: zero deposit collateral adds nothing ──────────────────

    #[test]
    fn accumulate_collateral_zero_deposit_adds_nothing() {
        let pool = make_pool(0, 0, 100_000_000, -8, 6);
        let user = [42u8; 32].into();
        let pool_addr = [99u8; 32].into();
        let mut pos = make_position(0, 0);
        pos.owner = user;
        pos.pool = pool_addr;

        let mut risk = CrossRisk {
            ltv_weighted_collateral_usd: 0,
            liq_weighted_collateral_usd: 0,
            total_debt_usd: 0,
        };

        accumulate_collateral(&pool, &pos, &user, &pool_addr, &mut risk).unwrap();
        assert_eq!(risk.ltv_weighted_collateral_usd, 0);
        assert_eq!(risk.liq_weighted_collateral_usd, 0);
    }

    // ── Negative: wrong owner binding ───────────────────────────────────

    #[test]
    fn accumulate_collateral_rejects_wrong_owner() {
        let pool = make_pool(10_000_000, 0, 100_000_000, -8, 6);
        let user = [42u8; 32].into();
        let attacker = [99u8; 32].into();
        let pool_addr = [1u8; 32].into();
        let mut pos = make_position(10_000_000, 0);
        pos.owner = attacker; // wrong owner
        pos.pool = pool_addr;

        let mut risk = CrossRisk {
            ltv_weighted_collateral_usd: 0,
            liq_weighted_collateral_usd: 0,
            total_debt_usd: 0,
        };

        let result = accumulate_collateral(&pool, &pos, &user, &pool_addr, &mut risk);
        assert!(result.is_err());
    }

    // ── Positive: HF exactly 1.0 is accepted ────────────────────────────

    #[test]
    fn validate_cross_borrow_accepts_hf_exactly_one() {
        // $100 collateral, liq_threshold 80% → $80 weighted
        // Borrow $80 → HF = $80 / $80 = 1.0 exactly → accepted
        let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 75 * WAD,
            liq_weighted_collateral_usd: 80 * WAD,
            total_debt_usd: 0,
        };

        // Borrow 75 USDC = $75 → HF = $80 / $75 = 1.066… > 1.0 → ok
        let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_000, &risk);
        assert!(result.is_ok());
    }

    // ── Negative: fees reduce available liquidity ────────────────────────

    #[test]
    fn validate_cross_borrow_fees_reduce_available() {
        let mut pool = make_pool(1_000_000, 0, 100_000_000, -8, 6);
        pool.accumulated_fees = 500_000; // half the pool is fees
        let pos = make_position(0, 0);

        let risk = CrossRisk {
            ltv_weighted_collateral_usd: 10_000 * WAD,
            liq_weighted_collateral_usd: 10_000 * WAD,
            total_debt_usd: 0,
        };

        // Available = 1_000_000 - 0 - 500_000 = 500_000
        let result = validate_cross_borrow(&pool, &pos, 600_000, &risk);
        assert_eq!(result, Err(LendError::InsufficientLiquidity.into()));
    }
}
