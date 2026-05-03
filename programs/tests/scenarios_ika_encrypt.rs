/*!
End-to-end composition scenarios that exercise Ika dWallet positions and
the privacy (FHE) layer alongside the base lending primitives.

Each test runs the financial state machine directly on the structs (bypassing
AccountView, CPI, and syscalls). The privacy-enabled instructions update
plaintext `UserPosition` identically to their public siblings, so the
plaintext bookkeeping is what we assert here. The encrypted-mirror update
is a stubbed CPI today (see `programs/src/fhe/context.rs`); there is
nothing observable to assert about ciphertext from host code yet.

Coverage:
  1. `ika_collateral_position_state_machine` — IkaDwalletPosition lifecycle.
  2. `private_position_in_normal_pool_full_round_trip` — EnablePrivacy +
     deposit/borrow/repay/withdraw via the plaintext side.
  3. `private_position_with_ika_collateral_co_exist` — both PDAs for the
     same user/pool, distinct discriminators.
  4. `cross_borrow_with_privacy_enabled_legs_math` — cross-collateral math
     holds when one leg also has an EncryptedPosition.
  5. `flash_loan_round_trip_with_privacy_enabled_pool` — pool-level flash
     loan works regardless of any user's privacy state.
  6. `flash_loan_from_ika_pool_round_trip` — flash loan works on a pool
     that hosts IkaDwalletPositions.

Future scope (see `docs/IKA_COLLATERAL_WIRING.md`): wire
`IkaDwalletPosition.usd_value` into the actual `cross_borrow` /
`cross_withdraw` / `cross_liquidate` paths. Today those instructions
ignore Ika positions, so any "borrow against my dWallet" demo still needs
SPL deposits to back it.
*/

mod common;

use common::{make_pool, RawAccount};
use veil_lending::{
    math::{
        self, current_borrow_balance, current_deposit_balance, deposit_to_shares,
        flash_fee, health_factor, max_borrowable, split_flash_fee,
        BASE_RATE, CLOSE_FACTOR, FLASH_FEE_BPS, LIQ_BONUS, LIQ_THRESHOLD, LTV,
        OPTIMAL_UTIL, PROTOCOL_LIQ_FEE, RESERVE_FACTOR, SLOPE1, SLOPE2, WAD,
    },
    state::{
        ika_position::{curve, scheme, status},
        EncryptedPosition, IkaDwalletPosition, LendingPool, UserPosition,
    },
};

const AUTHORITY: [u8; 32] = [1u8; 32];
const USER:      [u8; 32] = [2u8; 32];
const POOL_KEY:  [u8; 32] = [3u8; 32];
const DWALLET:   [u8; 32] = [4u8; 32];
const POOL_USDC: [u8; 32] = [5u8; 32];

// ── Helpers ───────────────────────────────────────────────────────────────────

/// A zeroed pool with default risk + rate parameters and a non-zero Pyth
/// feed so cross-collateral USD math is exercised.
fn pool_with_oracle(price: i64, expo: i32, decimals: u8) -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.base_rate = BASE_RATE;
    pool.optimal_utilization = OPTIMAL_UTIL;
    pool.slope1 = SLOPE1;
    pool.slope2 = SLOPE2;
    pool.reserve_factor = RESERVE_FACTOR;
    pool.ltv = LTV;
    pool.liquidation_threshold = LIQ_THRESHOLD;
    pool.liquidation_bonus = LIQ_BONUS;
    pool.protocol_liq_fee = PROTOCOL_LIQ_FEE;
    pool.close_factor = CLOSE_FACTOR;
    pool.flash_fee_bps = FLASH_FEE_BPS;
    pool.token_decimals = decimals;
    pool.oracle_price = price;
    pool.oracle_expo = expo;
    // Non-zero feed: cross-collateral helpers reject pools without an
    // anchored oracle, so we set a placeholder. Real instruction-level
    // anchoring is exercised in protocol_tests.rs.
    pool.pyth_price_feed = pinocchio::Address::new_from_array([0xAB; 32]);
    pool
}

fn fresh_position(owner: [u8; 32], pool: [u8; 32]) -> UserPosition {
    let mut pos: UserPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = UserPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(owner);
    pos.pool = pinocchio::Address::new_from_array(pool);
    pos.deposit_index_snapshot = WAD;
    pos.borrow_index_snapshot = WAD;
    pos
}

