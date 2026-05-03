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
    /// Pyth confidence interval exceeds 1 % of price — data too uncertain.
    OracleConfTooWide,
    /// Position is used as cross-collateral; use CrossWithdraw instead.
    CrossCollateralActive,
    /// Pool has no oracle anchored — cannot do cross-collateral operations.
    OracleNotAnchored,
    /// Supplied vault account does not match the one anchored to the pool.
    InvalidVault,
    /// Supplied token program is neither SPL Token nor Token-2022.
    InvalidTokenProgram,
    /// Number of cross-collateral positions provided does not match the
    /// pool's recorded count for the user (selective omission attack).
    CrossPositionCountMismatch,
    /// A position passed as cross-collateral was already counted in this
    /// instruction (duplicate position attack).
    DuplicateCrossPosition,
    /// Pool has open deposits or borrows; the requested admin change would
    /// retroactively re-value existing balances.
    PoolNotEmpty,
    /// Provided parameter is outside the allowed safety bounds.
    ParameterOutOfBounds,
    /// Liquidator is the same wallet as the position owner — self-liquidation
    /// is forbidden (it lets the borrower preempt other liquidators and reset
    /// their position state at will).
    SelfLiquidation,
    /// dWallet still has outstanding borrows; cannot be released.
    OutstandingDebt,
    /// Caller does not match the hardcoded admin authorised for testing-only
    /// instructions (`MockOracle`, `MockFees`).
    NotMockAdmin,
    /// FlashRepay was not found in the same transaction as FlashBorrow.
    FlashRepayMissing,
    /// Pool's `max_ika_usd_cents` is 0 — Ika collateral is disabled here
    /// until the pool authority opts in via `SetIkaCollateralCap`.
    IkaCollateralDisabled,
    /// Requested Ika USD value exceeds the pool's per-position cap.
    IkaCollateralExceedsCap,
}

impl From<LendError> for ProgramError {
    fn from(e: LendError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
