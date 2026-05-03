import { Connection, PublicKey } from "@solana/web3.js";
import { POOL_SIZE, POSITION_SIZE } from "./constants";

/** Mirrors the on-chain LendingPool struct (416 bytes, little-endian). */
export type LendingPool = {
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
  paused: boolean;            // [139]
  tokenDecimals: number;      // [140]
  // _pad [141..144]
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
  pythPriceFeed: PublicKey;   // [352..384]
  oraclePrice: bigint;        // [384..392] i64
  oracleConf: bigint;         // [392..400] u64
  oracleExpo: number;         // [400..404] i32
  // _oracle_pad [404..416]
};

/** Mirrors the on-chain UserPosition struct (144 bytes, little-endian). */
export type UserPosition = {
  discriminator: Uint8Array;       // [0..8]
  owner: PublicKey;                // [8..40]
  pool: PublicKey;                 // [40..72]
  depositShares: bigint;           // [72..80]
  borrowPrincipal: bigint;         // [80..88]
  crossSetId: bigint;              // [88..96]  u64 — registry id, 0 if not cross-linked
  depositIndexSnapshot: bigint;    // [96..112] u128
  borrowIndexSnapshot: bigint;     // [112..128] u128
  bump: number;                    // [128]
  crossCollateral: number;         // [129] u8 — non-zero when used as cross collateral
  crossCount: number;              // [130] u8 — total positions in this cross-set
  // _pad_end [131..144]
};

// Use DataView for browser + Node compatibility (Buffer.readBigUInt64LE is Node-only)
function toDataView(buf: Buffer | Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function readU64LE(buf: Buffer | Uint8Array, offset: number): bigint {
  return toDataView(buf).getBigUint64(offset, true);
}

function readI64LE(buf: Buffer | Uint8Array, offset: number): bigint {
  return toDataView(buf).getBigInt64(offset, true);
}

function readU128LE(buf: Buffer | Uint8Array, offset: number): bigint {
  const dv = toDataView(buf);
  const lo = dv.getBigUint64(offset, true);
  const hi = dv.getBigUint64(offset + 8, true);

  return (hi << 64n) | lo;
}

function readI32LE(buf: Buffer | Uint8Array, offset: number): number {
  return toDataView(buf).getInt32(offset, true);
}

export function decodeLendingPool(data: Buffer | Uint8Array): LendingPool {
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
    paused: data[139] !== 0,
    tokenDecimals: data[140],
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
    pythPriceFeed: new PublicKey(data.slice(352, 384)),
    oraclePrice: readI64LE(data, 384),
    oracleConf: readU64LE(data, 392),
    oracleExpo: readI32LE(data, 400),
  };
}

export function decodeUserPosition(data: Buffer | Uint8Array): UserPosition {
  if (data.length < POSITION_SIZE) {
    throw new Error(`Expected ${POSITION_SIZE} bytes, got ${data.length}`);
  }
  return {
    discriminator: data.slice(0, 8),
    owner: new PublicKey(data.slice(8, 40)),
    pool: new PublicKey(data.slice(40, 72)),
    depositShares: readU64LE(data, 72),
    borrowPrincipal: readU64LE(data, 80),
    crossSetId: readU64LE(data, 88),
    depositIndexSnapshot: readU128LE(data, 96),
    borrowIndexSnapshot: readU128LE(data, 112),
    bump: data[128],
    crossCollateral: data[129],
    crossCount: data[130],
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

/** Single-pool health factor (WAD-scaled). Returns WAD if no debt. */
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
  // hf = collateral * liqThreshold / debt (WAD-scaled)
  return (collateral * liquidationThreshold) / debt;
}

// ── Cross-collateral (Aave-style) health factor ────────────────────────────

/**
 * Convert a token amount to WAD-scaled USD.
 * Mirrors on-chain `token_to_usd_wad`:
 *   result = amount × |oraclePrice| × 10^(18 + oracleExpo - tokenDecimals)
 */
export function tokenToUsdWad(
  amount: bigint,
  oraclePrice: bigint,
  oracleExpo: number,
  tokenDecimals: number,
): bigint {
  if (amount === 0n || oraclePrice <= 0n) return 0n;
  const price = oraclePrice < 0n ? -oraclePrice : oraclePrice;
  const base = amount * price;
  const scaleExp = 18 + oracleExpo - tokenDecimals;
  if (scaleExp >= 0) {
    return base * 10n ** BigInt(scaleExp);
  }
  return base / 10n ** BigInt(-scaleExp);
}

/** Inputs for one pool+position pair in the cross-HF computation. */
export type CrossHFInput = {
  depositShares: bigint;
  borrowPrincipal: bigint;
  supplyIndex: bigint;
  borrowIndex: bigint;
  borrowIndexSnapshot: bigint;
  liquidationThreshold: bigint;
  oraclePrice: bigint;
  oracleExpo: number;
  tokenDecimals: number;
};

/**
 * Account-level health factor across all positions (Aave-style).
 *   HF = Σ(deposit_usd_i × liq_threshold_i) / Σ(debt_usd_j)
 * Returns WAD-scaled bigint, or WAD if no debt.
 */
export function accountHealthFactor(positions: CrossHFInput[]): bigint {
  let weightedCollateralUsd = 0n;
  let totalDebtUsd = 0n;

  for (const p of positions) {
    const depositTokens = sharesToTokens(p.depositShares, p.supplyIndex);
    const debtTokens = borrowDebt(p.borrowPrincipal, p.borrowIndex, p.borrowIndexSnapshot);

    const depositUsd = tokenToUsdWad(depositTokens, p.oraclePrice, p.oracleExpo, p.tokenDecimals);
    const debtUsd = tokenToUsdWad(debtTokens, p.oraclePrice, p.oracleExpo, p.tokenDecimals);

    // WAD-scale: depositUsd is already WAD-scaled, liq_threshold is WAD-scaled
    // wad_mul(a,b) = a * b / WAD
    weightedCollateralUsd += (depositUsd * p.liquidationThreshold) / WAD;
    totalDebtUsd += debtUsd;
  }

  if (totalDebtUsd === 0n) return WAD;
  // wad_div(a,b) = a * WAD / b
  return (weightedCollateralUsd * WAD) / totalDebtUsd;
}