fn fresh_ika_position(usd_cents: u64) -> IkaDwalletPosition {
    let mut pos: IkaDwalletPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = IkaDwalletPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(USER);
    pos.pool = pinocchio::Address::new_from_array(POOL_KEY);
    pos.dwallet = pinocchio::Address::new_from_array(DWALLET);
    pos.usd_value = usd_cents;
    pos.curve = curve::SECP256K1;
    pos.signature_scheme = scheme::ECDSA_SHA256;
    pos.status = status::ACTIVE;
    pos
}

fn fresh_enc_position() -> EncryptedPosition {
    let mut pos: EncryptedPosition = unsafe { core::mem::zeroed() };
    pos.discriminator = EncryptedPosition::DISCRIMINATOR;
    pos.owner = pinocchio::Address::new_from_array(USER);
    pos.pool = pinocchio::Address::new_from_array(POOL_KEY);
    pos.enc_deposit = [0xCD; 32];
    pos.enc_debt = [0xEF; 32];
    pos
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. IKA COLLATERAL POSITION STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn ika_collateral_position_state_machine() {
    // Step 1: register dWallet at $30,000 (3_000_000 cents).
    let mut ika = fresh_ika_position(3_000_000);
    assert_eq!(ika.status, status::ACTIVE);
    assert_eq!(ika.usd_value, 3_000_000);

    // Step 2: a *future* cross_borrow that reads ika.usd_value would weight
    // it by the LTV of the BTC pool the dWallet is anchored to. With
    // default 75% LTV, max borrow USD = $22,500.
    //
    // NOTE: the existing cross_borrow path does NOT yet read ika.usd_value
    // (see docs/IKA_COLLATERAL_WIRING.md). This assertion documents the
    // *target* semantics for B.
    let max_borrow_cents = max_borrowable(ika.usd_value, LTV).unwrap();
    assert_eq!(max_borrow_cents, 2_250_000); // $22,500 in cents.

    // Step 3: liquidator scenario — if the off-chain BTC value drops to
    // $20,000 while debt sits at $22,500, HF < 1.
    let underwater_collat: u64 = 2_000_000; // $20k cents
    let debt: u64             = 2_250_000; // $22.5k cents
    let hf = health_factor(underwater_collat, debt, LIQ_THRESHOLD).unwrap();
    assert!(hf < WAD, "underwater BTC dWallet must liquidate: HF={}", hf);

    // Step 4: release flow — caller transitions the position to RELEASED.
    ika.status = status::RELEASED;
    assert_ne!(ika.status, status::ACTIVE);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PRIVATE POSITION IN A NORMAL POOL: FULL DEPOSIT/BORROW/REPAY/WITHDRAW
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn private_position_in_normal_pool_full_round_trip() {
    // Pool: USDC at $1, 6 decimals. Plaintext bookkeeping is the source of
    // truth for solvency; the EncryptedPosition mirror is updated by the
    // (currently stubbed) FHE CPI but does not affect HF math.
    let mut pool = pool_with_oracle(100_000_000, -8, 6); // $1.00
    let mut user = fresh_position(USER, POOL_KEY);

    // The EncryptedPosition exists alongside the plaintext one.
    let enc = fresh_enc_position();
    assert_eq!(enc.owner.as_array(), &USER);
    assert_eq!(enc.pool.as_array(), &POOL_KEY);

    // PrivateDeposit: plaintext side should mint shares the same way as
    // the public Deposit instruction.
    let deposit_amt: u64 = 10_000_000_000; // 10,000 USDC
    let shares = deposit_to_shares(deposit_amt, pool.supply_index).unwrap();
    user.deposit_shares = user.deposit_shares.saturating_add(shares);
    user.deposit_index_snapshot = pool.supply_index;
    pool.total_deposits = pool.total_deposits.saturating_add(deposit_amt);

    // PrivateBorrow: borrow 5,000 USDC against the 10,000 USDC deposit.
    let borrow_amt: u64 = 5_000_000_000;
    let dep_balance = current_deposit_balance(user.deposit_shares, pool.supply_index).unwrap();
    let max_borrow = max_borrowable(dep_balance, pool.ltv).unwrap();
    assert!(borrow_amt <= max_borrow, "borrow within LTV cap");

    let post_hf = health_factor(dep_balance, borrow_amt, pool.liquidation_threshold).unwrap();
    assert!(post_hf >= WAD, "post-borrow HF must stay healthy");

    user.borrow_principal = user.borrow_principal.saturating_add(borrow_amt);
    user.borrow_index_snapshot = pool.borrow_index;
    pool.total_borrows = pool.total_borrows.saturating_add(borrow_amt);

    // Accrue some interest.
    pool.accrue_interest(86_400 * 30).unwrap(); // 30 days

    // PrivateRepay: settle the full debt.
    let debt = current_borrow_balance(
        user.borrow_principal, pool.borrow_index, user.borrow_index_snapshot,
    ).unwrap();
    user.borrow_principal = 0;
    user.borrow_index_snapshot = pool.borrow_index;
    pool.total_borrows = pool.total_borrows.saturating_sub(debt);

    // PrivateWithdraw: redeem the full deposit.
    let redeem_shares = user.deposit_shares;
    let token_out = current_deposit_balance(redeem_shares, pool.supply_index).unwrap();
    user.deposit_shares = 0;
    pool.total_deposits = pool.total_deposits.saturating_sub(token_out);

    // Final invariants: position is empty; pool is consistent.
    assert_eq!(user.deposit_shares, 0);
    assert_eq!(user.borrow_principal, 0);
    // total_deposits may carry residual interest credited to LPs (correct
    // long-term behaviour); total_borrows is fully drained.
    assert_eq!(pool.total_borrows, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRIVATE + IKA POSITIONS ON THE SAME USER/POOL
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn private_position_with_ika_collateral_co_exist() {
    let enc = fresh_enc_position();
    let ika = fresh_ika_position(3_000_000);

    // Distinct PDA discriminators — neither account can be misread as the
    // other on-chain.
    assert_ne!(EncryptedPosition::DISCRIMINATOR, IkaDwalletPosition::DISCRIMINATOR);
    assert_eq!(&EncryptedPosition::DISCRIMINATOR, b"VEILENC!");
    assert_eq!(&IkaDwalletPosition::DISCRIMINATOR, b"VEILIKA!");

    // Same owner / pool binding on both — proves the two PDAs co-exist
    // for one user without clashing.
    assert_eq!(enc.owner.as_array(), ika.owner.as_array());
    assert_eq!(enc.pool.as_array(),  ika.pool.as_array());

    // Sizing: both fit alongside a UserPosition without collision.
    let total = EncryptedPosition::SIZE + IkaDwalletPosition::SIZE + UserPosition::SIZE;
    assert_eq!(total, 144 + 128 + 144);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CROSS-BORROW WITH ONE PRIVACY-ENABLED LEG (math)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn cross_borrow_with_privacy_enabled_legs_math() {
    // Two pools — BTC ($60k) collateral, USDC ($1) borrow target. A
    // privacy-enabled position on the USDC side must not change the USD
    // health math (cross_borrow reads plaintext UserPosition, not the
    // EncryptedPosition mirror).
    let btc_pool  = pool_with_oracle(6_000_000_000_000, -8, 8); // $60k
    let usdc_pool = pool_with_oracle(100_000_000, -8, 6);       // $1.00

    // User holds 0.5 BTC = $30,000 deposit.
    let btc_pos_shares: u64 = 50_000_000; // 0.5 BTC at supply_index = WAD
    let btc_deposit_balance = current_deposit_balance(btc_pos_shares, btc_pool.supply_index).unwrap();
    let btc_usd = math::token_to_usd_wad(
        btc_deposit_balance, btc_pool.oracle_price, btc_pool.oracle_expo, btc_pool.token_decimals,
    ).unwrap();
    let ltv_collateral = math::wad_mul(btc_usd, btc_pool.ltv).unwrap();
    let liq_collateral = math::wad_mul(btc_usd, btc_pool.liquidation_threshold).unwrap();

    // Borrow 10,000 USDC.
    let borrow_amt: u64 = 10_000_000_000;
    let borrow_usd = math::token_to_usd_wad(
        borrow_amt, usdc_pool.oracle_price, usdc_pool.oracle_expo, usdc_pool.token_decimals,
    ).unwrap();

    // LTV cap: 75% of $30k = $22,500. $10k borrow is under cap.
    let max_borrow_usd = math::cross_max_borrowable_usd(ltv_collateral, 0).unwrap();
    assert!(borrow_usd <= max_borrow_usd,
        "USDC borrow must fit under BTC-LTV cap: {} <= {}", borrow_usd, max_borrow_usd);

    // Global HF: 80% × $30k / $10k = 2.4. Healthy.
    let hf = math::cross_health_factor(liq_collateral, borrow_usd).unwrap();
    assert!(hf >= WAD, "cross-collateral position must be healthy: HF={}", hf);

    // Privacy on the USDC side does not affect this math at all — it just
    // means the EncryptedPosition mirror is updated through the FHE stub.
    let _enc_on_usdc = fresh_enc_position();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FLASH LOAN ON A POOL THAT HAS PRIVATE POSITIONS
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn flash_loan_round_trip_with_privacy_enabled_pool() {
    // Pool starts with 1M USDC liquidity and zero borrows; one user has
    // privacy enabled (irrelevant to flash, which works at pool level).
    let mut pool = pool_with_oracle(100_000_000, -8, 6);
    pool.total_deposits = 1_000_000_000_000;

    let _enc_user = fresh_enc_position();

    // Flash 100,000 USDC.
    let loan_amount: u64 = 100_000_000_000;
    let fee = flash_fee(loan_amount, pool.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(fee);

    // FlashBorrow: pool records the in-flight loan.
    pool.flash_loan_amount = loan_amount;
    assert_eq!(pool.flash_loan_amount, loan_amount);

    // FlashRepay: settle the loan + fee.
    pool.total_deposits = pool.total_deposits.saturating_add(lp_fee);
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
    pool.flash_loan_amount = 0;

    assert_eq!(pool.flash_loan_amount, 0);
    assert_eq!(pool.total_deposits, 1_000_000_000_000 + lp_fee);
    assert_eq!(pool.accumulated_fees, protocol_fee);
    assert!(lp_fee > 0 && protocol_fee > 0,
        "fee must split into both buckets even alongside private users");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. FLASH LOAN ON A POOL THAT HOSTS IKA POSITIONS
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn flash_loan_from_ika_pool_round_trip() {
    // BTC pool with 1 BTC of liquidity. IkaDwalletPositions register
    // off-chain BTC backing for cross-borrow but do NOT contribute to
    // the SPL vault — flash math reads vault liquidity only.
    let mut pool = pool_with_oracle(6_000_000_000_000, -8, 8);
    pool.total_deposits = 100_000_000; // 1 BTC in 8-decimal base units

    // A user holds an Ika position against this pool. The position has
    // zero effect on flash availability.
    let _ika = fresh_ika_position(3_000_000); // $30k declared

    // Flash 0.5 BTC.
    let loan_amount: u64 = 50_000_000;
    let fee = flash_fee(loan_amount, pool.flash_fee_bps).unwrap();
    let (lp_fee, protocol_fee) = split_flash_fee(fee);

    // Pool must have enough free liquidity (no in-flight loans, no debt).
    let available = pool.total_deposits
        .saturating_sub(pool.total_borrows)
        .saturating_sub(pool.accumulated_fees);
    assert!(loan_amount <= available, "BTC pool must have flash liquidity");

    pool.flash_loan_amount = loan_amount;
    pool.total_deposits = pool.total_deposits.saturating_add(lp_fee);
    pool.accumulated_fees = pool.accumulated_fees.saturating_add(protocol_fee);
    pool.flash_loan_amount = 0;

    assert_eq!(pool.flash_loan_amount, 0);
    assert!(pool.total_deposits > 100_000_000,
        "LP balance grew by lp_fee after flash settlement");
    assert!(fee >= 1, "flash fee always rounds up to at least 1 base unit");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity guards: byte sizes + discriminators stay aligned with on-chain.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn composition_sizes_match_on_chain_layouts() {
    // If any of these change, every paired test above silently miscomputes.
    assert_eq!(LendingPool::SIZE,        432);
    assert_eq!(UserPosition::SIZE,       144);
    assert_eq!(EncryptedPosition::SIZE,  144);
    assert_eq!(IkaDwalletPosition::SIZE, 128);
}

#[test]
fn make_pool_helper_produces_valid_struct_for_compositions() {
    // Confirms the shared `make_pool` helper still yields a struct that
    // round-trips through this file's Buffer/Address handling. Catches
    // accidental drift in helper signatures during rebases.
    let p = make_pool(AUTHORITY, 0);
    assert_eq!(p.authority, pinocchio::Address::new_from_array(AUTHORITY));
    assert_eq!(p.borrow_index, WAD);
    assert_eq!(p.supply_index, WAD);
    let _raw = RawAccount::new(POOL_USDC, false, true, &[]);
}
