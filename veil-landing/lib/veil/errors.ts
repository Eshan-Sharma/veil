/**
 * On-chain LendError code → human-readable mapping.
 * Source of truth: programs/src/errors.rs (kept in sync manually).
 *
 * Used by `formatTxError()` to surface friendly messages on the UI while
 * the raw SendTransactionError stack stays in `logSafe(...)` for the console.
 */

export type LendError = {
  code: number;
  name: string;
  message: string;
};

export const LEND_ERRORS: Record<number, { name: string; message: string }> = {
  6000: { name: "MissingSignature", message: "A required signer is missing on this transaction." },
  6001: { name: "AccountNotWritable", message: "An account that should be writable was passed read-only." },
  6002: { name: "InvalidAccountOwner", message: "Account owner mismatch — wrong program holds this account." },
  6003: { name: "InvalidDiscriminator", message: "Account data does not match the expected layout." },
  6004: { name: "InvalidPda", message: "PDA derivation did not match the supplied address." },
  6005: { name: "InvalidInstructionData", message: "The instruction data is malformed." },
  6006: { name: "ZeroAmount", message: "Amount cannot be zero." },
  6007: { name: "InsufficientLiquidity", message: "The pool does not have enough liquidity for this operation." },
  6008: { name: "ExceedsCollateralFactor", message: "Borrow would exceed the pool's LTV cap." },
  6009: { name: "Undercollateralised", message: "Health factor would drop below 1.0 — collateral is insufficient." },
  6010: { name: "PositionHealthy", message: "Position is healthy; liquidation is not allowed." },
  6011: { name: "ExceedsCloseFactor", message: "Liquidation repay exceeds the close-factor cap." },
  6012: { name: "ExceedsDepositBalance", message: "Withdraw amount exceeds your deposited balance." },
  6013: { name: "ExceedsDebtBalance", message: "Repay amount exceeds outstanding debt." },
  6014: { name: "NoBorrow", message: "No debt to repay or liquidate." },
  6015: { name: "MathOverflow", message: "Numeric overflow in calculation." },
  6016: { name: "TransferFailed", message: "SPL token transfer failed." },
  6017: { name: "InvalidTimestamp", message: "Clock went backwards (oracle anomaly)." },
  6018: { name: "FlashLoanActive", message: "A flash loan is already in progress in this transaction." },
  6019: { name: "FlashLoanNotActive", message: "FlashRepay called without an active FlashBorrow." },
  6020: { name: "FlashLoanRepayInsufficient", message: "Flash-loan repayment is below borrowed + fee." },
  6021: { name: "Unauthorized", message: "Signer is not the pool authority." },
  6022: { name: "PoolPaused", message: "Pool is paused — deposits and borrows are blocked." },
  6023: { name: "NoFeesToCollect", message: "No accumulated fees to sweep." },
  6024: { name: "OracleInvalid", message: "Pyth price account is invalid (bad magic, type, or sign)." },
  6025: { name: "OraclePriceStale", message: "Oracle price is stale — feed not in Trading status." },
  6026: { name: "OraclePriceFeedMismatch", message: "Provided price feed does not match the one anchored to the pool." },
  6027: { name: "OracleConfTooWide", message: "Oracle confidence interval is too wide (>1% of price)." },
  6028: { name: "CrossCollateralActive", message: "One of the involved positions is already part of a different cross-set." },
  6029: { name: "OracleNotAnchored", message: "Pool has no oracle anchored — cross-collateral operations are disabled." },
  6030: { name: "InvalidVault", message: "Supplied vault does not match the one anchored to this pool." },
  6031: { name: "InvalidTokenProgram", message: "Provided token program is neither SPL Token nor Token-2022." },
  6032: { name: "CrossPositionCountMismatch", message: "Number of cross-collateral positions does not match the user's recorded count." },
  6033: { name: "DuplicateCrossPosition", message: "A position was passed twice as cross-collateral." },
  6034: { name: "PoolNotEmpty", message: "Cannot change parameters: pool has open deposits or borrows." },
  6035: { name: "ParameterOutOfBounds", message: "Parameter is outside the allowed safety bounds." },
  6036: { name: "SelfLiquidation", message: "Liquidator and borrower are the same wallet — self-liquidation forbidden." },
  6037: { name: "OutstandingDebt", message: "dWallet still has outstanding borrows; cannot be released." },
  6038: { name: "NotMockAdmin", message: "Caller is not the hardcoded admin for testing-only instructions." },
  6039: { name: "FlashRepayMissing", message: "FlashRepay was not found in the same transaction as FlashBorrow." },
  6040: { name: "IkaCollateralDisabled", message: "This pool's Ika cap is 0 — opt in via SetIkaCollateralCap first." },
  6041: { name: "IkaCollateralExceedsCap", message: "Requested Ika USD value exceeds the per-position cap." },
};

/** Extract the LendError custom-error code from any of:
 *  - "custom program error: 0x178c"
 *  - "Custom: 6028"
 *  - JSON `{ InstructionError: [_, { Custom: 6028 }] }` (string-coerced)
 *  Returns null if no match.
 */
export function extractLendErrorCode(input: unknown): number | null {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  // Hex form: "custom program error: 0x178c"
  const hex = s.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) {
    const code = parseInt(hex[1], 16);
    if (!Number.isNaN(code)) return code;
  }
  // Decimal form: "Custom: 6028" or "Custom":6028
  const dec = s.match(/"?Custom"?\s*[:=]\s*(\d+)/);
  if (dec) {
    const code = parseInt(dec[1], 10);
    if (!Number.isNaN(code)) return code;
  }
  return null;
}

/** Map any error/string into a one-line friendly message.
 *  - LendError code → "Error 6028 · CrossCollateralActive — <description>"
 *  - Wallet-rejected → "Wallet rejected the transaction"
 *  - Otherwise → first line of the message, capped at ~140 chars
 *  The full original error should still be logged via logSafe(...) for debugging.
 */
export function formatTxError(input: unknown): string {
  // Inspect message + cause + logs together to find the code.
  const err = input as { message?: string; logs?: string[]; cause?: { logs?: string[] } } | null;
  const sources: string[] = [];
  if (err?.message) sources.push(err.message);
  if (err?.logs?.length) sources.push(err.logs.join(" "));
  if (err?.cause?.logs?.length) sources.push(err.cause.logs.join(" "));
  const haystack = sources.join(" ") || String(input);

  const code = extractLendErrorCode(haystack);
  if (code != null) {
    const def = LEND_ERRORS[code];
    if (def) return `Error ${code} · ${def.name} — ${def.message}`;
    return `Error ${code} · unknown LendError — see console`;
  }

  // Wallet user-rejection.
  if (/user rejected|rejected the request|denied/i.test(haystack)) {
    return "Wallet rejected the transaction.";
  }

  // Insufficient lamports (Solana runtime).
  if (/insufficient.*lamports|0x1$/i.test(haystack)) {
    return "Insufficient SOL to cover transaction fees / rent.";
  }

  // Fallback — keep it short, no stack trace.
  const first = (err?.message ?? String(input)).split("\n")[0];
  return first.length > 140 ? first.slice(0, 140) + "…" : first;
}
