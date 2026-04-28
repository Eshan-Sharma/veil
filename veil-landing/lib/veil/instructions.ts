import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";

// ─── helpers ─────────────────────────────────────────────────────────────────

function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}

function u64LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, n, true);
  return buf;
}

function u128LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, n & 0xFFFFFFFFFFFFFFFFn, true);
  dv.setBigUint64(8, n >> 64n, true);
  return buf;
}

function concat(...parts: Uint8Array[]): Buffer {
  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const result = Buffer.allocUnsafe(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ─── Initialize (discriminator 0x00) ─────────────────────────────────────────
//
// Accounts:
//   [0] payer       signer, writable
//   [1] authority   signer
//   [2] pool        writable – PDA
//   [3] tokenMint   read-only
//   [4] vault       read-only – pre-created ATA
//   [5] systemProgram
//
// Data (after disc): pool_bump u8, authority_bump u8, vault_bump u8

export function initializePoolIx(
  payer: PublicKey,
  authority: PublicKey,
  pool: PublicKey,
  tokenMint: PublicKey,
  vault: PublicKey,
  poolBump: number,
  authorityBump: number,
  vaultBump: number
): TransactionInstruction {
  const data = concat(u8(0x00), u8(poolBump), u8(authorityBump), u8(vaultBump));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Deposit (discriminator 0x01) ─────────────────────────────────────────────
//
// Accounts:
//   [0] user              signer, writable
//   [1] userToken         writable
//   [2] vault             writable
//   [3] pool              writable
//   [4] userPosition      writable (created if absent)
//   [5] systemProgram
//   [6] tokenProgram
//
// Data (after disc): amount u64 LE, position_bump u8

export function depositIx(
  user: PublicKey,
  userToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  userPosition: PublicKey,
  amount: bigint,
  positionBump: number
): TransactionInstruction {
  const data = concat(u8(0x01), u64LE(amount), u8(positionBump));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userPosition, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Withdraw (discriminator 0x02) ────────────────────────────────────────────
//
// Accounts:
//   [0] user              signer, writable
//   [1] userToken         writable
//   [2] vault             writable
//   [3] pool              writable
//   [4] userPosition      writable
//   [5] poolAuthority     read-only
//   [6] tokenProgram
//
// Data (after disc): shares u64 LE

export function withdrawIx(
  user: PublicKey,
  userToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  userPosition: PublicKey,
  poolAuthority: PublicKey,
  shares: bigint
): TransactionInstruction {
  const data = concat(u8(0x02), u64LE(shares));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userPosition, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Borrow (discriminator 0x03) ──────────────────────────────────────────────
//
// Accounts:
//   [0] user              signer, writable
//   [1] userToken         writable
//   [2] vault             writable
//   [3] pool              writable
//   [4] userPosition      writable
//   [5] poolAuthority     read-only
//   [6] tokenProgram
//
// Data (after disc): amount u64 LE

export function borrowIx(
  user: PublicKey,
  userToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  userPosition: PublicKey,
  poolAuthority: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = concat(u8(0x03), u64LE(amount));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userPosition, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Repay (discriminator 0x04) ───────────────────────────────────────────────
//
// Accounts:
//   [0] user              signer, writable
//   [1] userToken         writable
//   [2] vault             writable
//   [3] pool              writable
//   [4] userPosition      writable
//   [5] tokenProgram
//
// Data (after disc): amount u64 LE

export function repayIx(
  user: PublicKey,
  userToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  userPosition: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = concat(u8(0x04), u64LE(amount));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userPosition, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Liquidate (discriminator 0x05) ───────────────────────────────────────────
//
// Accounts:
//   [0] liquidator         signer, writable
//   [1] liquidatorToken    writable
//   [2] vault              writable
//   [3] pool               writable
//   [4] borrowerPosition   writable
//   [5] poolAuthority      read-only
//   [6] tokenProgram
//
// Data (after disc): none

export function liquidateIx(
  liquidator: PublicKey,
  liquidatorToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  borrowerPosition: PublicKey,
  poolAuthority: PublicKey
): TransactionInstruction {
  const data = Buffer.from([0x05]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: liquidator, isSigner: true, isWritable: true },
      { pubkey: liquidatorToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: borrowerPosition, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── FlashBorrow (discriminator 0x06) ─────────────────────────────────────────
//
// Accounts:
//   [0] borrower        signer, writable
//   [1] borrowerToken   writable
//   [2] vault           writable
//   [3] pool            writable
//   [4] poolAuthority   read-only
//   [5] tokenProgram
//
// Data (after disc): amount u64 LE

export function flashBorrowIx(
  borrower: PublicKey,
  borrowerToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  poolAuthority: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = concat(u8(0x06), u64LE(amount));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: borrower, isSigner: true, isWritable: true },
      { pubkey: borrowerToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── FlashRepay (discriminator 0x07) ──────────────────────────────────────────
//
// Accounts:
//   [0] borrower        signer, writable
//   [1] borrowerToken   writable
//   [2] vault           writable
//   [3] pool            writable
//   [4] tokenProgram
//
// Data (after disc): none

export function flashRepayIx(
  borrower: PublicKey,
  borrowerToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey
): TransactionInstruction {
  const data = Buffer.from([0x07]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: borrower, isSigner: true, isWritable: true },
      { pubkey: borrowerToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── UpdatePool (discriminator 0x0D) ──────────────────────────────────────────
//
// Accounts:
//   [0] authority  signer
//   [1] pool       writable
//
// Data (after disc): 10×u128 LE + 1×u64 LE = 168 bytes
// All rate / ratio fields are WAD-scaled (1e18 = 100%).
// flash_fee_bps is raw basis points (not WAD).

export type UpdatePoolParams = {
  baseRate: bigint;
  optimalUtilization: bigint;
  slope1: bigint;
  slope2: bigint;
  reserveFactor: bigint;
  ltv: bigint;
  liquidationThreshold: bigint;
  liquidationBonus: bigint;
  protocolLiqFee: bigint;
  closeFactor: bigint;
  flashFeeBps: bigint;
};

export function updatePoolIx(
  authority: PublicKey,
  pool: PublicKey,
  params: UpdatePoolParams
): TransactionInstruction {
  const data = concat(
    u8(0x0D),
    u128LE(params.baseRate),
    u128LE(params.optimalUtilization),
    u128LE(params.slope1),
    u128LE(params.slope2),
    u128LE(params.reserveFactor),
    u128LE(params.ltv),
    u128LE(params.liquidationThreshold),
    u128LE(params.liquidationBonus),
    u128LE(params.protocolLiqFee),
    u128LE(params.closeFactor),
    u64LE(params.flashFeeBps),
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ─── PausePool (discriminator 0x0E) ───────────────────────────────────────────
//
// Accounts:
//   [0] authority  signer
//   [1] pool       writable

export function pausePoolIx(
  authority: PublicKey,
  pool: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([0x0E]),
  });
}

// ─── ResumePool (discriminator 0x0F) ──────────────────────────────────────────
//
// Accounts:
//   [0] authority  signer
//   [1] pool       writable

export function resumePoolIx(
  authority: PublicKey,
  pool: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([0x0F]),
  });
}

// ─── CollectFees (discriminator 0x10) ─────────────────────────────────────────
//
// Accounts:
//   [0] authority      signer
//   [1] pool           writable
//   [2] vault          writable
//   [3] treasury       writable  (authority's destination token account)
//   [4] pool_authority read-only (PDA that owns the vault)
//   [5] token_program

export function collectFeesIx(
  authority: PublicKey,
  pool: PublicKey,
  vault: PublicKey,
  treasury: PublicKey,
  poolAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0x10]),
  });
}

// ─── UpdateOraclePrice (discriminator 0x14) ───────────────────────────────────
//
// Accounts:
//   [0]  pool             writable
//   [1]  pythPriceFeed    read-only (Pyth legacy push-oracle)
//
// Data: just the discriminator byte — no payload.

export function updateOraclePriceIx(
  pool: PublicKey,
  pythPriceFeed: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pool,          isSigner: false, isWritable: true  },
      { pubkey: pythPriceFeed, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0x14]),
  });
}

// Mock test-only instructions (mockOracleIx, mockFeesIx) live in
// `scripts/_mock-instructions.ts` so they never reach the browser bundle.

// ─── SetPoolDecimals (discriminator 0x15) ────────────────────────────────────
//
// Accounts:
//   [0] authority   signer
//   [1] pool        writable
//   [2] tokenMint   read-only

export function setPoolDecimalsIx(
  authority: PublicKey,
  pool: PublicKey,
  tokenMint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0x15]),
  });
}

