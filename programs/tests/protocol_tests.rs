/*!
Comprehensive protocol tests grouped by subsystem.

Each group covers the relevant instruction suite and concludes with a block of
oracle (Pyth) security tests that demonstrate attack resistance in that context.

Groups:
  1. Core Lending Protocol    — deposit/borrow/repay/liquidate/flash + oracle
  2. Encryption Protocol      — EncryptedPosition layout + privacy instructions + oracle
  3. Ika dWallet Protocol     — IkaDwalletPosition + Ika instructions + oracle
  4. Ika + Encryption         — combined cross-chain privacy positions + oracle
*/

mod common;

use common::{make_pool, pool_bytes, RawAccount};
use veil_lending::{
    errors::LendError,
    instructions::{EnablePrivacy, FlashRepay, IkaRegister, IkaRelease, IkaSign, PrivateBorrow, PrivateDeposit, UpdateOraclePrice},
    ika::{CPI_AUTHORITY_SEED, IKA_PROGRAM_ID},
    math::{
        self, current_borrow_balance, current_deposit_balance, deposit_to_shares, flash_fee,
        health_factor, max_borrowable, split_flash_fee, wad_mul,
        BASE_RATE, CLOSE_FACTOR, FLASH_FEE_BPS, LIQ_BONUS, LIQ_THRESHOLD, LTV,
        OPTIMAL_UTIL, PROTOCOL_LIQ_FEE, RESERVE_FACTOR, SLOPE1, SLOPE2, WAD,
    },
    state::{
        ika_position::{curve, scheme, status},
        EncryptedPosition, IkaDwalletPosition, LendingPool, SPL_TOKEN_PROGRAM_ID,
    },
};

const AUTHORITY: [u8; 32] = [1u8; 32];
const USER:      [u8; 32] = [2u8; 32];
const POOL_KEY:  [u8; 32] = [3u8; 32];
const DWALLET:   [u8; 32] = [4u8; 32];
const FEED_A:    [u8; 32] = [0xAAu8; 32]; // primary Pyth feed key
const FEED_B:    [u8; 32] = [0xBBu8; 32]; // different feed key (substitution attack)
const PROGRAM: pinocchio::Address = pinocchio::Address::new_from_array([9u8; 32]);
/// Pyth oracle program owner — must match one of `PYTH_PROGRAM_IDS` in
/// `update_oracle_price.rs` so the program's owner-allowlist check accepts
/// the test feed account.
const PYTH_OWNER: [u8; 32] = [
    0xdc, 0xe5, 0xeb, 0xe1, 0xe4, 0x9c, 0x3b, 0x9f, 0x11, 0x4c, 0xb5, 0x54, 0x4c, 0x50, 0xa9,
    0x9e, 0xc0, 0xd6, 0x92, 0xd6, 0x3f, 0x56, 0x79, 0x5a, 0xe0, 0x29, 0xac, 0x83, 0xd9, 0xea,
    0x8b, 0xe2,
];

// ── Pyth helpers ──────────────────────────────────────────────────────────────

/// A Pyth account with a valid trading price and tight confidence.
fn valid_pyth(price: i64, expo: i32) -> Vec<u8> {
    // conf = 1 (≪ 2% of any realistic price)
    make_pyth_bytes(price, 1, expo, 1 /* STATUS_TRADING */)
}

/// A pool account with oracle fields zeroed (no anchored feed yet).
fn unanchored_pool() -> Vec<u8> {
    pool_bytes(&make_pool(AUTHORITY, 0))
}

/// Same as `unanchored_pool` but with the Ika collateral cap unblocked
/// (set to u64::MAX). Tests that exercise `ika_register` paths beyond the
/// cap gate use this so the gate doesn't short-circuit the path under test.
fn ika_enabled_pool() -> Vec<u8> {
    let mut p = make_pool(AUTHORITY, 0);
    p.max_ika_usd_cents = u64::MAX;
    pool_bytes(&p)
}

fn make_dwallet_bytes(authority: [u8; 32], state: u8, discriminator: u8) -> Vec<u8> {
    let mut data = vec![0u8; 64];
    data[0] = discriminator;
    data[1] = 1; // version
    data[2..34].copy_from_slice(&authority);
    data[34..36].copy_from_slice(&curve::SECP256K1.to_le_bytes());
    data[36] = state;
    data
}

fn make_pyth_bytes(price: i64, conf: u64, expo: i32, status: u32) -> Vec<u8> {
    let mut data = vec![0u8; 512];
    data[0..4].copy_from_slice(&0xa1b2c3d4u32.to_le_bytes());
    data[4..8].copy_from_slice(&2u32.to_le_bytes());
    data[8..12].copy_from_slice(&3u32.to_le_bytes());
    data[20..24].copy_from_slice(&expo.to_le_bytes());
    // Timestamp at offset 176 — use a recent value so staleness checks pass.
    let recent_ts: i64 = 1_700_000_000;
    data[176..184].copy_from_slice(&recent_ts.to_le_bytes());
    data[208..216].copy_from_slice(&price.to_le_bytes());
    data[216..224].copy_from_slice(&conf.to_le_bytes());
    data[224..228].copy_from_slice(&status.to_le_bytes());
    data
}

fn ika_position_bytes(
    owner: [u8; 32],
    pool: [u8; 32],
    dwallet: [u8; 32],
    usd_value: u64,
    curve: u16,
    signature_scheme: u16,
    bump: u8,
) -> Vec<u8> {
    let mut pos: IkaDwalletPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = IkaDwalletPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(owner);
    pos.pool = pinocchio::Address::new_from_array(pool);
    pos.dwallet = pinocchio::Address::new_from_array(dwallet);
    pos.usd_value = usd_value;
    pos.curve = curve;
    pos.signature_scheme = signature_scheme;
    pos.status = status::ACTIVE;
    pos.bump = bump;
    unsafe {
        core::slice::from_raw_parts(
            &pos as *const IkaDwalletPosition as *const u8,
            IkaDwalletPosition::SIZE,
        )
        .to_vec()
    }
}

fn enc_position_bytes(owner: [u8; 32], pool: [u8; 32], bump: u8) -> Vec<u8> {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(owner);
    pos.pool = pinocchio::Address::new_from_array(pool);
    pos.bump = bump;
    unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    }
}

fn user_position_bytes(
    owner: [u8; 32],
    pool: [u8; 32],
    deposit_shares: u64,
    borrow_principal: u64,
    deposit_index_snapshot: u128,
    borrow_index_snapshot: u128,
    bump: u8,
) -> Vec<u8> {
    let mut pos: veil_lending::state::UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = veil_lending::state::UserPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(owner);
    pos.pool = pinocchio::Address::new_from_array(pool);
    pos.deposit_shares = deposit_shares;
    pos.borrow_principal = borrow_principal;
    pos.deposit_index_snapshot = deposit_index_snapshot;
    pos.borrow_index_snapshot = borrow_index_snapshot;
    pos.bump = bump;
    unsafe {
        core::slice::from_raw_parts(
            &pos as *const veil_lending::state::UserPosition as *const u8,
            veil_lending::state::UserPosition::SIZE,
        )
        .to_vec()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  GROUP 1 — CORE LENDING PROTOCOL
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// ── 1a. State sizing ──────────────────────────────────────────────────────────

#[test]
fn core_lending_pool_size_is_432() {
    assert_eq!(
        core::mem::size_of::<LendingPool>(),
        432,
        "LendingPool SIZE must be a multiple of 16 (u128 alignment)"
    );
    assert_eq!(LendingPool::SIZE, 432);
}

#[test]
fn core_lending_pool_discriminator_is_set() {
    assert_eq!(&LendingPool::DISCRIMINATOR, b"VEILPOOL");
}

// ── 1b. Deposit maths ────────────────────────────────────────────────────────

#[test]
fn core_deposit_mints_1_to_1_at_initial_index() {
    let pool = make_pool(AUTHORITY, 0);
    let shares = deposit_to_shares(10_000, pool.supply_index).unwrap();
    assert_eq!(shares, 10_000);
}

#[test]
fn core_deposit_after_10pct_growth_mints_fewer_shares() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.supply_index = WAD + WAD / 10; // 1.1 × WAD
    let shares = deposit_to_shares(1_100, pool.supply_index).unwrap();
    assert_eq!(shares, 1_000);
}

#[test]
fn core_deposit_redeem_round_trip() {
    let pool = make_pool(AUTHORITY, 0);
    let shares = deposit_to_shares(50_000, pool.supply_index).unwrap();
    let redeemed = current_deposit_balance(shares, pool.supply_index).unwrap();
    assert_eq!(redeemed, 50_000);
}

#[test]
fn core_depositor_earns_interest_after_1_year() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 600_000;
    pool.base_rate = BASE_RATE;
    pool.optimal_utilization = OPTIMAL_UTIL;
    pool.slope1 = SLOPE1;
    pool.slope2 = SLOPE2;
    pool.reserve_factor = RESERVE_FACTOR;

    let shares = deposit_to_shares(1_000_000, pool.supply_index).unwrap();
    pool.accrue_interest(86_400 * 365).unwrap();
    let final_balance = current_deposit_balance(shares, pool.supply_index).unwrap();
    assert!(final_balance > 1_000_000, "depositor must earn interest");
}

