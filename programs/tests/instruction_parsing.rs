use veil_lending::{
    instructions::{
        Borrow, CollectFees, Deposit, EnablePrivacy, FlashBorrow, FlashRepay, IkaRegister,
        IkaRelease, IkaSign, Initialize, Liquidate, PausePool, PrivateBorrow, PrivateDeposit,
        PrivateRepay, PrivateWithdraw, Repay, ResumePool, UpdateOraclePrice, UpdatePool, Withdraw,
    },
    math::{
        BASE_RATE, CLOSE_FACTOR, LIQ_BONUS, LIQ_THRESHOLD, LTV, OPTIMAL_UTIL, PROTOCOL_LIQ_FEE,
        RESERVE_FACTOR, SLOPE1, SLOPE2,
    },
    state::ika_position::{curve, scheme},
};

fn update_pool_data(
    base_rate: u128,
    optimal_utilization: u128,
    slope1: u128,
    slope2: u128,
    reserve_factor: u128,
    ltv: u128,
    liquidation_threshold: u128,
    liquidation_bonus: u128,
    protocol_liq_fee: u128,
    close_factor: u128,
    flash_fee_bps: u64,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(168);
    for value in [
        base_rate,
        optimal_utilization,
        slope1,
        slope2,
        reserve_factor,
        ltv,
        liquidation_threshold,
        liquidation_bonus,
        protocol_liq_fee,
        close_factor,
    ] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(&flash_fee_bps.to_le_bytes());
    data
}

fn ika_sign_data() -> Vec<u8> {
    let mut data = vec![0u8; 100];
    data[0..32].copy_from_slice(&[1u8; 32]);
    data[32..64].copy_from_slice(&[2u8; 32]);
    data[64..96].copy_from_slice(&[3u8; 32]);
    data[96..98].copy_from_slice(&1u16.to_le_bytes());
    data[98] = 250;
    data[99] = 251;
    data
}

#[test]
fn core_initialize_from_data_parses_three_bumps() {
    let ix = Initialize::from_data(&[7, 13, 42]).unwrap();
    assert_eq!(ix.pool_bump, 7);
    assert_eq!(ix.authority_bump, 13);
    assert_eq!(ix.vault_bump, 42);
}

#[test]
fn core_initialize_from_data_rejects_short_input() {
    assert!(Initialize::from_data(&[]).is_err());
    assert!(Initialize::from_data(&[1]).is_err());
    assert!(Initialize::from_data(&[1, 2]).is_err());
}

#[test]
fn core_initialize_discriminator_is_zero() {
    assert_eq!(Initialize::DISCRIMINATOR, 0);
}

#[test]
fn core_deposit_from_data_parses_amount_and_bump() {
    let mut data = 500_000u64.to_le_bytes().to_vec();
    data.push(254);
    let ix = Deposit::from_data(&data).unwrap();
    assert_eq!(ix.amount, 500_000);
    assert_eq!(ix.position_bump, 254);
}

#[test]
fn core_deposit_from_data_rejects_short_input() {
    assert!(Deposit::from_data(&[]).is_err());
    assert!(Deposit::from_data(&[0u8; 8]).is_err());
}

#[test]
fn core_deposit_discriminator_is_one() {
    assert_eq!(Deposit::DISCRIMINATOR, 1);
}

#[test]
fn core_withdraw_from_data_parses_shares() {
    let ix = Withdraw::from_data(&999_000u64.to_le_bytes()).unwrap();
    assert_eq!(ix.shares, 999_000);
}

#[test]
fn core_withdraw_from_data_rejects_short_input() {
    assert!(Withdraw::from_data(&[]).is_err());
    assert!(Withdraw::from_data(&[0u8; 7]).is_err());
}

#[test]
fn core_withdraw_discriminator_is_two() {
    assert_eq!(Withdraw::DISCRIMINATOR, 2);
}

#[test]
fn core_borrow_from_data_parses_amount() {
    let ix = Borrow::from_data(&1_234_567u64.to_le_bytes()).unwrap();
    assert_eq!(ix.amount, 1_234_567);
}

#[test]
fn core_borrow_from_data_rejects_short_input() {
    assert!(Borrow::from_data(&[]).is_err());
    assert!(Borrow::from_data(&[0u8; 7]).is_err());
}

#[test]
fn core_borrow_discriminator_is_three() {
    assert_eq!(Borrow::DISCRIMINATOR, 3);
}

#[test]
fn core_repay_from_data_parses_amount() {
    let ix = Repay::from_data(&888_888u64.to_le_bytes()).unwrap();
    assert_eq!(ix.amount, 888_888);
}

#[test]
fn core_repay_from_data_rejects_short_input() {
    assert!(Repay::from_data(&[]).is_err());
    assert!(Repay::from_data(&[0u8; 7]).is_err());
}

#[test]
fn core_repay_discriminator_is_four() {
    assert_eq!(Repay::DISCRIMINATOR, 4);
}

