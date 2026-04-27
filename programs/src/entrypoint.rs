use pinocchio::{
    account::AccountView,
    entrypoint,
    error::ProgramError,
    Address, ProgramResult,
};
#[cfg(not(test))]
use pinocchio::nostd_panic_handler;

use crate::instructions::{
    Borrow, CollectFees, CrossBorrow, CrossLiquidate, CrossRepay, CrossWithdraw, Deposit,
    EnablePrivacy, FlashBorrow, FlashRepay, IkaRegister, IkaRelease, IkaSign, Initialize,
    Liquidate, PausePool, PrivateBorrow, PrivateDeposit, PrivateRepay, PrivateWithdraw,
    Repay, ResumePool, SetPoolDecimals, UpdateOraclePrice, UpdatePool, Withdraw,
};
#[cfg(feature = "testing")]
use crate::instructions::MockFees;
#[cfg(feature = "testing")]
use crate::instructions::MockOracle;

entrypoint!(process_instruction);
#[cfg(not(test))]
nostd_panic_handler!();

pub fn process_instruction(
    program_id: &Address,
    accounts:   &mut [AccountView],
    data:       &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        Initialize::DISCRIMINATOR => Initialize::from_data(rest)?.process(program_id, accounts),
        Deposit::DISCRIMINATOR    => Deposit::from_data(rest)?.process(program_id, accounts),
        Withdraw::DISCRIMINATOR   => Withdraw::from_data(rest)?.process(program_id, accounts),
        Borrow::DISCRIMINATOR     => Borrow::from_data(rest)?.process(program_id, accounts),
        Repay::DISCRIMINATOR       => Repay::from_data(rest)?.process(program_id, accounts),
        Liquidate::DISCRIMINATOR   => Liquidate::from_data(rest)?.process(program_id, accounts),
        FlashBorrow::DISCRIMINATOR    => FlashBorrow::from_data(rest)?.process(program_id, accounts),
        FlashRepay::DISCRIMINATOR     => FlashRepay::from_data(rest)?.process(program_id, accounts),
        EnablePrivacy::DISCRIMINATOR   => EnablePrivacy::from_data(rest)?.process(program_id, accounts),
        PrivateDeposit::DISCRIMINATOR  => PrivateDeposit::from_data(rest)?.process(program_id, accounts),
        PrivateBorrow::DISCRIMINATOR   => PrivateBorrow::from_data(rest)?.process(program_id, accounts),
        PrivateRepay::DISCRIMINATOR    => PrivateRepay::from_data(rest)?.process(program_id, accounts),
        PrivateWithdraw::DISCRIMINATOR => PrivateWithdraw::from_data(rest)?.process(program_id, accounts),
        UpdatePool::DISCRIMINATOR      => UpdatePool::from_data(rest)?.process(program_id, accounts),
        PausePool::DISCRIMINATOR       => PausePool::from_data(rest)?.process(program_id, accounts),
        ResumePool::DISCRIMINATOR      => ResumePool::from_data(rest)?.process(program_id, accounts),
        CollectFees::DISCRIMINATOR     => CollectFees::from_data(rest)?.process(program_id, accounts),
        IkaRegister::DISCRIMINATOR     => IkaRegister::from_data(rest)?.process(program_id, accounts),
        IkaRelease::DISCRIMINATOR      => IkaRelease::from_data(rest)?.process(program_id, accounts),
        IkaSign::DISCRIMINATOR         => IkaSign::from_data(rest)?.process(program_id, accounts),
        UpdateOraclePrice::DISCRIMINATOR => UpdateOraclePrice::from_data(rest)?.process(program_id, accounts),
        SetPoolDecimals::DISCRIMINATOR   => SetPoolDecimals::from_data(rest)?.process(program_id, accounts),
        CrossBorrow::DISCRIMINATOR       => CrossBorrow::from_data(rest)?.process(program_id, accounts),
        CrossWithdraw::DISCRIMINATOR     => CrossWithdraw::from_data(rest)?.process(program_id, accounts),
        CrossRepay::DISCRIMINATOR        => CrossRepay::from_data(rest)?.process(program_id, accounts),
        CrossLiquidate::DISCRIMINATOR    => CrossLiquidate::from_data(rest)?.process(program_id, accounts),
        #[cfg(feature = "testing")]
        MockFees::DISCRIMINATOR          => MockFees::process(program_id, accounts),
        #[cfg(feature = "testing")]
        MockOracle::DISCRIMINATOR        => MockOracle::from_data(rest)?.process(program_id, accounts),
        _                              => Err(ProgramError::InvalidInstructionData),
    }
}