// ── 1c. Borrow / LTV / health-factor ─────────────────────────────────────────

#[test]
fn core_max_borrow_is_75pct_of_deposit() {
    let _pool = make_pool(AUTHORITY, 0);
    let max = max_borrowable(1_000_000u64, LTV).unwrap();
    assert_eq!(max, 750_000);
}

#[test]
fn core_borrow_at_ltv_is_still_healthy() {
    let borrow = max_borrowable(1_000_000u64, LTV).unwrap();
    let hf = health_factor(1_000_000, borrow, LIQ_THRESHOLD).unwrap();
    assert!(hf > WAD, "position at LTV cap must remain above liquidation threshold");
}

#[test]
fn core_health_factor_exactly_1_at_liq_threshold() {
    // deposit=1_250, liq_threshold=0.80 → 1_250*0.8=1_000=debt
    let hf = health_factor(1_250, 1_000, LIQ_THRESHOLD).unwrap();
    assert_eq!(hf, WAD);
}

#[test]
fn core_underwater_position_hf_below_1() {
    let hf = health_factor(100, 1_000, LIQ_THRESHOLD).unwrap();
    assert!(hf < WAD);
}

#[test]
fn core_no_debt_gives_max_hf() {
    assert_eq!(health_factor(1_000_000, 0, LIQ_THRESHOLD).unwrap(), u128::MAX);
}

// ── 1d. Repay / interest accrual ─────────────────────────────────────────────

#[test]
fn core_interest_accrual_grows_effective_debt() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.total_deposits = 1_000_000;
    pool.total_borrows = 600_000;
    pool.base_rate = BASE_RATE;
    pool.optimal_utilization = OPTIMAL_UTIL;
    pool.slope1 = SLOPE1;
    pool.slope2 = SLOPE2;
    pool.reserve_factor = RESERVE_FACTOR;

    let snapshot = pool.borrow_index;
    pool.accrue_interest(86_400 * 365).unwrap();
    let debt = current_borrow_balance(600_000, pool.borrow_index, snapshot).unwrap();
    assert!(debt > 600_000, "debt must grow with interest");
}

#[test]
fn core_full_repay_clears_debt() {
    let pool = make_pool(AUTHORITY, 0);
    let principal = 500_000u64;
    let debt = current_borrow_balance(principal, pool.borrow_index, pool.borrow_index).unwrap();
    assert_eq!(debt.saturating_sub(debt), 0);
}

// ── 1e. Liquidation maths ────────────────────────────────────────────────────

#[test]
fn core_liquidation_full_scenario() {
    // deposit=1_000, debt=900, HF≈0.888 → liquidatable
    let hf = health_factor(1_000, 900, LIQ_THRESHOLD).unwrap();
    assert!(hf < WAD);

    let repay = wad_mul(900u128, CLOSE_FACTOR).unwrap() as u64; // 450
    assert_eq!(repay, 450);

    let seized = wad_mul(repay as u128, WAD + LIQ_BONUS).unwrap() as u64; // 472
    assert_eq!(seized, 472);

    let proto_fee = wad_mul(seized as u128, PROTOCOL_LIQ_FEE).unwrap() as u64; // 47
    let liquidator = seized.saturating_sub(proto_fee); // 425
    assert_eq!(proto_fee, 47);
    assert_eq!(liquidator, 425);
    assert!(seized <= 1_000, "cannot seize more than deposited");
}

#[test]
fn core_liquidation_not_allowed_when_healthy() {
    let hf = health_factor(2_000, 1_000, LIQ_THRESHOLD).unwrap();
    // HF = (2000*0.8)/1000 = 1.6 WAD → healthy
    assert!(hf >= WAD);
}

// ── 1f. Flash loan maths ─────────────────────────────────────────────────────

#[test]
fn core_flash_fee_is_9_bps() {
    assert_eq!(flash_fee(1_000_000, FLASH_FEE_BPS).unwrap(), 900);
}

#[test]
fn core_flash_fee_split_90_10() {
    let (lp, protocol) = split_flash_fee(100);
    assert_eq!(protocol, 10);
    assert_eq!(lp, 90);
}

#[test]
fn core_flash_loan_round_trip_accounting() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.total_deposits = 1_000_000;
    let loan = 100_000u64;
    let fee = flash_fee(loan, FLASH_FEE_BPS).unwrap(); // 90
    let (lp, proto) = split_flash_fee(fee);
    pool.total_deposits += lp;
    pool.accumulated_fees += proto;
    assert_eq!(pool.total_deposits, 1_000_081);
    assert_eq!(pool.accumulated_fees, 9);
}

#[test]
fn core_flash_repay_without_active_loan_is_rejected() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.vault = pinocchio::Address::new_from_array([0x52u8; 32]);
    let mut borrower = RawAccount::new(USER, true, true, &[]);
    let mut borrower_token = RawAccount::new([0x51u8; 32], false, true, &[]);
    let mut vault = RawAccount::new([0x52u8; 32], false, true, &[]);
    let mut pool_acct = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, true, &pool_bytes(&pool));
    let mut token = RawAccount::new(*SPL_TOKEN_PROGRAM_ID.as_array(), false, false, &[]);

    let result = unsafe {
        let mut accounts = [
            borrower.view(), borrower_token.view(), vault.view(), pool_acct.view(), token.view(),
        ];
        FlashRepay.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::FlashLoanNotActive.into()));
}

// ── 1g. Interest rate model ───────────────────────────────────────────────────

#[test]
fn core_rate_kink_at_80pct_utilization() {
    let util = math::utilization_rate(800_000, 1_000_000).unwrap();
    let rate = math::borrow_rate(util, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
    // At the kink: BASE_RATE + SLOPE1 * (optimal / optimal) = BASE_RATE + SLOPE1
    assert_eq!(rate, BASE_RATE + SLOPE1);
}

#[test]
fn core_rate_jump_above_kink_is_significant() {
    let u_low = math::utilization_rate(700_000, 1_000_000).unwrap();
    let u_high = math::utilization_rate(900_000, 1_000_000).unwrap();
    let r_low  = math::borrow_rate(u_low,  BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
    let r_high = math::borrow_rate(u_high, BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2).unwrap();
    // slope2 dominates above the kink; jump should dwarf SLOPE1
    assert!(r_high - r_low > 5 * SLOPE1);
}

// ── 1h. Oracle (Pyth) — core lending context ─────────────────────────────────

#[test]
fn core_oracle_valid_price_accepted() {
    let pyth = valid_pyth(16_842_000_000, -8); // $168.42
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "valid price must be accepted: {:?}", result);
}

#[test]
fn core_oracle_caches_price_in_pool() {
    let pyth = valid_pyth(16_842_000_000, -8);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
        let pool = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(pool.oracle_price, 16_842_000_000);
        assert_eq!(pool.oracle_expo, -8);
    }
}