#[test]
fn core_liquidate_from_data_accepts_empty_and_extra_bytes() {
    assert!(Liquidate::from_data(&[]).is_ok());
    assert!(Liquidate::from_data(&[1, 2, 3]).is_ok());
}

#[test]
fn core_liquidate_discriminator_is_five() {
    assert_eq!(Liquidate::DISCRIMINATOR, 5);
}

#[test]
fn flash_borrow_from_data_parses_amount() {
    let ix = FlashBorrow::from_data(&500_000u64.to_le_bytes()).unwrap();
    assert_eq!(ix.amount, 500_000);
}

#[test]
fn flash_borrow_from_data_rejects_short_input() {
    assert!(FlashBorrow::from_data(&[]).is_err());
    assert!(FlashBorrow::from_data(&[0u8; 7]).is_err());
}

#[test]
fn flash_borrow_discriminator_is_six() {
    assert_eq!(FlashBorrow::DISCRIMINATOR, 6);
}

#[test]
fn flash_repay_from_data_accepts_empty_and_extra_bytes() {
    assert!(FlashRepay::from_data(&[]).is_ok());
    assert!(FlashRepay::from_data(&[1, 2, 3]).is_ok());
}

#[test]
fn flash_repay_discriminator_is_seven() {
    assert_eq!(FlashRepay::DISCRIMINATOR, 7);
}

#[test]
fn pools_update_pool_from_data_parses_all_fields() {
    let ix = UpdatePool::from_data(&update_pool_data(
        BASE_RATE,
        OPTIMAL_UTIL,
        SLOPE1,
        SLOPE2,
        RESERVE_FACTOR,
        LTV,
        LIQ_THRESHOLD,
        LIQ_BONUS,
        PROTOCOL_LIQ_FEE,
        CLOSE_FACTOR,
        9,
    ))
    .unwrap();
    assert_eq!(ix.base_rate, BASE_RATE);
    assert_eq!(ix.liquidation_threshold, LIQ_THRESHOLD);
    assert_eq!(ix.flash_fee_bps, 9);
}

#[test]
fn pools_update_pool_from_data_rejects_short_input() {
    assert!(UpdatePool::from_data(&[]).is_err());
    assert!(UpdatePool::from_data(&[0u8; 167]).is_err());
}

#[test]
fn pools_update_pool_discriminator_is_thirteen() {
    assert_eq!(UpdatePool::DISCRIMINATOR, 13);
}

#[test]
fn pools_pause_pool_from_data_accepts_empty_and_extra_bytes() {
    assert!(PausePool::from_data(&[]).is_ok());
    assert!(PausePool::from_data(&[0xff, 0x00]).is_ok());
}

#[test]
fn pools_pause_pool_discriminator_is_fourteen() {
    assert_eq!(PausePool::DISCRIMINATOR, 14);
}

#[test]
fn pools_resume_pool_from_data_accepts_empty_and_extra_bytes() {
    assert!(ResumePool::from_data(&[]).is_ok());
    assert!(ResumePool::from_data(&[0x00]).is_ok());
}

#[test]
fn pools_resume_pool_discriminator_is_fifteen() {
    assert_eq!(ResumePool::DISCRIMINATOR, 15);
}

#[test]
fn pools_collect_fees_from_data_accepts_empty_and_extra_bytes() {
    assert!(CollectFees::from_data(&[]).is_ok());
    assert!(CollectFees::from_data(&[0xde, 0xad]).is_ok());
}

#[test]
fn pools_collect_fees_discriminator_is_sixteen() {
    assert_eq!(CollectFees::DISCRIMINATOR, 16);
}

#[test]
fn pools_update_oracle_price_from_data_accepts_empty_and_extra_bytes() {
    assert!(UpdateOraclePrice::from_data(&[]).is_ok());
    assert!(UpdateOraclePrice::from_data(&[1, 2, 3]).is_ok());
}

#[test]
fn pools_update_oracle_price_discriminator_is_twenty() {
    assert_eq!(UpdateOraclePrice::DISCRIMINATOR, 20);
}

#[test]
fn encryption_enable_privacy_from_data_parses_bumps() {
    let ix = EnablePrivacy::from_data(&[0x42, 0xff]).unwrap();
    assert_eq!(ix.enc_pos_bump, 0x42);
    assert_eq!(ix.cpi_auth_bump, 0xff);
}

#[test]
fn encryption_enable_privacy_from_data_rejects_short_input() {
    assert!(EnablePrivacy::from_data(&[]).is_err());
    assert!(EnablePrivacy::from_data(&[1]).is_err());
}

#[test]
fn encryption_enable_privacy_discriminator_is_eight() {
    assert_eq!(EnablePrivacy::DISCRIMINATOR, 8);
}

#[test]
fn encryption_private_deposit_from_data_parses_amount_and_bump() {
    let mut data = 250_000u64.to_le_bytes().to_vec();
    data.push(123);
    let ix = PrivateDeposit::from_data(&data).unwrap();
    assert_eq!(ix.amount, 250_000);
    assert_eq!(ix.cpi_auth_bump, 123);
}

