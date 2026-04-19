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
    /// Flash loan is already in progress; cannot start another.
    FlashLoanActive,
    /// FlashRepay called but no flash loan is in progress.
    FlashLoanNotActive,
    /// Repayment amount is less than borrowed + fee.
    FlashLoanRepayInsufficient,
    /// Signer is not the pool authority.
    Unauthorized,
    /// Pool is paused; deposits and borrows are blocked.
    PoolPaused,
    /// No fees have accumulated to collect.
    NoFeesToCollect,
    /// Pyth price account has bad magic / type / negative price.
    OracleInvalid,
    /// Pyth aggregate status is not Trading (price is stale).
    OraclePriceStale,
    /// Provided price feed does not match the one anchored to the pool.
    OraclePriceFeedMismatch,
}

impl From<LendError> for ProgramError {
    fn from(e: LendError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