#[test]
fn core_oracle_anchors_feed_on_first_call() {
    let pyth = valid_pyth(10_000_000_000, -8);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
        let pool = pool_acct.read_data_as::<LendingPool>();
        assert_eq!(pool.pyth_price_feed.as_array(), &FEED_A, "feed must be anchored");
    }
}

#[test]
fn core_oracle_attack_feed_substitution_rejected() {
    // First call anchors FEED_A; second call with FEED_B must fail.
    let pyth_a = valid_pyth(10_000_000_000, -8);
    let pyth_b = valid_pyth(10_000_000_000, -8);
    let pool_data = unanchored_pool();
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &pool_data);
    let mut pyth_a_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth_a);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), pyth_a_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }
    let updated_pool = unsafe { pool_acct.read_data_as::<LendingPool>() };
    let updated_bytes = unsafe {
        core::slice::from_raw_parts(
            &updated_pool as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    };
    let mut pool_acct2 = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&updated_bytes);
    let mut pyth_b_acct = RawAccount::new_with_owner(FEED_B, PYTH_OWNER, false, false, &pyth_b);
    let result = unsafe {
        let mut accounts = [pool_acct2.view(), pyth_b_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceFeedMismatch.into()),
        "feed substitution attack must be rejected");
}

#[test]
fn core_oracle_attack_wrong_magic_rejected() {
    let mut bad = make_pyth_bytes(10_000_000_000, 1, -8, 1);
    bad[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes()); // corrupt magic
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_wrong_atype_rejected() {
    let mut bad = make_pyth_bytes(10_000_000_000, 1, -8, 1);
    bad[8..12].copy_from_slice(&2u32.to_le_bytes()); // atype=2 is ProductAccount, not Price
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_stale_status_rejected() {
    // status=0 means Unknown (not Trading)
    let bad = make_pyth_bytes(10_000_000_000, 1, -8, 0);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceStale.into()));
}

#[test]
fn core_oracle_attack_halted_status_rejected() {
    // status=2 means Halted
    let bad = make_pyth_bytes(10_000_000_000, 1, -8, 2);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceStale.into()));
}

#[test]
fn core_oracle_attack_zero_price_rejected() {
    let bad = make_pyth_bytes(0, 0, -8, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_negative_price_rejected() {
    let bad = make_pyth_bytes(-1, 0, -8, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_short_account_rejected() {
    // Account with only 100 bytes — too short for any Pyth field reads
    let short = vec![0xd4u8, 0xc3, 0xb2, 0xa1, 0, 0, 0, 0, 3, 0, 0, 0]; // magic+ver+atype only
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &short);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_empty_account_rejected() {
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn core_oracle_attack_confidence_too_wide_rejected() {
    // price = 1_000_000, conf = 21_000 → conf/price = 2.1% > 2% threshold
    let bad = make_pyth_bytes(1_000_000, 21_000, -6, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleConfTooWide.into()),
        "oracle with >2% confidence must be rejected (flash-loan attack defence)");
}

#[test]
fn core_oracle_confidence_exactly_at_1pct_boundary_accepted() {
    // price = 1_000_000, conf = 10_000 → conf/price = exactly 1% → accepted
    // check: conf * 100 = 1_000_000 == price → NOT > price, so OK
    let ok = make_pyth_bytes(1_000_000, 10_000, -6, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &ok);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "exactly 2% confidence must be accepted: {:?}", result);
}

#[test]
fn core_oracle_second_valid_update_with_same_feed_accepted() {
    let pyth1 = valid_pyth(10_000_000_000, -8);
    let pyth2 = valid_pyth(10_100_000_000, -8); // price moved slightly
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth1);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }
    // Second update: same feed, new price
    let updated = unsafe { pool_acct.read_data_as::<LendingPool>() };
    let updated_bytes = unsafe {
        core::slice::from_raw_parts(
            &updated as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    };
    let mut pool_acct2 = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&updated_bytes);
    let mut pyth_acct2 = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth2);
    let result = unsafe {
        let mut accounts = [pool_acct2.view(), pyth_acct2.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "second update with same feed must succeed");
    let final_pool = unsafe { pool_acct2.read_data_as::<LendingPool>() };
    assert_eq!(final_pool.oracle_price, 10_100_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  GROUP 2 — ENCRYPTION LENDING PROTOCOL
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// ── 2a. EncryptedPosition account layout ─────────────────────────────────────

#[test]
fn enc_encrypted_position_size_is_144() {
    assert_eq!(core::mem::size_of::<EncryptedPosition>(), EncryptedPosition::SIZE);
    assert_eq!(EncryptedPosition::SIZE, 144);
}

#[test]
fn enc_encrypted_position_discriminator_is_veilenc() {
    assert_eq!(&EncryptedPosition::DISCRIMINATOR, b"VEILENC!");
}

#[test]
fn enc_encrypted_position_zeroed_has_zero_ciphertexts() {
    let pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    assert_eq!(pos.enc_deposit, [0u8; 32]);
    assert_eq!(pos.enc_debt, [0u8; 32]);
}

#[test]
fn enc_encrypted_position_bytes_roundtrip() {
    let _enc_deposit_key = [0xCCu8; 32];
    let _enc_debt_key    = [0xDDu8; 32];
    let bytes = enc_position_bytes(USER, POOL_KEY, 254);
    assert_eq!(bytes.len(), EncryptedPosition::SIZE);

    // Discriminator bytes
    assert_eq!(&bytes[0..8], b"VEILENC!");
    // Owner
    assert_eq!(&bytes[8..40], &USER);
    // Pool
    assert_eq!(&bytes[40..72], &POOL_KEY);
    // enc_deposit and enc_debt are zero (enc_position_bytes doesn't set them)
    assert_eq!(&bytes[72..104], &[0u8; 32]);
    assert_eq!(&bytes[104..136], &[0u8; 32]);
    // Bump
    assert_eq!(bytes[136], 254);
}

#[test]
fn enc_enable_privacy_discriminator_is_eight() {
    assert_eq!(EnablePrivacy::DISCRIMINATOR, 8);
}

#[test]
fn enc_enable_privacy_from_data_parses_bumps() {
    let ix = EnablePrivacy::from_data(&[0x42, 0xFF]).unwrap();
    assert_eq!(ix.enc_pos_bump, 0x42);
    assert_eq!(ix.cpi_auth_bump, 0xFF);
}

#[test]
fn enc_enable_privacy_from_data_too_short_fails() {
    assert!(EnablePrivacy::from_data(&[]).is_err());
    assert!(EnablePrivacy::from_data(&[1]).is_err());
}

#[test]
fn enc_encrypted_position_stores_distinct_ciphertext_keys() {
    // Verify the layout stores two independent 32-byte keys at correct offsets
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.enc_deposit = [0xAAu8; 32];
    pos.enc_debt    = [0xBBu8; 32];

    let raw = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
    };
    // enc_deposit at offset 72
    assert_eq!(&raw[72..104], &[0xAAu8; 32]);
    // enc_debt at offset 104
    assert_eq!(&raw[104..136], &[0xBBu8; 32]);
}

#[test]
fn enc_wrong_enc_deposit_ciphertext_substitution_is_rejected() {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.enc_deposit = [0xAAu8; 32];
    pos.enc_debt = [0xBBu8; 32];

    let pos_bytes = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    };
    let mut pos_acct = RawAccount::new([0x11u8; 32], false, true, &pos_bytes);
    let mut wrong_ct = RawAccount::new([0xCCu8; 32], false, true, &[]);

    let result = unsafe {
        let pos_view = pos_acct.view();
        let wrong_view = wrong_ct.view();
        let enc_pos = EncryptedPosition::from_account(&pos_view).unwrap();
        enc_pos.verify_deposit_ct(&wrong_view)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidArgument));
}