#[test]
fn encryption_private_deposit_from_data_rejects_short_input() {
    assert!(PrivateDeposit::from_data(&[]).is_err());
    assert!(PrivateDeposit::from_data(&[0u8; 8]).is_err());
}

#[test]
fn encryption_private_deposit_discriminator_is_nine() {
    assert_eq!(PrivateDeposit::DISCRIMINATOR, 9);
}

#[test]
fn encryption_private_borrow_from_data_parses_amount_and_bump() {
    let mut data = 100_000u64.to_le_bytes().to_vec();
    data.push(254);
    let ix = PrivateBorrow::from_data(&data).unwrap();
    assert_eq!(ix.amount, 100_000);
    assert_eq!(ix.cpi_auth_bump, 254);
}

#[test]
fn encryption_private_borrow_from_data_rejects_short_input() {
    assert!(PrivateBorrow::from_data(&[]).is_err());
    assert!(PrivateBorrow::from_data(&[0u8; 8]).is_err());
}

#[test]
fn encryption_private_borrow_discriminator_is_ten() {
    assert_eq!(PrivateBorrow::DISCRIMINATOR, 10);
}

#[test]
fn encryption_private_repay_from_data_parses_amount_and_bump() {
    let mut data = 50_000u64.to_le_bytes().to_vec();
    data.push(200);
    let ix = PrivateRepay::from_data(&data).unwrap();
    assert_eq!(ix.amount, 50_000);
    assert_eq!(ix.cpi_auth_bump, 200);
}

#[test]
fn encryption_private_repay_from_data_rejects_short_input() {
    assert!(PrivateRepay::from_data(&[]).is_err());
    assert!(PrivateRepay::from_data(&[0u8; 8]).is_err());
}

#[test]
fn encryption_private_repay_discriminator_is_eleven() {
    assert_eq!(PrivateRepay::DISCRIMINATOR, 11);
}

#[test]
fn encryption_private_withdraw_from_data_parses_shares_and_bump() {
    let mut data = 10_000u64.to_le_bytes().to_vec();
    data.push(99);
    let ix = PrivateWithdraw::from_data(&data).unwrap();
    assert_eq!(ix.shares, 10_000);
    assert_eq!(ix.cpi_auth_bump, 99);
}

#[test]
fn encryption_private_withdraw_from_data_rejects_short_input() {
    assert!(PrivateWithdraw::from_data(&[]).is_err());
    assert!(PrivateWithdraw::from_data(&[0u8; 8]).is_err());
}

#[test]
fn encryption_private_withdraw_discriminator_is_twelve() {
    assert_eq!(PrivateWithdraw::DISCRIMINATOR, 12);
}

#[test]
fn ika_register_from_data_parses_fields() {
    let mut data = 500_000u64.to_le_bytes().to_vec();
    data.extend_from_slice(&curve::SECP256K1.to_le_bytes());
    data.extend_from_slice(&scheme::ECDSA_SHA256.to_le_bytes());
    data.push(254);
    data.push(255);

    let ix = IkaRegister::from_data(&data).unwrap();
    assert_eq!(ix.usd_value, 500_000);
    assert_eq!(ix.curve, curve::SECP256K1);
    assert_eq!(ix.signature_scheme, scheme::ECDSA_SHA256);
    assert_eq!(ix.position_bump, 254);
    assert_eq!(ix.cpi_authority_bump, 255);
}

#[test]
fn ika_register_from_data_rejects_short_input() {
    assert!(IkaRegister::from_data(&[]).is_err());
    assert!(IkaRegister::from_data(&[0u8; 13]).is_err());
}

#[test]
fn ika_register_discriminator_is_seventeen() {
    assert_eq!(IkaRegister::DISCRIMINATOR, 17);
}

#[test]
fn ika_release_from_data_parses_bump() {
    let ix = IkaRelease::from_data(&[42]).unwrap();
    assert_eq!(ix.cpi_authority_bump, 42);
}

#[test]
fn ika_release_from_data_rejects_empty_input() {
    assert!(IkaRelease::from_data(&[]).is_err());
}

#[test]
fn ika_release_discriminator_is_eighteen() {
    assert_eq!(IkaRelease::DISCRIMINATOR, 18);
}

#[test]
fn ika_sign_from_data_parses_fields() {
    let ix = IkaSign::from_data(&ika_sign_data()).unwrap();
    assert_eq!(ix.message_digest, [1u8; 32]);
    assert_eq!(ix.message_metadata_digest, [2u8; 32]);
    assert_eq!(ix.user_pubkey, [3u8; 32]);
    assert_eq!(ix.signature_scheme, 1);
    assert_eq!(ix.msg_approval_bump, 250);
    assert_eq!(ix.cpi_authority_bump, 251);
}

#[test]
fn ika_sign_from_data_rejects_short_input() {
    assert!(IkaSign::from_data(&[]).is_err());
    assert!(IkaSign::from_data(&[0u8; 99]).is_err());
}

#[test]
fn ika_sign_discriminator_is_nineteen() {
    assert_eq!(IkaSign::DISCRIMINATOR, 19);
}
