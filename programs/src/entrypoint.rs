use pinocchio::{
    account::AccountView,
    entrypoint,
    error::ProgramError,
    nostd_panic_handler,
    Address, ProgramResult,
};

use crate::instructions::{
    Borrow, Deposit, EnablePrivacy, FlashBorrow, FlashRepay, Initialize, Liquidate,
    PrivateBorrow, PrivateDeposit, PrivateRepay, PrivateWithdraw, Repay, Withdraw,
};

entrypoint!(process_instruction);
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
        EnablePrivacy::DISCRIMINATOR  => EnablePrivacy::from_data(rest)?.process(program_id, accounts),
        PrivateDeposit::DISCRIMINATOR => PrivateDeposit::from_data(rest)?.process(program_id, accounts),
        PrivateBorrow::DISCRIMINATOR  => PrivateBorrow::from_data(rest)?.process(program_id, accounts),
        PrivateRepay::DISCRIMINATOR   => PrivateRepay::from_data(rest)?.process(program_id, accounts),
        PrivateWithdraw::DISCRIMINATOR => PrivateWithdraw::from_data(rest)?.process(program_id, accounts),
        _                             => Err(ProgramError::InvalidInstructionData),
    }
}