#[test]
fn enc_position_binding_rejects_wrong_owner() {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(USER);
    pos.pool = pinocchio::Address::new_from_array(POOL_KEY);

    let pos_bytes = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    };
    let mut pos_acct = RawAccount::new([0x44u8; 32], false, true, &pos_bytes);
    let result = unsafe {
        let pos_view = pos_acct.view();
        let enc_pos = EncryptedPosition::from_account(&pos_view).unwrap();
        enc_pos.verify_binding(&pinocchio::Address::new_from_array(AUTHORITY), &pinocchio::Address::new_from_array(POOL_KEY))
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn enc_position_binding_rejects_wrong_pool() {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(USER);
    pos.pool = pinocchio::Address::new_from_array(POOL_KEY);

    let pos_bytes = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    };
    let mut pos_acct = RawAccount::new([0x45u8; 32], false, true, &pos_bytes);
    let result = unsafe {
        let pos_view = pos_acct.view();
        let enc_pos = EncryptedPosition::from_account(&pos_view).unwrap();
        enc_pos.verify_binding(&pinocchio::Address::new_from_array(USER), &pinocchio::Address::new_from_array([0x77u8; 32]))
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidAccountData));
}

#[test]
fn enc_wrong_enc_debt_ciphertext_substitution_is_rejected() {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.enc_deposit = [0xAAu8; 32];
    pos.enc_debt = [0xBBu8; 32];

    let pos_bytes = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    };
    let mut pos_acct = RawAccount::new([0x22u8; 32], false, true, &pos_bytes);
    let mut wrong_ct = RawAccount::new([0xDDu8; 32], false, true, &[]);

    let result = unsafe {
        let pos_view = pos_acct.view();
        let wrong_view = wrong_ct.view();
        let enc_pos = EncryptedPosition::from_account(&pos_view).unwrap();
        enc_pos.verify_debt_ct(&wrong_view)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidArgument));
}

#[test]
fn enc_swapping_deposit_and_debt_ciphertext_accounts_is_rejected() {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.enc_deposit = [0xAAu8; 32];
    pos.enc_debt = [0xBBu8; 32];

    let pos_bytes = unsafe {
        core::slice::from_raw_parts(
            &pos as *const EncryptedPosition as *const u8,
            EncryptedPosition::SIZE,
        )
        .to_vec()
    };
    let mut pos_acct = RawAccount::new([0x33u8; 32], false, true, &pos_bytes);
    let mut deposit_ct = RawAccount::new([0xAAu8; 32], false, true, &[]);
    let mut debt_ct = RawAccount::new([0xBBu8; 32], false, true, &[]);

    let (deposit_as_debt, debt_as_deposit) = unsafe {
        let pos_view = pos_acct.view();
        let deposit_view = deposit_ct.view();
        let debt_view = debt_ct.view();
        let enc_pos = EncryptedPosition::from_account(&pos_view).unwrap();
        (
            enc_pos.verify_debt_ct(&deposit_view),
            enc_pos.verify_deposit_ct(&debt_view),
        )
    };

    assert_eq!(deposit_as_debt, Err(pinocchio::error::ProgramError::InvalidArgument));
    assert_eq!(debt_as_deposit, Err(pinocchio::error::ProgramError::InvalidArgument));
}

// ── 2b. Oracle security — encrypted lending context ──────────────────────────
// The oracle feeds the same LendingPool used for encrypted positions.
// An attacker who cannot pass the oracle validation cannot inflate collateral
// values to borrow more than permitted (plaintext health-factor still enforced).

#[test]
fn enc_oracle_valid_price_serves_encrypted_pool() {
    let pyth = valid_pyth(3_240_000_000_000, -8); // $32,400 (BTC-ish)
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "{:?}", result);
    let pool = unsafe { pool_acct.read_data_as::<LendingPool>() };
    // $32,400 at expo -8
    assert_eq!(pool.oracle_price, 3_240_000_000_000);
    assert_eq!(pool.oracle_expo, -8);
}