// ─── InitPosition (discriminator 0x1A) ──────────────────────────────────────
//
// Creates an empty UserPosition PDA without depositing.
// Needed before cross-borrow when the user has no position in the borrow pool.
// Idempotent — no-op if position already exists.
//
// Accounts:
//   [0]  user           signer, writable (pays rent)
//   [1]  pool           read-only
//   [2]  position       writable  — UserPosition PDA
//   [3]  system_program

export function initPositionIx(
  user: PublicKey,
  pool: PublicKey,
  position: PublicKey,
  positionBump: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0x1A, positionBump]),
  });
}

// ─── CrossBorrow (discriminator 0x16) ────────────────────────────────────────
//
// Accounts:
//   [0]  user               signer, writable
//   [1]  borrowPool         writable
//   [2]  borrowPosition     writable
//   [3]  borrowVault        writable
//   [4]  userBorrowToken    writable
//   [5]  borrowPoolAuth     read-only (PDA)
//   [6]  tokenProgram
//   [7..N] collateral pairs: (pool, position) — 2 accounts per collateral pool

export type CollateralPair = {
  pool: PublicKey;
  position: PublicKey;
};

export function crossBorrowIx(
  user: PublicKey,
  borrowPool: PublicKey,
  borrowPosition: PublicKey,
  borrowVault: PublicKey,
  userBorrowToken: PublicKey,
  borrowPoolAuth: PublicKey,
  collateralPairs: CollateralPair[],
  amount: bigint,
): TransactionInstruction {
  const data = concat(u8(0x16), u64LE(amount));
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: borrowPool, isSigner: false, isWritable: true },
    { pubkey: borrowPosition, isSigner: false, isWritable: true },
    { pubkey: borrowVault, isSigner: false, isWritable: true },
    { pubkey: userBorrowToken, isSigner: false, isWritable: true },
    { pubkey: borrowPoolAuth, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...collateralPairs.flatMap((pair) => [
      { pubkey: pair.pool, isSigner: false, isWritable: false },
      { pubkey: pair.position, isSigner: false, isWritable: true },
    ]),
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// ─── CrossWithdraw (discriminator 0x17) ──────────────────────────────────────
//
// Accounts:
//   [0]  user              signer, writable
//   [1]  withdrawPool      writable
//   [2]  withdrawPosition  writable
//   [3]  vault             writable
//   [4]  userToken         writable
//   [5]  poolAuthority     read-only
//   [6]  tokenProgram
//   [7..N] related pairs: (pool, position) for global HF check

export function crossWithdrawIx(
  user: PublicKey,
  withdrawPool: PublicKey,
  withdrawPosition: PublicKey,
  vault: PublicKey,
  userToken: PublicKey,
  poolAuthority: PublicKey,
  relatedPairs: CollateralPair[],
  shares: bigint,
): TransactionInstruction {
  const data = concat(u8(0x17), u64LE(shares));
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: withdrawPool, isSigner: false, isWritable: true },
    { pubkey: withdrawPosition, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: userToken, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...relatedPairs.flatMap((pair) => [
      { pubkey: pair.pool, isSigner: false, isWritable: false },
      { pubkey: pair.position, isSigner: false, isWritable: false },
    ]),
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// ─── CrossRepay (discriminator 0x18) ─────────────────────────────────────────
//
// Accounts:
//   [0]  user           signer, writable
//   [1]  userToken      writable
//   [2]  vault          writable
//   [3]  pool           writable
//   [4]  userPosition   writable
//   [5]  tokenProgram
//   [6..N] collateral positions to clear (writable) — optional

export function crossRepayIx(
  user: PublicKey,
  userToken: PublicKey,
  vault: PublicKey,
  pool: PublicKey,
  userPosition: PublicKey,
  collateralPositions: PublicKey[],
  amount: bigint,
): TransactionInstruction {
  const data = concat(u8(0x18), u64LE(amount));
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: userToken, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: userPosition, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...collateralPositions.map((pos) => ({
      pubkey: pos,
      isSigner: false,
      isWritable: true,
    })),
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// ─── CrossLiquidate (discriminator 0x19) ─────────────────────────────────────
//
// Accounts:
//   [0]  liquidator            signer, writable
//   [1]  liquidatorDebtToken   writable
//   [2]  liquidatorCollToken   writable
//   [3]  debtPool              writable
//   [4]  debtPosition          writable
//   [5]  debtVault             writable
//   [6]  collPool              writable
//   [7]  collPosition          writable
//   [8]  collVault             writable
//   [9]  collPoolAuthority     read-only
//   [10] tokenProgram
//   [11..N] other (pool, position) pairs for global HF check

export function crossLiquidateIx(
  liquidator: PublicKey,
  liquidatorDebtToken: PublicKey,
  liquidatorCollToken: PublicKey,
  debtPool: PublicKey,
  debtPosition: PublicKey,
  debtVault: PublicKey,
  collPool: PublicKey,
  collPosition: PublicKey,
  collVault: PublicKey,
  collPoolAuthority: PublicKey,
  otherPairs: CollateralPair[],
  repayAmount: bigint,
): TransactionInstruction {
  const data = concat(u8(0x19), u64LE(repayAmount));
  const keys = [
    { pubkey: liquidator, isSigner: true, isWritable: true },
    { pubkey: liquidatorDebtToken, isSigner: false, isWritable: true },
    { pubkey: liquidatorCollToken, isSigner: false, isWritable: true },
    { pubkey: debtPool, isSigner: false, isWritable: true },
    { pubkey: debtPosition, isSigner: false, isWritable: true },
    { pubkey: debtVault, isSigner: false, isWritable: true },
    { pubkey: collPool, isSigner: false, isWritable: true },
    { pubkey: collPosition, isSigner: false, isWritable: true },
    { pubkey: collVault, isSigner: false, isWritable: true },
    { pubkey: collPoolAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...otherPairs.flatMap((pair) => [
      { pubkey: pair.pool, isSigner: false, isWritable: false },
      { pubkey: pair.position, isSigner: false, isWritable: false },
    ]),
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}
