use pinocchio::error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum LendError {
    /// Caller is not a signer when required.
    MissingSignature = 6000,
    /// Account is not writable when required.
    AccountNotWritable,
    /// Account owner is not this program.
    InvalidAccountOwner,
    /// Account discriminator does not match.
    InvalidDiscriminator,
    /// PDA derivation mismatch.
    InvalidPda,
    /// Instruction data is malformed.
    InvalidInstructionData,
    /// Amount is zero.
    ZeroAmount,
    /// Pool has insufficient liquidity.
    InsufficientLiquidity,
    /// Borrow would exceed the LTV cap.
    ExceedsCollateralFactor,
    /// Health factor is below 1.0; position is undercollateralised.
    Undercollateralised,
    /// Health factor is ≥ 1.0; liquidation is not allowed.
    PositionHealthy,
    /// Liquidation repay amount exceeds close-factor cap.
    ExceedsCloseFactor,
    /// Withdraw amount exceeds deposited balance.
    ExceedsDepositBalance,
    /// Repay amount exceeds outstanding debt.
    ExceedsDebtBalance,
    /// No debt to repay / liquidate.
    NoBorrow,
    /// Arithmetic overflow in calculation.
    MathOverflow,
    /// Token transfer failed.
    TransferFailed,
    /// Timestamp went backwards.
    InvalidTimestamp,
}

impl From<LendError> for ProgramError {
    fn from(e: LendError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