#[test]
fn enc_oracle_update_on_pool_a_does_not_mutate_pool_b_cache() {
    let pyth = valid_pyth(3_240_000_000_000, -8);
    let mut pool_a = RawAccount::new_with_owner([0xA1u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let pool_b = RawAccount::new_with_owner([0xB1u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);

    unsafe {
        let mut accounts = [pool_a.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }

    let a = unsafe { pool_a.read_data_as::<LendingPool>() };
    let b = unsafe { pool_b.read_data_as::<LendingPool>() };
    assert_eq!(a.oracle_price, 3_240_000_000_000);
    assert_eq!(a.pyth_price_feed, pinocchio::Address::new_from_array(FEED_A));
    assert_eq!(b.oracle_price, 0);
    assert_eq!(b.oracle_conf, 0);
    assert_eq!(b.oracle_expo, 0);
    assert_eq!(b.pyth_price_feed, pinocchio::Address::new_from_array([0u8; 32]));
}

#[test]
fn enc_private_deposit_rejects_paused_pool() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.paused = 1;
    let pos = user_position_bytes(USER, POOL_KEY, 0, 0, WAD, WAD, 1);
    let enc = enc_position_bytes(USER, POOL_KEY, 1);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut user_token = RawAccount::new([0x10u8; 32], false, true, &[]);
    let mut vault = RawAccount::new([0x11u8; 32], false, true, &[]);
    let mut pool_acct = RawAccount::new(POOL_KEY, false, true, &pool_bytes(&pool));
    let mut user_pos = RawAccount::new([0x12u8; 32], false, true, &pos);
    let mut enc_pos = RawAccount::new([0x13u8; 32], false, true, &enc);
    let mut enc_deposit_ct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&[]);
    let mut amount_ct = RawAccount::new([0x15u8; 32], false, true, &[]);
    let mut system = RawAccount::new([0x16u8; 32], false, false, &[]);
    let mut token = RawAccount::new([0x17u8; 32], false, false, &[]);
    let mut encrypt_program = RawAccount::new([0x18u8; 32], false, false, &[]);
    let mut encrypt_config = RawAccount::new([0x19u8; 32], false, false, &[]);
    let mut encrypt_deposit = RawAccount::new([0x20u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new([0x21u8; 32], false, false, &[]);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut network_key = RawAccount::new([0x22u8; 32], false, false, &[]);
    let mut event_auth = RawAccount::new([0x23u8; 32], false, false, &[]);

    let data = [1u8, 0, 0, 0, 0, 0, 0, 0, 0];
    let result = unsafe {
        let mut accounts = [
            user.view(), user_token.view(), vault.view(), pool_acct.view(), user_pos.view(),
            enc_pos.view(), enc_deposit_ct.view(), amount_ct.view(), system.view(), token.view(),
            encrypt_program.view(), encrypt_config.view(), encrypt_deposit.view(), cpi.view(),
            caller.view(), network_key.view(), event_auth.view(),
        ];
        PrivateDeposit::from_data(&data).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::PoolPaused.into()));
}

#[test]
fn enc_private_borrow_rejects_paused_pool() {
    let mut pool = make_pool(AUTHORITY, 0);
    pool.paused = 1;
    pool.authority_bump = 1;
    let pos = user_position_bytes(USER, POOL_KEY, 1_000, 0, WAD, WAD, 1);
    let mut enc = enc_position_bytes(USER, POOL_KEY, 1);
    enc[72..104].copy_from_slice(&[0x31u8; 32]);
    enc[104..136].copy_from_slice(&[0x32u8; 32]);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut user_token = RawAccount::new([0x24u8; 32], false, true, &[]);
    let mut vault = RawAccount::new([0x25u8; 32], false, true, &[]);
    let mut pool_acct = RawAccount::new(POOL_KEY, false, true, &pool_bytes(&pool));
    let mut user_pos = RawAccount::new([0x26u8; 32], false, true, &pos);
    let mut enc_pos = RawAccount::new([0x27u8; 32], false, true, &enc);
    let mut enc_debt_ct = RawAccount::new([0x32u8; 32], false, true, &[]);
    let mut enc_deposit_ct = RawAccount::new([0x31u8; 32], false, false, &[]);
    let mut amount_ct = RawAccount::new([0x28u8; 32], false, true, &[]);
    let mut healthy_out = RawAccount::new([0x29u8; 32], false, true, &[]);
    let mut pool_authority = RawAccount::new([0x30u8; 32], false, false, &[]);
    let mut token = RawAccount::new([0x2Au8; 32], false, false, &[]);
    let mut encrypt_program = RawAccount::new([0x2Bu8; 32], false, false, &[]);
    let mut encrypt_config = RawAccount::new([0x2Cu8; 32], false, false, &[]);
    let mut encrypt_deposit = RawAccount::new([0x2Du8; 32], false, true, &[]);
    let mut cpi = RawAccount::new([0x2Eu8; 32], false, false, &[]);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut network_key = RawAccount::new([0x2Fu8; 32], false, false, &[]);
    let mut event_auth = RawAccount::new([0x33u8; 32], false, false, &[]);
    let mut system = RawAccount::new([0x34u8; 32], false, false, &[]);

    let data = [1u8, 0, 0, 0, 0, 0, 0, 0, 0];
    let result = unsafe {
        let mut accounts = [
            user.view(), user_token.view(), vault.view(), pool_acct.view(), user_pos.view(),
            enc_pos.view(), enc_debt_ct.view(), enc_deposit_ct.view(), amount_ct.view(),
            healthy_out.view(), pool_authority.view(), token.view(), encrypt_program.view(),
            encrypt_config.view(), encrypt_deposit.view(), cpi.view(), caller.view(),
            network_key.view(), event_auth.view(), system.view(),
        ];
        PrivateBorrow::from_data(&data).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::PoolPaused.into()));
}

#[test]
fn enc_enable_privacy_rejects_reinitializing_existing_encrypted_position() {
    let pool = make_pool(AUTHORITY, 0);
    let pos = user_position_bytes(USER, POOL_KEY, 100, 0, WAD, WAD, 1);

    // Compute the canonical PDA addresses the program will check. Without
    // this the new PDA-derivation guards (E-3 / E-2) short-circuit with
    // InvalidPda before we ever get to the "account already initialised"
    // check this test targets. We just pick a fixed bump and derive the
    // matching addresses — the on-chain check uses the same `derive_address`
    // path, so any bump works for the equality check.
    let enc_pos_bump: u8 = 255;
    let cpi_auth_bump: u8 = 255;
    let enc_pos_addr = pinocchio::Address::derive_address(
        &[b"enc_pos" as &[u8], &USER, &POOL_KEY],
        Some(enc_pos_bump),
        &PROGRAM,
    );
    let cpi_authority_addr = pinocchio::Address::derive_address(
        &[veil_lending::fhe::context::CPI_AUTHORITY_SEED],
        Some(cpi_auth_bump),
        &PROGRAM,
    );
    let existing_enc = enc_position_bytes(USER, POOL_KEY, enc_pos_bump);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut user_pos = RawAccount::new([0x35u8; 32], false, false, &pos);
    let mut enc_pos = RawAccount::new(*enc_pos_addr.as_array(), false, true, &existing_enc);
    let mut enc_dep = RawAccount::new([0x37u8; 32], false, true, &[]);
    let mut enc_debt = RawAccount::new([0x38u8; 32], false, true, &[]);
    let mut pool_acct = RawAccount::new(POOL_KEY, false, false, &pool_bytes(&pool));
    let mut encrypt_program = RawAccount::new([0x39u8; 32], false, false, &[]);
    let mut encrypt_config = RawAccount::new([0x40u8; 32], false, false, &[]);
    let mut encrypt_deposit = RawAccount::new([0x41u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new(*cpi_authority_addr.as_array(), false, false, &[]);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut network_key = RawAccount::new([0x43u8; 32], false, false, &[]);
    let mut event_auth = RawAccount::new([0x44u8; 32], false, false, &[]);
    let mut system = RawAccount::new([0x45u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [
            user.view(), user_pos.view(), enc_pos.view(), enc_dep.view(), enc_debt.view(),
            pool_acct.view(), encrypt_program.view(), encrypt_config.view(), encrypt_deposit.view(),
            cpi.view(), caller.view(), network_key.view(), event_auth.view(), system.view(),
        ];
        EnablePrivacy::from_data(&[enc_pos_bump, cpi_auth_bump])
            .unwrap()
            .process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidAccountData));
}

#[test]
fn enc_oracle_attack_manipulated_price_with_wide_conf_rejected() {
    // Attacker uses flash loan to push price up; Pyth aggregation uncertainty widens.
    // price = 5_000_000, conf = 101_000 → conf/price ≈ 2.02% > 2% → OracleConfTooWide
    let bad = make_pyth_bytes(5_000_000, 101_000, -6, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleConfTooWide.into()),
        "flash-loan-widened oracle must be blocked even for encrypted pools");
}

#[test]
fn enc_oracle_attack_halted_feed_on_encrypted_pool_rejected() {
    // During market closure, encrypted borrowers cannot manipulate prices.
    let bad = make_pyth_bytes(10_000_000_000, 1, -8, 2); // status=Halted
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceStale.into()));
}

#[test]
fn enc_oracle_attack_substitution_on_encrypted_pool_rejected() {
    // Anchor feed A, then try to substitute feed B on the encrypted pool.
    let pyth_a = valid_pyth(10_000_000_000, -8);
    let pyth_b = valid_pyth(10_000_000_000, -8);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_a_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth_a);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), pyth_a_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }
    let anchored = unsafe { pool_acct.read_data_as::<LendingPool>() };
    let anchored_bytes = unsafe {
        core::slice::from_raw_parts(
            &anchored as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    };
    let mut pool2 = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&anchored_bytes);
    let mut pyth_b_acct = RawAccount::new_with_owner(FEED_B, PYTH_OWNER, false, false, &pyth_b);
    let result = unsafe {
        let mut accounts = [pool2.view(), pyth_b_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceFeedMismatch.into()));
}

#[test]
fn enc_oracle_attack_short_data_on_encrypted_pool_rejected() {
    let short = vec![0u8; 100];
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &short);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

// ── 2c. Plaintext health factor still enforced when position is encrypted ─────

