//! Tests for `crate::instructions::cross_borrow`.

use crate::errors::LendError;
use crate::instructions::cross_borrow::{
    accumulate_collateral, pool_token_to_usd, validate_cross_borrow, CrossRisk,
};
use crate::math::{LIQ_THRESHOLD, LTV, WAD};
use crate::state::{LendingPool, UserPosition};

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
    assert_eq!(usd, WAD);
}

#[test]
fn accumulate_collateral_adds_weighted_usd() {
    let pool = make_pool(10_000_000, 0, 100_000_000, -8, 6);
    let user = [42u8; 32].into();
    let pool_addr = [99u8; 32].into();
    let mut pos = make_position(10_000_000, 0);
    pos.owner = user;
    pos.pool = pool_addr;

    let mut risk = CrossRisk {
        ltv_weighted_collateral_usd: 0,
        liq_weighted_collateral_usd: 0,
        total_debt_usd: 0,
    };

    accumulate_collateral(&pool, &pos, &user, &pool_addr, &mut risk).unwrap();

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
    let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let amount_sol = 533_333_334u64;
    let result = validate_cross_borrow(&sol_pool, &pos, amount_sol, &risk);
    assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
}

#[test]
fn validate_cross_borrow_accepts_within_ltv() {
    let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let amount_sol = 333_333_333u64;
    let result = validate_cross_borrow(&sol_pool, &pos, amount_sol, &risk);
    assert!(result.is_ok());
}

#[test]
fn validate_cross_borrow_rejects_insufficient_liquidity() {
    let usdc_pool = make_pool(1_000_000, 500_000, 100_000_000, -8, 6);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 10_000 * WAD,
        liq_weighted_collateral_usd: 10_000 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 600_000, &risk);
    assert_eq!(result, Err(LendError::InsufficientLiquidity.into()));
}

#[test]
fn validate_cross_borrow_accepts_exact_ltv_boundary() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_000, &risk);
    assert!(result.is_ok(), "should accept borrow exactly at LTV cap");
}

#[test]
fn validate_cross_borrow_rejects_one_over_ltv() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_001, &risk);
    assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
}

#[test]
fn validate_cross_borrow_with_existing_debt_within_ltv() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let pos = make_position(0, 30_000_000);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 40_000_000, &risk);
    assert!(result.is_ok());
    let (existing_debt, _) = result.unwrap();
    assert_eq!(existing_debt, 30_000_000);
}

#[test]
fn validate_cross_borrow_with_existing_debt_exceeds_ltv() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let pos = make_position(0, 50_000_000);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 30_000_000, &risk);
    assert_eq!(result, Err(LendError::ExceedsCollateralFactor.into()));
}

#[test]
fn accumulate_multiple_collateral_pools() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let sol_pool = make_pool(10_000_000_000, 0, 15_000_000_000, -8, 9);

    let user = [42u8; 32].into();
    let usdc_addr = [1u8; 32].into();
    let sol_addr = [2u8; 32].into();

    let mut usdc_pos = make_position(100_000_000, 0);
    usdc_pos.owner = user;
    usdc_pos.pool = usdc_addr;

    let mut sol_pos = make_position(1_000_000_000, 0);
    sol_pos.owner = user;
    sol_pos.pool = sol_addr;

    let mut risk = CrossRisk {
        ltv_weighted_collateral_usd: 0,
        liq_weighted_collateral_usd: 0,
        total_debt_usd: 0,
    };

    accumulate_collateral(&usdc_pool, &usdc_pos, &user, &usdc_addr, &mut risk).unwrap();
    accumulate_collateral(&sol_pool, &sol_pos, &user, &sol_addr, &mut risk).unwrap();

    assert_eq!(risk.ltv_weighted_collateral_usd, WAD * 1875 / 10);
    assert_eq!(risk.liq_weighted_collateral_usd, WAD * 200);
}

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

#[test]
fn accumulate_collateral_rejects_wrong_owner() {
    let pool = make_pool(10_000_000, 0, 100_000_000, -8, 6);
    let user = [42u8; 32].into();
    let attacker = [99u8; 32].into();
    let pool_addr = [1u8; 32].into();
    let mut pos = make_position(10_000_000, 0);
    pos.owner = attacker;
    pos.pool = pool_addr;

    let mut risk = CrossRisk {
        ltv_weighted_collateral_usd: 0,
        liq_weighted_collateral_usd: 0,
        total_debt_usd: 0,
    };

    let result = accumulate_collateral(&pool, &pos, &user, &pool_addr, &mut risk);
    assert!(result.is_err());
}

#[test]
fn validate_cross_borrow_accepts_hf_exactly_one() {
    let usdc_pool = make_pool(100_000_000, 0, 100_000_000, -8, 6);
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 75 * WAD,
        liq_weighted_collateral_usd: 80 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&usdc_pool, &pos, 75_000_000, &risk);
    assert!(result.is_ok());
}

#[test]
fn validate_cross_borrow_fees_reduce_available() {
    let mut pool = make_pool(1_000_000, 0, 100_000_000, -8, 6);
    pool.accumulated_fees = 500_000;
    let pos = make_position(0, 0);

    let risk = CrossRisk {
        ltv_weighted_collateral_usd: 10_000 * WAD,
        liq_weighted_collateral_usd: 10_000 * WAD,
        total_debt_usd: 0,
    };

    let result = validate_cross_borrow(&pool, &pos, 600_000, &risk);
    assert_eq!(result, Err(LendError::InsufficientLiquidity.into()));
}
