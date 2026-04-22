import { Connection, PublicKey } from "@solana/web3.js";
import { POOL_SIZE, POSITION_SIZE } from "./constants";

/** Mirrors the on-chain LendingPool struct (352 bytes, little-endian). */
export interface LendingPool {
  discriminator: Uint8Array; // [0..8]
  authority: PublicKey;       // [8..40]
  tokenMint: PublicKey;       // [40..72]
  vault: PublicKey;           // [72..104]
  totalDeposits: bigint;      // [104..112]
  totalBorrows: bigint;       // [112..120]
  accumulatedFees: bigint;    // [120..128]
  lastUpdateTimestamp: bigint;// [128..136]
  authorityBump: number;      // [136]
  poolBump: number;           // [137]
  vaultBump: number;          // [138]
  // _pad [139..144]
  borrowIndex: bigint;        // [144..160] u128
  supplyIndex: bigint;        // [160..176] u128
  baseRate: bigint;           // [176..192] u128
  optimalUtilization: bigint; // [192..208] u128
  slope1: bigint;             // [208..224] u128
  slope2: bigint;             // [224..240] u128
  reserveFactor: bigint;      // [240..256] u128
  ltv: bigint;                // [256..272] u128
  liquidationThreshold: bigint;// [272..288] u128
  liquidationBonus: bigint;   // [288..304] u128
  protocolLiqFee: bigint;     // [304..320] u128
  closeFactor: bigint;        // [320..336] u128
  flashLoanAmount: bigint;    // [336..344]
  flashFeeBps: bigint;        // [344..352]
}

/** Mirrors the on-chain UserPosition struct (144 bytes, little-endian). */
export interface UserPosition {
  discriminator: Uint8Array;       // [0..8]
  owner: PublicKey;                // [8..40]
  pool: PublicKey;                 // [40..72]
  depositShares: bigint;           // [72..80]
  borrowPrincipal: bigint;         // [80..88]
  // _pad0 [88..96]
  depositIndexSnapshot: bigint;    // [96..112] u128
  borrowIndexSnapshot: bigint;     // [112..128] u128
  bump: number;                    // [128]
  // _pad_end [129..144]
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function decodeLendingPool(data: Buffer): LendingPool {
  if (data.length < POOL_SIZE) {
    throw new Error(`Expected ${POOL_SIZE} bytes, got ${data.length}`);
  }
  return {
    discriminator: data.slice(0, 8),
    authority: new PublicKey(data.slice(8, 40)),
    tokenMint: new PublicKey(data.slice(40, 72)),
    vault: new PublicKey(data.slice(72, 104)),
    totalDeposits: readU64LE(data, 104),
    totalBorrows: readU64LE(data, 112),
    accumulatedFees: readU64LE(data, 120),
    lastUpdateTimestamp: readI64LE(data, 128),
    authorityBump: data[136],
    poolBump: data[137],
    vaultBump: data[138],
    borrowIndex: readU128LE(data, 144),
    supplyIndex: readU128LE(data, 160),
    baseRate: readU128LE(data, 176),
    optimalUtilization: readU128LE(data, 192),
    slope1: readU128LE(data, 208),
    slope2: readU128LE(data, 224),
    reserveFactor: readU128LE(data, 240),
    ltv: readU128LE(data, 256),
    liquidationThreshold: readU128LE(data, 272),
    liquidationBonus: readU128LE(data, 288),
    protocolLiqFee: readU128LE(data, 304),
    closeFactor: readU128LE(data, 320),
    flashLoanAmount: readU64LE(data, 336),
    flashFeeBps: readU64LE(data, 344),
  };
}

export function decodeUserPosition(data: Buffer): UserPosition {
  if (data.length < POSITION_SIZE) {
    throw new Error(`Expected ${POSITION_SIZE} bytes, got ${data.length}`);
  }
  return {
    discriminator: data.slice(0, 8),
    owner: new PublicKey(data.slice(8, 40)),
    pool: new PublicKey(data.slice(40, 72)),
    depositShares: readU64LE(data, 72),
    borrowPrincipal: readU64LE(data, 80),
    depositIndexSnapshot: readU128LE(data, 96),
    borrowIndexSnapshot: readU128LE(data, 112),
    bump: data[128],
  };
}

export async function fetchPool(
  connection: Connection,
  poolAddress: PublicKey
): Promise<LendingPool | null> {
  const info = await connection.getAccountInfo(poolAddress);
  if (!info) return null;
  return decodeLendingPool(Buffer.from(info.data));
}

export async function fetchPosition(
  connection: Connection,
  positionAddress: PublicKey
): Promise<UserPosition | null> {
  const info = await connection.getAccountInfo(positionAddress);
  if (!info) return null;
  return decodeUserPosition(Buffer.from(info.data));
}

const WAD = 1_000_000_000_000_000_000n;

/** Convert deposit shares → token amount using current supply index. */
export function sharesToTokens(shares: bigint, supplyIndex: bigint): bigint {
  return (shares * supplyIndex) / WAD;
}

/** Current borrow debt in tokens. */
export function borrowDebt(
  principal: bigint,
  currentBorrowIndex: bigint,
  snapshotIndex: bigint
): bigint {
  if (snapshotIndex === 0n) return 0n;
  return (principal * currentBorrowIndex) / snapshotIndex;
}

/** Health factor as a WAD-scaled u128. Returns WAD if no debt. */
export function healthFactor(
  depositShares: bigint,
  supplyIndex: bigint,
  borrowPrincipal: bigint,
  currentBorrowIndex: bigint,
  snapshotIndex: bigint,
  liquidationThreshold: bigint
): bigint {
  const collateral = sharesToTokens(depositShares, supplyIndex);
  const debt = borrowDebt(borrowPrincipal, currentBorrowIndex, snapshotIndex);
  if (debt === 0n) return WAD;
  // hf = collateral * liqThreshold / debt  (WAD-scaled)
  return (collateral * liquidationThreshold) / debt;
}