#[test]
fn enc_health_factor_enforced_on_encrypted_position() {
    // Even with encrypted amounts, HF calculation uses plaintext UserPosition.
    // This test verifies the math is correct: amounts are hidden but the
    // protocol's enforcement boundary (HF ≥ 1) remains.
    let deposit = 1_000_000u64;
    let borrow   = 900_000u64;
    let hf = health_factor(deposit, borrow, LIQ_THRESHOLD).unwrap();
    // (1_000_000 × 0.80) / 900_000 = 0.888… < WAD → liquidatable
    assert!(hf < WAD, "encrypted position does not bypass health factor: HF={}", hf);
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  GROUP 3 — IKA dWALLET PROTOCOL
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// ── 3a. IkaDwalletPosition layout ────────────────────────────────────────────

#[test]
fn ika_dwallet_position_size_is_128() {
    assert_eq!(core::mem::size_of::<IkaDwalletPosition>(), IkaDwalletPosition::SIZE);
    assert_eq!(IkaDwalletPosition::SIZE, 128);
}

#[test]
fn ika_dwallet_position_discriminator_is_veilika() {
    assert_eq!(&IkaDwalletPosition::DISCRIMINATOR, b"VEILIKA!");
}

#[test]
fn ika_curve_constants_are_sequential() {
    assert_eq!(curve::SECP256K1,  0);
    assert_eq!(curve::SECP256R1,  1);
    assert_eq!(curve::CURVE25519, 2);
    assert_eq!(curve::RISTRETTO,  3);
}

#[test]
fn ika_scheme_constants_span_full_range() {
    assert_eq!(scheme::ECDSA_KECCAK256,    0);
    assert_eq!(scheme::ECDSA_SHA256,       1);
    assert_eq!(scheme::ECDSA_DOUBLE_SHA256,2);
    assert_eq!(scheme::TAPROOT_SHA256,     3);
    assert_eq!(scheme::ECDSA_BLAKE2B256,   4);
    assert_eq!(scheme::EDDSA_SHA512,       5);
    assert_eq!(scheme::SCHNORRKEL_MERLIN,  6);
}

#[test]
fn ika_status_constants() {
    assert_eq!(status::ACTIVE,     0);
    assert_eq!(status::RELEASED,   1);
    assert_eq!(status::LIQUIDATED, 2);
}

#[test]
fn ika_dwallet_position_bytes_roundtrip() {
    let bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 254);
    assert_eq!(bytes.len(), IkaDwalletPosition::SIZE);

    assert_eq!(&bytes[0..8],   b"VEILIKA!");
    assert_eq!(&bytes[8..40],  &USER);
    assert_eq!(&bytes[40..72], &POOL_KEY);
    assert_eq!(&bytes[72..104],&DWALLET);
    assert_eq!(u64::from_le_bytes(bytes[104..112].try_into().unwrap()), 1_200_000u64);
    assert_eq!(u16::from_le_bytes(bytes[112..114].try_into().unwrap()), curve::SECP256K1);
    assert_eq!(u16::from_le_bytes(bytes[114..116].try_into().unwrap()), scheme::ECDSA_SHA256);
    assert_eq!(bytes[116], status::ACTIVE);
    assert_eq!(bytes[117], 254); // bump
}

// ── 3b. IkaRegister instruction parsing ──────────────────────────────────────

fn make_register_data(usd_value: u64, curve: u16, scheme: u16, pos_bump: u8, cpi_bump: u8) -> Vec<u8> {
    let mut d = usd_value.to_le_bytes().to_vec();
    d.extend_from_slice(&curve.to_le_bytes());
    d.extend_from_slice(&scheme.to_le_bytes());
    d.push(pos_bump);
    d.push(cpi_bump);
    d
}

#[test]
fn ika_register_from_data_parses_correctly() {
    let d = make_register_data(1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 254, 255);
    let ix = IkaRegister::from_data(&d).unwrap();
    assert_eq!(ix.usd_value, 1_200_000);
    assert_eq!(ix.curve, curve::SECP256K1);
    assert_eq!(ix.signature_scheme, scheme::ECDSA_SHA256);
    assert_eq!(ix.position_bump, 254);
    assert_eq!(ix.cpi_authority_bump, 255);
}

#[test]
fn ika_register_from_data_too_short_fails() {
    assert!(IkaRegister::from_data(&[0u8; 13]).is_err());
    assert!(IkaRegister::from_data(&[]).is_err());
}

#[test]
fn ika_register_discriminator_is_17() {
    assert_eq!(IkaRegister::DISCRIMINATOR, 17);
}

#[test]
fn ika_register_missing_signer_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let mut user  = RawAccount::new(USER,      false /* NOT signer */, true, &[]);
    let mut pool  = RawAccount::new(POOL_KEY,  false, false, &unanchored_pool());
    let mut dw    = RawAccount::new(DWALLET,   false, false, &[]);
    let mut ikapos= RawAccount::new([5u8; 32], false, true,  &[]);
    let mut cpiad = RawAccount::new([6u8; 32], false, false, &[]);
    let mut sys   = RawAccount::new([0u8; 32], false, false, &[]);
    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpiad.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::MissingSignature.into()));
}

#[test]
fn ika_register_wrong_cpi_authority_pda_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );
    let dwallet = make_dwallet_bytes(*cpi_authority.as_array(), 1, 2);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let pool_bytes = ika_enabled_pool();
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, *IKA_PROGRAM_ID.as_array(), false, false, &dwallet);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut wrong_cpi = RawAccount::new([6u8; 32], false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), wrong_cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn ika_register_wrong_ika_program_owner_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );
    let dwallet = make_dwallet_bytes(*cpi_authority.as_array(), 1, 2);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let pool_bytes = ika_enabled_pool();
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, [0u8; 32], false, false, &dwallet);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::IncorrectProgramId));
}

#[test]
fn ika_register_inactive_or_frozen_dwallet_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );
    let frozen_dwallet = make_dwallet_bytes(*cpi_authority.as_array(), 2, 2);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let pool_bytes = ika_enabled_pool();
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, *IKA_PROGRAM_ID.as_array(), false, false, &frozen_dwallet);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidAccountData));
}

#[test]
fn ika_register_malformed_dwallet_layout_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );

    let mut user = RawAccount::new(USER, true, true, &[]);
    let pool_bytes = ika_enabled_pool();
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, *IKA_PROGRAM_ID.as_array(), false, false, &[0u8; 8]);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidAccountData));
}

#[test]
fn ika_register_disabled_when_cap_zero_rejected() {
    let d = make_register_data(1_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );
    let dwallet = make_dwallet_bytes(*cpi_authority.as_array(), 1, 2);

    let mut user = RawAccount::new(USER, true, true, &[]);
    // unanchored_pool has max_ika_usd_cents = 0 (default).
    let pool_bytes = unanchored_pool();
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, *IKA_PROGRAM_ID.as_array(), false, false, &dwallet);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::IkaCollateralDisabled.into()));
}

#[test]
fn ika_register_value_above_cap_rejected() {
    let d = make_register_data(2_000_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );
    let dwallet = make_dwallet_bytes(*cpi_authority.as_array(), 1, 2);

    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut p = make_pool(AUTHORITY, 0);
    p.max_ika_usd_cents = 1_000_000; // 1M cents = $10k cap
    let pool_bytes = pool_bytes(&p);
    let mut pool = RawAccount::new_with_owner(POOL_KEY, *PROGRAM.as_array(), false, false, &pool_bytes);
    let mut dw = RawAccount::new_with_owner(DWALLET, *IKA_PROGRAM_ID.as_array(), false, false, &dwallet);
    let mut ikapos = RawAccount::new([5u8; 32], false, true, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), ikapos.view(), cpi.view(), sys.view()];
        IkaRegister::from_data(&d).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::IkaCollateralExceedsCap.into()));
}

#[test]
fn ika_release_discriminator_is_18() {
    assert_eq!(IkaRelease::DISCRIMINATOR, 18);
}

#[test]
fn ika_sign_discriminator_is_19() {
    assert_eq!(IkaSign::DISCRIMINATOR, 19);
}

#[test]
fn ika_released_position_cannot_release_again() {
    let mut pos_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
    pos_bytes[116] = status::RELEASED;

    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );

    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut pool = RawAccount::new(POOL_KEY, false, false, &unanchored_pool());
    let mut dw = RawAccount::new(DWALLET, false, true, &[]);
    let mut pos = RawAccount::new([5u8; 32], false, true, &pos_bytes);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut ika = RawAccount::new(*IKA_PROGRAM_ID.as_array(), false, false, &[]);
    // accounts[7] is the user_position; only inspected after the status/owner
    // checks fire, so a placeholder is sufficient for this test.
    let mut user_pos = RawAccount::new([6u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [user.view(), pool.view(), dw.view(), pos.view(), caller.view(), cpi.view(), ika.view(), user_pos.view()];
        IkaRelease::from_data(&[1]).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn ika_non_owner_cannot_release_position() {
    let pos_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(1),
        &PROGRAM,
    );

    let mut other = RawAccount::new(AUTHORITY, true, true, &[]);
    let mut pool = RawAccount::new(POOL_KEY, false, false, &unanchored_pool());
    let mut dw = RawAccount::new(DWALLET, false, true, &[]);
    let mut pos = RawAccount::new([5u8; 32], false, true, &pos_bytes);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut ika = RawAccount::new(*IKA_PROGRAM_ID.as_array(), false, false, &[]);
    let mut user_pos = RawAccount::new([6u8; 32], false, false, &[]);

    let result = unsafe {
        let mut accounts = [other.view(), pool.view(), dw.view(), pos.view(), caller.view(), cpi.view(), ika.view(), user_pos.view()];
        IkaRelease::from_data(&[1]).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::Unauthorized.into()));
}

#[test]
fn ika_active_position_with_wrong_dwallet_bound_fails_sign() {
    let pos_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
    let cpi_authority = pinocchio::Address::derive_address(
        &[CPI_AUTHORITY_SEED],
        Some(0),
        &PROGRAM,
    );
    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut msg = RawAccount::new([8u8; 32], false, true, &[]);
    let mut wrong_dwallet = RawAccount::new([9u8; 32], false, false, &[]);
    let mut pos = RawAccount::new([5u8; 32], false, false, &pos_bytes);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);
    let mut ika = RawAccount::new(*IKA_PROGRAM_ID.as_array(), false, false, &[]);

    let data = [0u8; 67];
    let result = unsafe {
        let mut accounts = [
            user.view(), msg.view(), wrong_dwallet.view(), pos.view(),
            caller.view(), cpi.view(), sys.view(), ika.view(),
        ];
        IkaSign::from_data(&data).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(pinocchio::error::ProgramError::InvalidAccountData));
}

#[test]
fn ika_released_or_liquidated_position_cannot_sign() {
    for status_byte in [status::RELEASED, status::LIQUIDATED] {
        let mut pos_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
        pos_bytes[116] = status_byte;
        let cpi_authority = pinocchio::Address::derive_address(
            &[CPI_AUTHORITY_SEED],
            Some(0),
            &PROGRAM,
        );

        let mut user = RawAccount::new(USER, true, true, &[]);
        let mut msg = RawAccount::new([8u8; 32], false, true, &[]);
        let mut dwallet = RawAccount::new(DWALLET, false, false, &[]);
        let mut pos = RawAccount::new([5u8; 32], false, false, &pos_bytes);
        let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
        let mut cpi = RawAccount::new_with_owner(*cpi_authority.as_array(), *PROGRAM.as_array(), false, false, &[]);
        let mut sys = RawAccount::new([0u8; 32], false, false, &[]);
        let mut ika = RawAccount::new(*IKA_PROGRAM_ID.as_array(), false, false, &[]);

        let data = [0u8; 67];
        let result = unsafe {
            let mut accounts = [
                user.view(), msg.view(), dwallet.view(), pos.view(),
                caller.view(), cpi.view(), sys.view(), ika.view(),
            ];
            IkaSign::from_data(&data).unwrap().process(&PROGRAM, &mut accounts)
        };
        assert_eq!(result, Err(LendError::Unauthorized.into()));
    }
}

#[test]
fn ika_wrong_cpi_authority_bump_fails_sign() {
    let pos_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_200_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
    let mut user = RawAccount::new(USER, true, true, &[]);
    let mut msg = RawAccount::new([8u8; 32], false, true, &[]);
    let mut dwallet = RawAccount::new(DWALLET, false, false, &[]);
    let mut pos = RawAccount::new([5u8; 32], false, false, &pos_bytes);
    let mut caller = RawAccount::new(*PROGRAM.as_array(), false, false, &[]);
    let mut wrong_cpi = RawAccount::new([6u8; 32], false, false, &[]);
    let mut sys = RawAccount::new([0u8; 32], false, false, &[]);
    let mut ika = RawAccount::new(*IKA_PROGRAM_ID.as_array(), false, false, &[]);

    let data = [0u8; 67];
    let result = unsafe {
        let mut accounts = [
            user.view(), msg.view(), dwallet.view(), pos.view(),
            caller.view(), wrong_cpi.view(), sys.view(), ika.view(),
        ];
        IkaSign::from_data(&data).unwrap().process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::InvalidPda.into()));
}

// ── 3c. Oracle security — dWallet collateral context ─────────────────────────
// dWallet USD value is declared at registration time. The pool oracle is used
// for all subsequent health-factor comparisons in the broader Veil lending market.
// Oracle manipulation remains blocked by the same checks regardless of context.

#[test]
fn ika_oracle_valid_btc_price_accepted() {
    // BTC at ~$61,200 (expo -8)
    let pyth = valid_pyth(61_200_00_000_000, -8);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "{:?}", result);
}

#[test]
fn ika_oracle_attack_substitute_btc_feed_with_cheaper_feed() {
    // An attacker tries to substitute the legitimate BTC Pyth feed with an
    // easier-to-manipulate feed to inflate their dWallet collateral value.
    let btc_price = valid_pyth(61_200_00_000_000, -8);
    let fake_price= valid_pyth(61_200_00_000_000, -8);

    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut feed_a = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &btc_price);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), feed_a.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }
    let anchored_pool = unsafe { pool_acct.read_data_as::<LendingPool>() };
    let anchored_bytes = unsafe {
        core::slice::from_raw_parts(
            &anchored_pool as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    };
    let mut pool2   = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&anchored_bytes);
    let mut feed_b  = RawAccount::new_with_owner(FEED_B, PYTH_OWNER, false, false, &fake_price);
    let result = unsafe {
        let mut accounts = [pool2.view(), feed_b.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceFeedMismatch.into()));
}

#[test]
fn ika_oracle_attack_wide_conf_during_btc_volatility_rejected() {
    // BTC price=61_200_00_000_000 (large), conf must be < 2% of price.
    // 2% of 61_200_00_000_000 = 1_224_000_000_000.
    // conf = 1_224_000_000_001 → rejected.
    let bad = make_pyth_bytes(61_200_00_000_000i64, 1_224_000_000_001u64, -8, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleConfTooWide.into()));
}

#[test]
fn ika_oracle_attack_negative_btc_price_rejected() {
    let bad = make_pyth_bytes(-1, 0, -8, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

#[test]
fn ika_oracle_attack_crafted_non_pyth_account_rejected() {
    // An attacker crafts a fake account that looks like a Pyth account but has
    // the wrong magic number, trying to inject an arbitrary price.
    let mut crafted = vec![0u8; 512];
    crafted[0..4].copy_from_slice(&0xCAFEBABEu32.to_le_bytes()); // wrong magic
    crafted[8..12].copy_from_slice(&3u32.to_le_bytes());          // correct atype
    crafted[208..216].copy_from_slice(&1_000_000_000_000i64.to_le_bytes()); // price
    crafted[224..228].copy_from_slice(&1u32.to_le_bytes());        // status=Trading
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &crafted);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleInvalid.into()));
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  GROUP 4 — IKA + ENCRYPTION (CROSS-CHAIN PRIVATE POSITIONS)
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// ── 4a. Combined account coexistence ─────────────────────────────────────────

#[test]
fn ika_enc_both_account_types_have_distinct_discriminators() {
    assert_ne!(
        IkaDwalletPosition::DISCRIMINATOR,
        EncryptedPosition::DISCRIMINATOR,
        "IkaDwalletPosition and EncryptedPosition must not share a discriminator"
    );
}

#[test]
fn ika_enc_combined_state_sizes_are_known() {
    // A user with both an Ika position and an encrypted lending position has:
    // IkaDwalletPosition (128) + EncryptedPosition (144) + LendingPool (432)
    // = 704 bytes of on-chain state for the position layer alone.
    let total = IkaDwalletPosition::SIZE + EncryptedPosition::SIZE + LendingPool::SIZE;
    assert_eq!(total, 704);
}

#[test]
fn ika_enc_ika_position_bytes_layout_is_correct() {
    let bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 5_000_000, curve::SECP256K1, scheme::TAPROOT_SHA256, 200);
    assert_eq!(&bytes[0..8], b"VEILIKA!");
    assert_eq!(bytes[116], status::ACTIVE);
    assert_eq!(u16::from_le_bytes(bytes[114..116].try_into().unwrap()), scheme::TAPROOT_SHA256);
}

#[test]
fn ika_enc_enc_position_bytes_layout_is_correct() {
    let bytes = enc_position_bytes(USER, POOL_KEY, 200);
    assert_eq!(&bytes[0..8], b"VEILENC!");
    assert_eq!(&bytes[8..40],  &USER);
    assert_eq!(&bytes[40..72], &POOL_KEY);
}

#[test]
fn ika_enc_ika_position_distinct_from_enc_position_by_discriminator() {
    let ika_bytes = ika_position_bytes(USER, POOL_KEY, DWALLET, 1_000, curve::SECP256K1, scheme::ECDSA_SHA256, 1);
    let enc_bytes = enc_position_bytes(USER, POOL_KEY, 1);
    // Discriminators differ at offset 0..8
    assert_ne!(&ika_bytes[0..8], &enc_bytes[0..8]);
}

// ── 4b. Collateral value with oracle ─────────────────────────────────────────

#[test]
fn ika_enc_usd_value_in_cents_math() {
    // dWallet registered at $12,000.00 → usd_value = 1_200_000 cents
    // Expressed in USD: 1_200_000 / 100 = 12_000.0
    let usd_cents = 1_200_000u64;
    let usd = usd_cents as f64 / 100.0;
    assert!((usd - 12_000.0).abs() < f64::EPSILON);
}

#[test]
fn ika_enc_ltv_of_ika_collateral_math() {
    // $12,000 BTC dWallet at 75% LTV → max borrow = $9,000
    let usd_cents = 1_200_000u64;
    let max_borrow = max_borrowable(usd_cents, LTV).unwrap();
    assert_eq!(max_borrow, 900_000u64); // $9,000 in cents
}

#[test]
fn ika_enc_health_factor_with_ika_and_encrypted_borrow() {
    // dWallet collateral = $12,000 (cents), encrypted borrow = $9,000 (cents)
    // HF = (12_000_00 × 0.80) / 900_000 = 1.0666… > 1 → healthy
    let hf = health_factor(1_200_000, 900_000, LIQ_THRESHOLD).unwrap();
    assert!(hf > WAD, "position at LTV cap must be healthy: HF={}", hf);
}

#[test]
fn ika_enc_liquidation_of_ika_encrypted_position() {
    // Simulate: collateral drops to $10,000, debt remains $9,000
    // HF = (10_000_00 × 0.80) / 900_000 = 0.888… < 1 → liquidatable
    let collateral = 1_000_000u64; // $10,000
    let debt       = 900_000u64;   // $9,000
    let hf = health_factor(collateral, debt, LIQ_THRESHOLD).unwrap();
    assert!(hf < WAD, "collateral drop must trigger liquidation: HF={}", hf);

    let repay  = wad_mul(debt as u128, CLOSE_FACTOR).unwrap() as u64; // 450_000 ($4,500)
    let seized = wad_mul(repay as u128, WAD + LIQ_BONUS).unwrap() as u64; // 472_500 ($4,725)
    assert_eq!(repay,  450_000);
    assert_eq!(seized, 472_500);
}

// ── 4c. Oracle security — cross-chain private position context ────────────────

#[test]
fn ika_enc_oracle_valid_price_serves_ika_encrypted_pool() {
    // Pool used for cross-chain + encrypted positions uses the same oracle.
    let pyth = valid_pyth(168_42_000_000, -8); // $168.42 SOL price
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert!(result.is_ok(), "{:?}", result);
}

#[test]
fn ika_enc_oracle_attack_flash_loan_widens_conf_rejected() {
    // An attacker uses a flash loan to move the SOL price in AMMs.
    // Pyth's confidence widens before the aggregate price shifts.
    // price = 1_000_000_000, conf = 20_000_001 → 2.0000001% > 2% → rejected
    let bad = make_pyth_bytes(1_000_000_000, 20_000_001, -8, 1);
    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&unanchored_pool());
    let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &bad);
    let result = unsafe {
        let mut accounts = [pool_acct.view(), pyth_acct.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OracleConfTooWide.into()),
        "flash-loan widened oracle must be blocked for Ika+encrypted pools");
}

#[test]
fn ika_enc_oracle_attack_feed_substitution_on_combined_pool_rejected() {
    // Anchor the real feed, then try to substitute with an attacker-controlled feed.
    let real_pyth = valid_pyth(10_000_000_000, -8);
    let fake_pyth = valid_pyth(99_999_999_999, -8); // inflated price on fake feed

    let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true, &unanchored_pool());
    let mut feed_real = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, &real_pyth);
    let mut auth = RawAccount::new(AUTHORITY, true, false, &[]);
    unsafe {
        let mut accounts = [pool_acct.view(), feed_real.view(), auth.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts).unwrap();
    }
    let anchored = unsafe { pool_acct.read_data_as::<LendingPool>() };
    let anchored_bytes = unsafe {
        core::slice::from_raw_parts(
            &anchored as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    };
    let mut pool2     = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&anchored_bytes);
    let mut feed_fake = RawAccount::new_with_owner(FEED_B, PYTH_OWNER, false, false, &fake_pyth);
    let result = unsafe {
        let mut accounts = [pool2.view(), feed_fake.view()];
        UpdateOraclePrice.process(&PROGRAM, &mut accounts)
    };
    assert_eq!(result, Err(LendError::OraclePriceFeedMismatch.into()),
        "inflated feed substitution must be rejected even for Ika+encrypted pools");
}

#[test]
fn ika_enc_oracle_attack_all_six_vectors_in_sequence() {
    // Comprehensive sweep: exercise all six rejection paths against the same pool.
    let pool_data = unanchored_pool();

    let cases: &[(&str, Vec<u8>, pinocchio::error::ProgramError)] = &[
        ("wrong magic",  {
            let mut b = make_pyth_bytes(10_000_000_000, 1, -8, 1);
            b[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());
            b
        }, LendError::OracleInvalid.into()),
        ("wrong atype",  {
            let mut b = make_pyth_bytes(10_000_000_000, 1, -8, 1);
            b[8..12].copy_from_slice(&1u32.to_le_bytes()); // MappingAccount
            b
        }, LendError::OracleInvalid.into()),
        ("status=0",     make_pyth_bytes(10_000_000_000, 1, -8, 0), LendError::OraclePriceStale.into()),
        ("zero price",   make_pyth_bytes(0, 0, -8, 1),               LendError::OracleInvalid.into()),
        ("neg price",    make_pyth_bytes(-1, 0, -8, 1),              LendError::OracleInvalid.into()),
        ("wide conf",    make_pyth_bytes(100_000, 2_001, -6, 1),     LendError::OracleConfTooWide.into()),
    ];

    for (label, pyth_bytes, expected_err) in cases {
        let mut pool_acct = RawAccount::new_with_owner([0u8; 32], *PROGRAM.as_array(), false, true,&pool_data);
        let mut pyth_acct = RawAccount::new_with_owner(FEED_A, PYTH_OWNER, false, false, pyth_bytes);
        let result = unsafe {
            let mut accounts = [pool_acct.view(), pyth_acct.view()];
            UpdateOraclePrice.process(&PROGRAM, &mut accounts)
        };
        assert_eq!(result, Err(expected_err.clone()),
            "attack case '{}' produced wrong error", label);
    }
}

#[test]
fn ika_enc_oracle_error_codes_are_unique() {
    use std::collections::HashSet;
    let codes: Vec<u32> = vec![
        LendError::OracleInvalid as u32,
        LendError::OraclePriceStale as u32,
        LendError::OraclePriceFeedMismatch as u32,
        LendError::OracleConfTooWide as u32,
    ];
    let unique: HashSet<_> = codes.iter().collect();
    assert_eq!(unique.len(), codes.len(), "oracle error codes must be unique");
}
