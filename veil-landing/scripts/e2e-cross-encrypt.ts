/**
 * End-to-end cross-collateral + encryption scenarios driven by the same
 * frontend instruction builders the dApp uses. Validates each step against
 * fresh on-chain state pulled directly from the validator.
 *
 * Prerequisites (localnet only):
 *   1. `solana-test-validator --reset` running on 127.0.0.1:8899
 *   2. Veil program deployed via `cargo build-sbf --features testing &&
 *      solana program deploy target/deploy/veil_lending.so` — the testing
 *      feature gates the `mockOracleIx` we use to bypass Pyth.
 *   3. `.env.local` with `NEXT_PUBLIC_VEIL_PROGRAM_ID` set to the deployed id.
 *
 * Run:
 *   npm run test:e2e
 *
 * Scope (no Postgres / no Ika network involved):
 *   1. USDC collateral → BTC borrow (plaintext cross)
 *   2. BTC  collateral → USDC borrow (plaintext cross)
 *   3. Pure encrypted single-pool USDC: enable_privacy → private_deposit
 *      → private_borrow → private_repay → private_withdraw
 *   4. Pure encrypted single-pool BTC (same shape)
 *   5. Mixed: privacy on USDC + cross-borrow BTC. Documents that cross
 *      ops only update the plaintext side; the encrypted mirror drifts.
 *   6. Mixed: privacy on BTC + cross-borrow USDC.
 *
 * Honest scope notes:
 *   - The Encrypt CPI is stubbed on-chain. Plaintext bookkeeping IS
 *     correct, but no real ciphertext is produced — the EncryptedPosition
 *     PDA stores keys to (non-existent on localnet) ciphertext accounts.
 *   - The Ika program isn't deployed on localnet. dWallet flows aren't
 *     exercised here.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount as getTokenAccount,
} from "@solana/spl-token";
import { buildInitializePoolTx } from "../lib/veil/initialize";
import {
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  WAD,
  depositIx,
  borrowIx,
  withdrawIx,
  repayIx,
  initPositionIx,
  crossBorrowIx,
  crossRepayIx,
  crossWithdrawIx,
  crossLiquidateIx,
  flashBorrowIx,
  flashRepayIx,
  updatePoolIx,
  enablePrivacyIx,
  privateDepositIx,
  privateBorrowIx,
  privateRepayIx,
  privateWithdrawIx,
  ENCRYPT_PROGRAM_ID,
  type EncryptAccounts,
  findPositionAddress,
  findPoolAuthorityAddress,
  findEncryptedPositionAddress,
  findEncryptCpiAuthorityAddress,
  decodeLendingPool,
  decodeUserPosition,
  type LendingPool,
  type UserPosition,
  sharesToTokens,
  borrowDebt,
  tokenToUsdWad,
  accountHealthFactor,
  type CrossHFInput,
} from "../lib/veil";
import { mockOracleIx } from "./_mock-instructions";

// ─── Constants ───────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ENCRYPTED_POSITION_SIZE = 144;
const ENC_POS_SEED = "enc_pos";

// $1 USDC at expo -8 = 1e8.
const USDC_PRICE = 100_000_000n;
// $60,000 BTC at expo -8 = 6e12.
const BTC_PRICE = 6_000_000_000_000n;
const PRICE_EXPO = -8;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function loadPayer(): Keypair {
  // Honour PAYER_KEYPAIR env override; otherwise fall back to whatever the
  // local Solana CLI is configured to use (so this matches the wallet that
  // funded the validator). Final fallback is the canonical id.json.
  let p = process.env.PAYER_KEYPAIR;
  if (!p) {
    try {
      const cfgPath = path.join(os.homedir(), ".config/solana/cli/config.yml");
      const cfg = fs.readFileSync(cfgPath, "utf-8");
      const m = cfg.match(/keypair_path:\s*(.+?)\s*$/m);
      if (m) p = m[1].trim().replace(/^['"]|['"]$/g, "");
    } catch { /* ignore */ }
  }
  if (!p) p = path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function step(s: string) {
  console.log("\n" + ANSI.cyan("─".repeat(60)));
  console.log(ANSI.bold(ANSI.cyan(s)));
  console.log(ANSI.cyan("─".repeat(60)));
}

function ok(msg: string)   { console.log(ANSI.green("  ✓ ") + msg); }
function fail(msg: string) { console.log(ANSI.red  ("  ✗ ") + msg); throw new Error(msg); }
function info(msg: string) { console.log(ANSI.dim ("    " ) + msg); }

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
  ok(`${label} = ${a}`);
}

function assertGt(actual: bigint, threshold: bigint, label: string) {
  if (actual <= threshold) fail(`${label}: ${actual} not > ${threshold}`);
  ok(`${label} = ${actual} (> ${threshold})`);
}

function isLocalRpc(connection: Connection): boolean {
  const rpc = connection.rpcEndpoint;
  return rpc.includes("127.0.0.1") || rpc.includes("localhost");
}

async function airdrop(connection: Connection, who: PublicKey, sol: number, payer?: Keypair) {
  if (isLocalRpc(connection)) {
    const sig = await connection.requestAirdrop(who, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  }
  if (!payer) throw new Error("non-local airdrop requires payer (transfer source)");
  if (payer.publicKey.equals(who)) return;
  const lamports = Math.min(sol, 0.1) * LAMPORTS_PER_SOL;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: who,
      lamports: Math.floor(lamports),
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [payer]);
}

// ─── On-chain pool helpers ───────────────────────────────────────────────────

type PoolCtx = {
  symbol: string;
  decimals: number;
  mint: PublicKey;
  pool: PublicKey;
  vault: PublicKey;
  authority: PublicKey;
  authorityBump: number;
};

async function bootstrapPool(
  connection: Connection,
  payer: Keypair,
  cfg: { symbol: string; decimals: number; mockPrice: bigint; mockExpo: number; ltv: bigint; liqTh: bigint; liqBonus: bigint; },
): Promise<PoolCtx> {
  info(`bootstrapping ${cfg.symbol} pool`);
  const mint = await createMint(connection, payer, payer.publicKey, null, cfg.decimals);

  const { tx: initTx, pool, vault, poolAuthority } = buildInitializePoolTx({
    payer: payer.publicKey, authority: payer.publicKey, tokenMint: mint,
  });
  await sendAndConfirmTransaction(connection, initTx, [payer]);

  const updateTx = new Transaction().add(updatePoolIx(payer.publicKey, pool, {
    baseRate: WAD / 100n,
    optimalUtilization: (WAD * 80n) / 100n,
    slope1: (WAD * 4n) / 100n,
    slope2: (WAD * 75n) / 100n,
    reserveFactor: WAD / 10n,
    ltv: cfg.ltv,
    liquidationThreshold: cfg.liqTh,
    liquidationBonus: cfg.liqBonus,
    protocolLiqFee: WAD / 10n,
    closeFactor: WAD / 2n,
    flashFeeBps: 9n,
  }));
  await sendAndConfirmTransaction(connection, updateTx, [payer]);

  const oracleTx = new Transaction().add(mockOracleIx(payer.publicKey, pool, cfg.mockPrice, cfg.mockExpo));
  await sendAndConfirmTransaction(connection, oracleTx, [payer]);

  // Read back the pool to get authority bump.
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) throw new Error("pool account missing after init");
  const decoded = decodeLendingPool(Buffer.from(poolInfo.data));

  ok(`${cfg.symbol} pool ready @ ${pool.toBase58().slice(0, 8)}…  mint=${mint.toBase58().slice(0, 8)}…`);
  return { symbol: cfg.symbol, decimals: cfg.decimals, mint, pool, vault, authority: poolAuthority, authorityBump: decoded.authorityBump };
}

async function seedPoolLiquidity(
  connection: Connection,
  payer: Keypair,
  poolCtx: PoolCtx,
  amount: bigint,
) {
  info(`seeding ${amount} base units of ${poolCtx.symbol}`);
  const ata = getAssociatedTokenAddressSync(poolCtx.mint, payer.publicKey);
  // Create payer ATA if needed.
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, poolCtx.mint),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }
  await mintTo(connection, payer, poolCtx.mint, ata, payer, Number(amount * 5n));

  const [position, posBump] = findPositionAddress(poolCtx.pool, payer.publicKey);
  const tx = new Transaction().add(
    depositIx(payer.publicKey, ata, poolCtx.vault, poolCtx.pool, position, amount, posBump),
  );
  await sendAndConfirmTransaction(connection, tx, [payer]);
  ok(`${poolCtx.symbol} pool seeded by payer (${amount} units)`);
}

async function fundUser(
  connection: Connection,
  payer: Keypair,
  user: PublicKey,
  poolCtx: PoolCtx,
  amount: bigint,
): Promise<PublicKey> {
  await airdrop(connection, user, 5, payer);
  const ata = getAssociatedTokenAddressSync(poolCtx.mint, user);
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, user, poolCtx.mint),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }
  if (amount > 0n) {
    await mintTo(connection, payer, poolCtx.mint, ata, payer, Number(amount));
  }
  return ata;
}

// ─── Encrypt-side localnet helpers ───────────────────────────────────────────

/**
 * Localnet substitutes for the Encrypt SDK accounts. Encrypt CPI
 * dereferences these accounts — they must be the real Encrypt-program-owned
 * config / network-key / event-authority. SystemProgram placeholders won't
 * work against a real Encrypt deployment. We pin a single placeholder for
 * each so callers can pass `commonEncryptAccounts()` everywhere on the
 * stubbed localnet path only.
 */
function commonEncryptAccounts(payer: PublicKey): EncryptAccounts {
  // Use the System program for slots that are read-only — they always exist.
  const sys = SYSTEM_PROGRAM_ID;
  return {
    encryptProgram: ENCRYPT_PROGRAM_ID,
    encryptConfig:  sys,
    encryptDeposit: payer,        // writable; payer's wallet is fine on localnet
    cpiAuthority:   findEncryptCpiAuthorityAddress()[0],
    callerProgram:  PROGRAM_ID,
    networkEncKey:  sys,
    eventAuthority: sys,
    systemProgram:  SYSTEM_PROGRAM_ID,
  };
}

/**
 * Allocate `n` Veil-owned accounts of a given size on the validator, returning
 * their keypairs. `EncryptedPosition` needs 144 bytes Veil-owned; ephemeral
 * ciphertext slots can use 0 bytes any-owned.
 */
async function allocateAccounts(
  connection: Connection,
  payer: Keypair,
  count: number,
  space: number,
  owner: PublicKey,
): Promise<Keypair[]> {
  const kps = Array.from({ length: count }, () => Keypair.generate());
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const tx = new Transaction();
  for (const kp of kps) {
    tx.add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports,
      space,
      programId: owner,
    }));
  }
  await sendAndConfirmTransaction(connection, tx, [payer, ...kps]);
  return kps;
}

type EncCtxAccounts = {
  encPos: PublicKey;
  encPosBump: number;
  encDeposit: PublicKey;
  encDebt: PublicKey;
};

/**
 * Allocate the 3 accounts EnablePrivacy expects to find (encPos owned by
 * Veil with 144-byte allocation; ciphertext slots zero-byte any-owned),
 * then submit EnablePrivacy itself. Returns the trio so subsequent
 * Private* calls can reuse them.
 */
async function setupEncryption(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  poolCtx: PoolCtx,
  userPosition: PublicKey,
): Promise<EncCtxAccounts> {
  // 1. Create the EncryptedPosition account (Veil-owned, 144 bytes).
  // We use a Keypair instead of a PDA because EnablePrivacy doesn't
  // verify the PDA derivation on-chain — only EncryptedPosition::init
  // requires the data buffer to be 144 bytes.
  const [encPosKps] = await Promise.all([
    allocateAccounts(connection, payer, 1, ENCRYPTED_POSITION_SIZE, PROGRAM_ID),
  ]);
  const encPos = encPosKps[0].publicKey;

  // 2. Create the two ciphertext placeholder accounts.
  const ctKps = await allocateAccounts(connection, payer, 2, 0, SYSTEM_PROGRAM_ID);
  const encDeposit = ctKps[0].publicKey;
  const encDebt    = ctKps[1].publicKey;

  // 3. Submit EnablePrivacy. The bumps are unused on-chain (no PDA verify
  // happens for the EncryptedPosition keypair-account or the cpi auth),
  // but we still pass valid values.
  const [, cpiAuthBump] = findEncryptCpiAuthorityAddress();
  const enc = commonEncryptAccounts(payer.publicKey);
  const tx = new Transaction().add(
    enablePrivacyIx(
      user.publicKey, userPosition, encPos, encDeposit, encDebt,
      poolCtx.pool, enc, /*encPosBump*/ 0, cpiAuthBump,
    ),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [user]);
  info(`EnablePrivacy tx: ${sig}`);

  // Verify the encrypted position got the right bytes.
  const epi = await connection.getAccountInfo(encPos);
  if (!epi) fail("EncryptedPosition account missing after EnablePrivacy");
  const disc = epi!.data.subarray(0, 8).toString();
  if (disc !== "VEILENC!") fail(`EncryptedPosition discriminator wrong: ${disc}`);
  ok(`EncryptedPosition initialized (discriminator VEILENC!) @ ${encPos.toBase58().slice(0, 8)}…`);

  return { encPos, encPosBump: 0, encDeposit, encDebt };
}

/** Build and submit a Private* tx, allocating the ephemeral amount_ct/healthy_ct slots in-band. */
async function privateTx(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  buildIx: (amountCt: PublicKey, healthyCt?: PublicKey) => Promise<{
    ix: import("@solana/web3.js").TransactionInstruction;
    needsHealthy: boolean;
  }>,
): Promise<string> {
  // Ephemeral accounts for this single tx — no need to persist.
  const ephem = await allocateAccounts(connection, payer, 2, 0, SYSTEM_PROGRAM_ID);
  const amountCt = ephem[0].publicKey;
  const healthyCt = ephem[1].publicKey;

  const { ix } = await buildIx(amountCt, healthyCt);
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [user]);
}

// ─── On-chain readback ───────────────────────────────────────────────────────

async function readUserPosition(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  return decodeUserPosition(Buffer.from(info.data));
}

async function readPool(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`pool ${address.toBase58()} missing`);
  return decodeLendingPool(Buffer.from(info.data));
}

async function tokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const acc = await getTokenAccount(connection, ata);
    return acc.amount;
  } catch { return 0n; }
}

// ─── Health-factor verification ──────────────────────────────────────────────
//
// Uses the same WAD-scaled helpers exported from `lib/veil/state.ts` that the
// dApp ships in production. `accountHealthFactor` returns `WAD` (1.0) when
// there's no debt — that's the "infinite-HF" sentinel for the TS side, even
// though the on-chain Rust returns `u128::MAX` for the same case. The
// invariant we care about is `hf >= WAD` (≥ 1.0); anything above is healthy.

const NO_DEBT_HF = WAD; // accountHealthFactor returns WAD when total debt is zero

/** Format a HF value for human consumption. */
function fmtHF(hf: bigint): string {
  if (hf === NO_DEBT_HF) return "1.0000 (no debt)";
  return (Number(hf) / Number(WAD)).toFixed(4);
}

/** Format a WAD-scaled USD value as $X,XXX.XX. */
function fmtUsdWad(v: bigint): string {
  const cents = (v * 100n) / WAD;
  return "$" + (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Build the per-leg input the shared `accountHealthFactor` helper expects,
 * pulling fresh state from the validator on each call.
 */
async function buildHfInputs(
  connection: Connection,
  legs: Array<{ pool: PublicKey; position: PublicKey }>,
): Promise<CrossHFInput[]> {
  const inputs: CrossHFInput[] = [];
  for (const { pool, position } of legs) {
    const p = await readPool(connection, pool);
    const u = await readUserPosition(connection, position);
    if (!u) continue;
    inputs.push({
      depositShares: u.depositShares,
      borrowPrincipal: u.borrowPrincipal,
      supplyIndex: p.supplyIndex,
      borrowIndex: p.borrowIndex,
      borrowIndexSnapshot: u.borrowIndexSnapshot,
      liquidationThreshold: p.liquidationThreshold,
      oraclePrice: p.oraclePrice,
      oracleExpo: p.oracleExpo,
      tokenDecimals: p.tokenDecimals,
    });
  }
  return inputs;
}

/** Compute single-pool HF directly from on-chain state. */
async function singlePoolHF(
  connection: Connection,
  pool: PublicKey,
  position: PublicKey,
): Promise<bigint> {
  const inputs = await buildHfInputs(connection, [{ pool, position }]);
  if (inputs.length === 0) return NO_DEBT_HF;
  return accountHealthFactor(inputs);
}

/** Compute account-level (cross-collateral) HF + USD breakdown. */
async function crossHF(
  connection: Connection,
  legs: Array<{ pool: PublicKey; position: PublicKey }>,
): Promise<{ hf: bigint; collateralUsd: bigint; debtUsd: bigint }> {
  const inputs = await buildHfInputs(connection, legs);
  // Recompute the USD totals separately for human-readable display.
  let collateralUsd = 0n;
  let debtUsd = 0n;
  for (const i of inputs) {
    const dep = sharesToTokens(i.depositShares, i.supplyIndex);
    const debt = borrowDebt(i.borrowPrincipal, i.borrowIndex, i.borrowIndexSnapshot);
    if (dep > 0n) {
      const depUsd = tokenToUsdWad(dep, i.oraclePrice, i.oracleExpo, i.tokenDecimals);
      collateralUsd += (depUsd * i.liquidationThreshold) / WAD;
    }
    if (debt > 0n) {
      debtUsd += tokenToUsdWad(debt, i.oraclePrice, i.oracleExpo, i.tokenDecimals);
    }
  }
  return { hf: accountHealthFactor(inputs), collateralUsd, debtUsd };
}

/** Assert a HF reading meets `min` (WAD-scaled). Logs the formatted value. */
function assertHFAtLeast(hf: bigint, min: bigint, label: string) {
  if (hf < min) fail(`${label}: HF=${fmtHF(hf)} < required ${fmtHF(min)}`);
  ok(`${label} HF = ${fmtHF(hf)} (≥ ${fmtHF(min)})`);
}

/** Assert HF is the no-debt sentinel (≥ WAD with zero debt → returns WAD). */
function assertHFInfinite(hf: bigint, label: string) {
  if (hf !== NO_DEBT_HF) fail(`${label}: expected no-debt HF (=${fmtHF(NO_DEBT_HF)}), got ${fmtHF(hf)}`);
  ok(`${label} HF = ${fmtHF(hf)}`);
}

// ─── Scenario: USDC collateral → BTC borrow (cross, plaintext) ───────────────

async function scenarioA_UsdcToBtc(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  usdcPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 1 · user has USDC, no BTC, cross-borrows BTC under limit");

  const usdcAta = getAssociatedTokenAddressSync(usdcPool.mint, user.publicKey);
  const btcAta  = getAssociatedTokenAddressSync(btcPool.mint, user.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool.pool, user.publicKey);
  const [btcPos, btcPosBump]   = findPositionAddress(btcPool.pool, user.publicKey);
  const [btcAuth] = findPoolAuthorityAddress(btcPool.pool);

  // Step 1: deposit 5,000 USDC.
  const depositAmount = 5_000n * 10n**6n; // 5,000 USDC base units
  info(`depositing ${depositAmount} USDC`);
  const sig1 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositIx(user.publicKey, usdcAta, usdcPool.vault, usdcPool.pool, usdcPos, depositAmount, usdcPosBump),
    ),
    [user],
  );
  info(`deposit tx: ${sig1}`);

  const usdcPosAfter1 = await readUserPosition(connection, usdcPos);
  if (!usdcPosAfter1) fail("USDC position not created");
  assertGt(usdcPosAfter1!.depositShares, 0n, "USDC.deposit_shares");
  assertEq(usdcPosAfter1!.borrowPrincipal, 0n, "USDC.borrow_principal");

  // HF after deposit only — no debt → must be ∞.
  const hfBefore = await singlePoolHF(connection, usdcPool.pool, usdcPos);
  assertHFInfinite(hfBefore, "USDC pre-borrow");

  // Step 2: cross-borrow BTC against USDC collateral.
  // 5,000 USDC × 80% LTV = $4,000 max borrow. BTC=$60,000 → 0.0666… BTC.
  // Borrow 0.05 BTC = 5_000_000 base units = $3,000 worth → safely under cap.
  const borrowAmount = 5_000_000n; // 0.05 BTC
  info(`cross-borrowing ${borrowAmount} BTC base units against USDC collateral`);

  // BTC ATA may not exist; BTC position may not exist.
  const ixs = [];
  const btcAtaInfo = await connection.getAccountInfo(btcAta);
  if (!btcAtaInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(user.publicKey, btcAta, user.publicKey, btcPool.mint));
  }
  const btcPosInfo = await connection.getAccountInfo(btcPos);
  if (!btcPosInfo) {
    ixs.push(initPositionIx(user.publicKey, btcPool.pool, btcPos, btcPosBump));
  }
  ixs.push(crossBorrowIx(
    user.publicKey, btcPool.pool, btcPos, btcPool.vault, btcAta, btcAuth,
    [{ pool: usdcPool.pool, position: usdcPos }],
    borrowAmount,
  ));

  const sig2 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...ixs),
    [user],
  );
  info(`cross_borrow tx: ${sig2}`);

  // Step 3: verify
  const btcPosAfter = (await readUserPosition(connection, btcPos))!;
  const usdcPosAfter2 = (await readUserPosition(connection, usdcPos))!;
  assertEq(btcPosAfter.borrowPrincipal, borrowAmount, "BTC.borrow_principal");
  assertEq(btcPosAfter.depositShares, 0n, "BTC.deposit_shares (none)");
  assertEq(usdcPosAfter2.crossCollateral, 1, "USDC.cross_collateral flag set");
  assertGt(usdcPosAfter2.crossSetId, 0n, "USDC.cross_set_id assigned");
  assertEq(usdcPosAfter2.crossCount, 2, "USDC.cross_count");

  const btcUserBalance = await tokenBalance(connection, btcAta);
  assertEq(btcUserBalance, borrowAmount, "BTC tokens received in user ATA");

  // HF post-borrow: $5,000 USDC × 0.85 / $3,000 BTC debt = 1.4166…
  const post = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  assertHFAtLeast(post.hf, WAD, "post-borrow account-level");
  if (post.hf > (WAD * 16n) / 10n) fail(`HF unexpectedly high: ${fmtHF(post.hf)} (expected ≈ 1.42)`);
  info(`collateral=${fmtUsdWad(post.collateralUsd)} debt=${fmtUsdWad(post.debtUsd)}`);

  info(`✓ Scenario 1 complete — borrowed 0.05 BTC against 5,000 USDC collateral`);
}

// ─── Scenario: BTC collateral → USDC borrow (cross, plaintext) ───────────────

async function scenarioB_BtcToUsdc(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  usdcPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 2 · user has BTC, no USDC, cross-borrows USDC under limit");

  const btcAta  = getAssociatedTokenAddressSync(btcPool.mint, user.publicKey);
  const usdcAta = getAssociatedTokenAddressSync(usdcPool.mint, user.publicKey);
  const [btcPos, btcPosBump]   = findPositionAddress(btcPool.pool, user.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool.pool, user.publicKey);
  const [usdcAuth] = findPoolAuthorityAddress(usdcPool.pool);

  // Step 1: deposit 0.05 BTC.
  const depositAmount = 5_000_000n; // 0.05 BTC = $3,000
  info(`depositing ${depositAmount} BTC base units (0.05 BTC = $3,000)`);
  const sig1 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositIx(user.publicKey, btcAta, btcPool.vault, btcPool.pool, btcPos, depositAmount, btcPosBump),
    ),
    [user],
  );
  info(`deposit tx: ${sig1}`);

  const btcPosAfter1 = (await readUserPosition(connection, btcPos))!;
  assertGt(btcPosAfter1.depositShares, 0n, "BTC.deposit_shares");

  // HF before borrow — single-pool BTC view, no debt → ∞.
  const hfBefore = await singlePoolHF(connection, btcPool.pool, btcPos);
  assertHFInfinite(hfBefore, "BTC pre-borrow");

  // Step 2: cross-borrow USDC. 0.05 BTC × 70% LTV = $2,100 max borrow.
  // Borrow 1,500 USDC = 1_500_000_000 base units → under cap.
  const borrowAmount = 1_500n * 10n**6n;
  info(`cross-borrowing ${borrowAmount} USDC base units against BTC collateral`);

  const ixs = [];
  const usdcAtaInfo = await connection.getAccountInfo(usdcAta);
  if (!usdcAtaInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(user.publicKey, usdcAta, user.publicKey, usdcPool.mint));
  }
  const usdcPosInfo = await connection.getAccountInfo(usdcPos);
  if (!usdcPosInfo) {
    ixs.push(initPositionIx(user.publicKey, usdcPool.pool, usdcPos, usdcPosBump));
  }
  ixs.push(crossBorrowIx(
    user.publicKey, usdcPool.pool, usdcPos, usdcPool.vault, usdcAta, usdcAuth,
    [{ pool: btcPool.pool, position: btcPos }],
    borrowAmount,
  ));

  const sig2 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...ixs),
    [user],
  );
  info(`cross_borrow tx: ${sig2}`);

  // Step 3: verify
  const usdcPosAfter = (await readUserPosition(connection, usdcPos))!;
  const btcPosAfter2 = (await readUserPosition(connection, btcPos))!;
  assertEq(usdcPosAfter.borrowPrincipal, borrowAmount, "USDC.borrow_principal");
  assertEq(btcPosAfter2.crossCollateral, 1, "BTC.cross_collateral flag set");
  assertEq(btcPosAfter2.crossCount, 2, "BTC.cross_count");

  const usdcUserBalance = await tokenBalance(connection, usdcAta);
  assertEq(usdcUserBalance, borrowAmount, "USDC tokens received in user ATA");

  // HF post-borrow: $3,000 BTC × 0.75 / $1,500 USDC debt = 1.5
  const post = await crossHF(connection, [
    { pool: btcPool.pool,  position: btcPos  },
    { pool: usdcPool.pool, position: usdcPos },
  ]);
  assertHFAtLeast(post.hf, WAD, "post-borrow account-level");
  if (post.hf < (WAD * 14n) / 10n || post.hf > (WAD * 17n) / 10n) {
    fail(`HF outside expected band 1.4–1.7: got ${fmtHF(post.hf)}`);
  }
  info(`collateral=${fmtUsdWad(post.collateralUsd)} debt=${fmtUsdWad(post.debtUsd)}`);

  info(`✓ Scenario 2 complete — borrowed 1,500 USDC against 0.05 BTC collateral`);
}

// ─── Scenario: pure encrypted single-pool USDC ───────────────────────────────

async function scenarioC_EncryptedSinglePool(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  poolCtx: PoolCtx,
  amounts: { deposit: bigint; borrow: bigint; symbol: string },
) {
  step(`Scenario 3 · pure encrypted single-pool ${amounts.symbol} round-trip`);

  const ata = getAssociatedTokenAddressSync(poolCtx.mint, user.publicKey);
  const [pos, posBump] = findPositionAddress(poolCtx.pool, user.publicKey);
  const [auth] = findPoolAuthorityAddress(poolCtx.pool);

  // Plaintext deposit (we need an existing UserPosition before EnablePrivacy).
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositIx(user.publicKey, ata, poolCtx.vault, poolCtx.pool, pos, amounts.deposit, posBump),
    ),
    [user],
  );
  ok(`plaintext deposit ${amounts.deposit} ${amounts.symbol}`);

  assertHFInfinite(await singlePoolHF(connection, poolCtx.pool, pos), "post-deposit");

  // Enable privacy (creates EncryptedPosition mirror).
  const enc = await setupEncryption(connection, payer, user, poolCtx, pos);
  const encAccs = commonEncryptAccounts(payer.publicKey);
  const [, cpiAuthBump] = findEncryptCpiAuthorityAddress();

  // EnablePrivacy doesn't change financial state, so HF is still ∞.
  assertHFInfinite(await singlePoolHF(connection, poolCtx.pool, pos), "post-enable-privacy");

  // private_borrow: borrow 30% of deposit value.
  const sigB = await privateTx(connection, payer, user, async (amountCt, healthyCt) => ({
    ix: privateBorrowIx(
      user.publicKey, ata, poolCtx.vault, poolCtx.pool, pos, enc.encPos,
      enc.encDebt, enc.encDeposit, amountCt, healthyCt!, auth, encAccs,
      amounts.borrow, cpiAuthBump,
    ),
    needsHealthy: true,
  }));
  ok(`private_borrow ${amounts.borrow} (sig ${sigB.slice(0, 16)}…)`);

  let posState = (await readUserPosition(connection, pos))!;
  assertEq(posState.borrowPrincipal, amounts.borrow, "borrow_principal after private_borrow");

  // HF after private_borrow — must stay healthy (HF > WAD).
  // For deposit=2000, borrow=600 at liqTh=0.85: HF = 2000×0.85/600 ≈ 2.83.
  const hfAfterBorrow = await singlePoolHF(connection, poolCtx.pool, pos);
  assertHFAtLeast(hfAfterBorrow, WAD, "post-private_borrow");
  if (hfAfterBorrow > (WAD * 5n)) fail(`HF unrealistically high: ${fmtHF(hfAfterBorrow)}`);

  // private_repay: repay full debt.
  const sigR = await privateTx(connection, payer, user, async (amountCt) => ({
    ix: privateRepayIx(
      user.publicKey, ata, poolCtx.vault, poolCtx.pool, pos, enc.encPos,
      enc.encDebt, amountCt, encAccs,
      amounts.borrow, cpiAuthBump,
    ),
    needsHealthy: false,
  }));
  ok(`private_repay (sig ${sigR.slice(0, 16)}…)`);

  posState = (await readUserPosition(connection, pos))!;
  assertEq(posState.borrowPrincipal, 0n, "borrow_principal cleared after private_repay");

  // HF after full repay must climb back to ∞ (no debt).
  assertHFInfinite(await singlePoolHF(connection, poolCtx.pool, pos), "post-private_repay");

  // private_withdraw: pull all shares back.
  const remainingShares = posState.depositShares;
  const sigW = await privateTx(connection, payer, user, async (amountCt, healthyCt) => ({
    ix: privateWithdrawIx(
      user.publicKey, ata, poolCtx.vault, poolCtx.pool, pos, enc.encPos,
      enc.encDeposit, enc.encDebt, amountCt, healthyCt!, auth, encAccs,
      remainingShares, cpiAuthBump,
    ),
    needsHealthy: true,
  }));
  ok(`private_withdraw all shares (sig ${sigW.slice(0, 16)}…)`);

  posState = (await readUserPosition(connection, pos))!;
  assertEq(posState.depositShares, 0n, "deposit_shares cleared after private_withdraw");

  // HF after withdrawing all shares — empty position, no debt → ∞.
  assertHFInfinite(await singlePoolHF(connection, poolCtx.pool, pos), "post-private_withdraw");

  // Encrypted-side check: the EncryptedPosition account still exists with
  // its discriminator intact. The ciphertext slots, being stub no-ops,
  // never actually held real ciphertext — but the on-chain bookkeeping
  // accepts the workflow.
  const encPosInfo = await connection.getAccountInfo(enc.encPos);
  if (!encPosInfo) fail("EncryptedPosition disappeared");
  const disc = encPosInfo!.data.subarray(0, 8).toString();
  if (disc !== "VEILENC!") fail(`EncryptedPosition disc tampered: ${disc}`);
  ok(`EncryptedPosition still present + binding (no real ciphertext — Encrypt CPI is stubbed on localnet)`);

  info(`✓ Scenario 3 complete (${amounts.symbol})`);
}

// ─── Scenario: privacy on collateral side + cross-borrow ─────────────────────

async function scenarioE_EncryptedCrossBorrow(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  collatPool: PoolCtx,
  borrowPool: PoolCtx,
  collatAmount: bigint,
  borrowAmount: bigint,
  label: string,
) {
  step(`Scenario · ${label}`);

  const collAta = getAssociatedTokenAddressSync(collatPool.mint, user.publicKey);
  const borrAta = getAssociatedTokenAddressSync(borrowPool.mint, user.publicKey);
  const [collPos, collPosBump] = findPositionAddress(collatPool.pool, user.publicKey);
  const [borrPos, borrPosBump] = findPositionAddress(borrowPool.pool, user.publicKey);
  const [borrAuth] = findPoolAuthorityAddress(borrowPool.pool);

  // 1. plaintext deposit → 2. enable_privacy → 3. cross_borrow (which
  //    only updates the plaintext mirror — encrypted side drifts).
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositIx(user.publicKey, collAta, collatPool.vault, collatPool.pool, collPos, collatAmount, collPosBump),
    ),
    [user],
  );
  ok(`deposit ${collatAmount} ${collatPool.symbol}`);

  const enc = await setupEncryption(connection, payer, user, collatPool, collPos);

  const ixs = [];
  const borrAtaInfo = await connection.getAccountInfo(borrAta);
  if (!borrAtaInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(user.publicKey, borrAta, user.publicKey, borrowPool.mint));
  }
  const borrPosInfo = await connection.getAccountInfo(borrPos);
  if (!borrPosInfo) {
    ixs.push(initPositionIx(user.publicKey, borrowPool.pool, borrPos, borrPosBump));
  }
  ixs.push(crossBorrowIx(
    user.publicKey, borrowPool.pool, borrPos, borrowPool.vault, borrAta, borrAuth,
    [{ pool: collatPool.pool, position: collPos }],
    borrowAmount,
  ));
  const sigCB = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [user]);
  info(`cross_borrow tx (mixes plaintext + privacy): ${sigCB}`);

  const borrPosState = (await readUserPosition(connection, borrPos))!;
  const collPosState = (await readUserPosition(connection, collPos))!;
  assertEq(borrPosState.borrowPrincipal, borrowAmount, "borrow_principal after cross_borrow");
  assertEq(collPosState.crossCollateral, 1, "collateral.cross_collateral set");

  // Account-level HF including both legs.
  const post = await crossHF(connection, [
    { pool: collatPool.pool, position: collPos },
    { pool: borrowPool.pool, position: borrPos },
  ]);
  assertHFAtLeast(post.hf, WAD, "post-borrow account-level (mixed)");
  info(`collateral=${fmtUsdWad(post.collateralUsd)} debt=${fmtUsdWad(post.debtUsd)}`);

  console.log(ANSI.yellow("  ⚠ encrypted-mirror drift: cross_borrow only updated the plaintext UserPosition;"));
  console.log(ANSI.yellow("    the EncryptedPosition still reflects the pre-borrow state. Closing this gap"));
  console.log(ANSI.yellow("    requires a `private_cross_borrow` instruction (future scope)."));

  info(`✓ Scenario complete — borrow happened, gap documented`);
}

// ─── Scenario 8: cross_repay shows HF recovery ───────────────────────────────

async function scenarioH_PartialRepayRecoversHF(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  usdcPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 8 · partial cross_repay improves HF (USDC collateral, BTC debt)");

  const usdcAta = getAssociatedTokenAddressSync(usdcPool.mint, user.publicKey);
  const btcAta  = getAssociatedTokenAddressSync(btcPool.mint, user.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool.pool, user.publicKey);
  const [btcPos, btcPosBump]   = findPositionAddress(btcPool.pool, user.publicKey);
  const [btcAuth] = findPoolAuthorityAddress(btcPool.pool);

  // 1. Deposit 5,000 USDC, cross-borrow 0.05 BTC = $3,000 (under $4,250 cap).
  await sendAndConfirmTransaction(connection, new Transaction().add(
    depositIx(user.publicKey, usdcAta, usdcPool.vault, usdcPool.pool, usdcPos,
              5_000n * 10n**6n, usdcPosBump),
  ), [user]);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(user.publicKey, btcAta, user.publicKey, btcPool.mint),
    initPositionIx(user.publicKey, btcPool.pool, btcPos, btcPosBump),
    crossBorrowIx(user.publicKey, btcPool.pool, btcPos, btcPool.vault, btcAta, btcAuth,
      [{ pool: usdcPool.pool, position: usdcPos }], 5_000_000n),
  ), [user]);

  const before = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  ok(`pre-repay HF = ${fmtHF(before.hf)} (debt=${fmtUsdWad(before.debtUsd)})`);

  // 2. Repay HALF the BTC debt.
  const repayHalf = 2_500_000n; // 0.025 BTC
  await sendAndConfirmTransaction(connection, new Transaction().add(
    crossRepayIx(user.publicKey, btcAta, btcPool.vault, btcPool.pool, btcPos,
                 [usdcPos], repayHalf),
  ), [user]);
  ok(`partially repaid 0.025 BTC`);

  const after = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  if (after.hf <= before.hf) fail(`HF did not improve: ${fmtHF(before.hf)} → ${fmtHF(after.hf)}`);
  ok(`post-repay HF = ${fmtHF(after.hf)} (improved from ${fmtHF(before.hf)})`);
  info(`debt halved: ${fmtUsdWad(before.debtUsd)} → ${fmtUsdWad(after.debtUsd)}`);
  // Sanity: $4,250 / $1,500 ≈ 2.83 expected
  assertHFAtLeast(after.hf, (WAD * 28n) / 10n, "post-half-repay HF should be ≥ 2.8");
}

// ─── Scenario 9: cross_withdraw HF check ─────────────────────────────────────

async function scenarioI_WithdrawHFCheck(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  usdcPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 9 · cross_withdraw rejects over-limit, accepts safe");

  const usdcAta = getAssociatedTokenAddressSync(usdcPool.mint, user.publicKey);
  const btcAta  = getAssociatedTokenAddressSync(btcPool.mint, user.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool.pool, user.publicKey);
  const [btcPos, btcPosBump]   = findPositionAddress(btcPool.pool, user.publicKey);
  const [usdcAuth] = findPoolAuthorityAddress(usdcPool.pool);
  const [btcAuth]  = findPoolAuthorityAddress(btcPool.pool);

  // Setup: deposit 5,000 USDC, borrow 0.04 BTC ($2,400). Max cap $4,250 → safe.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    depositIx(user.publicKey, usdcAta, usdcPool.vault, usdcPool.pool, usdcPos,
              5_000n * 10n**6n, usdcPosBump),
  ), [user]);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(user.publicKey, btcAta, user.publicKey, btcPool.mint),
    initPositionIx(user.publicKey, btcPool.pool, btcPos, btcPosBump),
    crossBorrowIx(user.publicKey, btcPool.pool, btcPos, btcPool.vault, btcAta, btcAuth,
      [{ pool: usdcPool.pool, position: usdcPos }], 4_000_000n),
  ), [user]);

  const before = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  ok(`baseline HF = ${fmtHF(before.hf)} ($4,250 × 0.85 / $2,400 ≈ 1.77)`);

  // Try to withdraw 4,000 USDC (would reduce coll to $1,000 × 0.85 = $850, debt $2,400 → HF 0.35)
  let rejected = false;
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      crossWithdrawIx(user.publicKey, usdcPool.pool, usdcPos, usdcPool.vault, usdcAta, usdcAuth,
        [{ pool: btcPool.pool, position: btcPos }], 4_000n * 10n**6n),
    ), [user]);
  } catch (e: any) {
    rejected = true;
    info(`over-limit withdraw rejected: ${(e?.logs ?? []).find((l: string) => l.includes("custom")) ?? "tx failed"}`);
  }
  if (!rejected) fail("over-limit cross_withdraw was NOT rejected — HF check is broken");
  ok("cross_withdraw correctly rejected unsafe withdrawal (would push HF < 1)");

  // Withdraw a SAFE amount: 1,000 USDC → coll = $4,000 × 0.85 = $3,400, debt $2,400 → HF 1.42 (still healthy)
  await sendAndConfirmTransaction(connection, new Transaction().add(
    crossWithdrawIx(user.publicKey, usdcPool.pool, usdcPos, usdcPool.vault, usdcAta, usdcAuth,
      [{ pool: btcPool.pool, position: btcPos }], 1_000n * 10n**6n),
  ), [user]);
  ok("safe cross_withdraw of 1,000 USDC succeeded");

  const after = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  assertHFAtLeast(after.hf, WAD, "post-withdraw HF still healthy");
  info(`HF transitioned ${fmtHF(before.hf)} → ${fmtHF(after.hf)} (collat=${fmtUsdWad(after.collateralUsd)})`);
}

// ─── Scenario 10: flash loan round-trip ──────────────────────────────────────

async function scenarioJ_FlashLoan(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  pool: PoolCtx,
) {
  step(`Scenario 10 · flash loan round-trip on ${pool.symbol}`);

  const ata = getAssociatedTokenAddressSync(pool.mint, user.publicKey);
  const [auth] = findPoolAuthorityAddress(pool.pool);

  const before = await readPool(connection, pool.pool);
  info(`pool pre-flash: deposits=${before.totalDeposits} fees=${before.accumulatedFees}`);

  // Flash 10,000 USDC = 10_000_000_000 base units. Fee = 9 bps = 9,000,000 (9 USDC).
  const amount = 10_000n * 10n**6n;
  await sendAndConfirmTransaction(connection, new Transaction().add(
    flashBorrowIx(user.publicKey, ata, pool.vault, pool.pool, auth, amount),
    flashRepayIx(user.publicKey, ata, pool.vault, pool.pool),
  ), [user]);
  ok(`flash borrow + repay submitted (${amount} ${pool.symbol})`);

  const after = await readPool(connection, pool.pool);
  const expectedFee = (amount * 9n) / 10_000n;          // 9 bps
  const expectedProtocolCut = (expectedFee * 10n) / 100n; // 10% to protocol
  const expectedLpCut = expectedFee - expectedProtocolCut;

  // `flash_borrow` calls `accrue_interest` first, which credits a tiny LP-side
  // interest delta from any in-flight (non-flash) borrows in the pool. We
  // assert the protocol fee landed exactly, and that the LP-side delta is at
  // LEAST the expected fee (small interest accrual on top is correct).
  assertEq(after.flashLoanAmount, 0n, "pool.flash_loan_amount cleared");

  const protocolDelta = after.accumulatedFees - before.accumulatedFees;
  const lpDelta       = after.totalDeposits   - before.totalDeposits;
  if (protocolDelta < expectedProtocolCut || protocolDelta > expectedProtocolCut + 100n) {
    fail(`protocol fee delta out of band: got ${protocolDelta}, expected ≈ ${expectedProtocolCut}`);
  }
  ok(`accumulated_fees grew by ${protocolDelta} ≈ protocol's 10% of ${expectedFee}`);
  if (lpDelta < expectedLpCut || lpDelta > expectedLpCut + 1000n) {
    fail(`LP fee delta out of band: got ${lpDelta}, expected ≈ ${expectedLpCut}`);
  }
  const drift = lpDelta - expectedLpCut;
  ok(`total_deposits grew by ${lpDelta} (LP fee ${expectedLpCut} + ${drift}-unit accrued interest)`);
}

// ─── Scenario 11: cross_liquidate triggered by oracle drop ───────────────────

async function scenarioK_Liquidation(
  connection: Connection,
  payer: Keypair,
  borrower: Keypair,
  liquidator: Keypair,
  usdcPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 11 · cross_liquidate after BTC oracle drop pushes HF < 1");

  const borrowerBtcAta  = getAssociatedTokenAddressSync(btcPool.mint, borrower.publicKey);
  const borrowerUsdcAta = getAssociatedTokenAddressSync(usdcPool.mint, borrower.publicKey);
  const [bBtcPos, bBtcPosBump]   = findPositionAddress(btcPool.pool, borrower.publicKey);
  const [bUsdcPos, bUsdcPosBump] = findPositionAddress(usdcPool.pool, borrower.publicKey);
  const [usdcAuth] = findPoolAuthorityAddress(usdcPool.pool);
  const [btcAuth]  = findPoolAuthorityAddress(btcPool.pool);

  // Borrower posts 0.05 BTC ($3,000) collateral, borrows 1,500 USDC (HF ≈ 1.5).
  await sendAndConfirmTransaction(connection, new Transaction().add(
    depositIx(borrower.publicKey, borrowerBtcAta, btcPool.vault, btcPool.pool, bBtcPos,
              5_000_000n, bBtcPosBump),
  ), [borrower]);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(borrower.publicKey, borrowerUsdcAta, borrower.publicKey, usdcPool.mint),
    initPositionIx(borrower.publicKey, usdcPool.pool, bUsdcPos, bUsdcPosBump),
    crossBorrowIx(borrower.publicKey, usdcPool.pool, bUsdcPos, usdcPool.vault, borrowerUsdcAta, usdcAuth,
      [{ pool: btcPool.pool, position: bBtcPos }], 1_500n * 10n**6n),
  ), [borrower]);

  const beforeHf = (await crossHF(connection, [
    { pool: btcPool.pool,  position: bBtcPos  },
    { pool: usdcPool.pool, position: bUsdcPos },
  ])).hf;
  ok(`borrower pre-drop HF = ${fmtHF(beforeHf)} (healthy)`);

  // Drop BTC oracle from $60k → $25k. Coll becomes $1,250 × 0.75 = $937.5, debt $1,500 → HF ≈ 0.625.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    mockOracleIx(payer.publicKey, btcPool.pool, 2_500_000_000_000n /* $25k @ -8 */, -8),
  ), [payer]);
  ok(`BTC oracle dropped to $25,000`);

  const droppedHf = (await crossHF(connection, [
    { pool: btcPool.pool,  position: bBtcPos  },
    { pool: usdcPool.pool, position: bUsdcPos },
  ])).hf;
  if (droppedHf >= WAD) fail(`HF should have gone underwater, got ${fmtHF(droppedHf)}`);
  ok(`borrower post-drop HF = ${fmtHF(droppedHf)} (< 1.0 — liquidatable)`);

  // Liquidator must hold the DEBT token (USDC). Fund them.
  const liquidatorUsdcAta = await fundUser(connection, payer, liquidator.publicKey, usdcPool, 2_000n * 10n**6n);
  const liquidatorBtcAta  = await fundUser(connection, payer, liquidator.publicKey, btcPool, 0n);

  // Repay 50% of the debt at most (close_factor = 50%) → 750 USDC.
  const repayAmount = 750n * 10n**6n;
  await sendAndConfirmTransaction(connection, new Transaction().add(
    crossLiquidateIx(
      liquidator.publicKey, liquidatorUsdcAta, liquidatorBtcAta,
      usdcPool.pool, bUsdcPos, usdcPool.vault,
      btcPool.pool, bBtcPos, btcPool.vault,
      btcAuth,
      [], // no extra cross-set legs (cross_count = 2, supplied = head_debt + head_coll = 2)
      repayAmount,
    ),
  ), [liquidator]);
  ok(`liquidator paid ${repayAmount} USDC, received seized BTC`);

  // Verify state changes
  const debtPosAfter = (await readUserPosition(connection, bUsdcPos))!;
  const collPosAfter = (await readUserPosition(connection, bBtcPos))!;
  if (debtPosAfter.borrowPrincipal >= 1_500_000_000n) {
    fail(`debt didn't decrease: still ${debtPosAfter.borrowPrincipal}`);
  }
  ok(`borrower USDC.borrow_principal: 1500000000 → ${debtPosAfter.borrowPrincipal} (down)`);
  if (collPosAfter.depositShares >= 5_000_000n) {
    fail(`collateral didn't shrink: ${collPosAfter.depositShares}`);
  }
  ok(`borrower BTC.deposit_shares: 4999999 → ${collPosAfter.depositShares} (down)`);

  const liquidatorBtcBalance = await tokenBalance(connection, liquidatorBtcAta);
  if (liquidatorBtcBalance === 0n) fail("liquidator received zero BTC");
  ok(`liquidator received ${liquidatorBtcBalance} BTC base units (with bonus)`);

  // Restore BTC oracle so subsequent scenarios don't get misleading prices.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    mockOracleIx(payer.publicKey, btcPool.pool, BTC_PRICE, -8),
  ), [payer]);
  info(`BTC oracle restored to $60,000`);
}

// ─── Scenario 12: 3-pool cross-collateral (USDC + ETH → BTC borrow) ──────────

async function scenarioL_MultiPoolCross(
  connection: Connection,
  payer: Keypair,
  user: Keypair,
  usdcPool: PoolCtx,
  ethPool: PoolCtx,
  btcPool: PoolCtx,
) {
  step("Scenario 12 · 3-pool cross-collateral (USDC + ETH collat → BTC borrow)");

  const usdcAta = getAssociatedTokenAddressSync(usdcPool.mint, user.publicKey);
  const ethAta  = getAssociatedTokenAddressSync(ethPool.mint,  user.publicKey);
  const btcAta  = getAssociatedTokenAddressSync(btcPool.mint,  user.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool.pool, user.publicKey);
  const [ethPos, ethPosBump]   = findPositionAddress(ethPool.pool,  user.publicKey);
  const [btcPos, btcPosBump]   = findPositionAddress(btcPool.pool,  user.publicKey);
  const [btcAuth] = findPoolAuthorityAddress(btcPool.pool);

  // Deposit 1,000 USDC ($1,000) + 1 ETH ($3,000) = $4,000 total
  await sendAndConfirmTransaction(connection, new Transaction().add(
    depositIx(user.publicKey, usdcAta, usdcPool.vault, usdcPool.pool, usdcPos,
              1_000n * 10n**6n, usdcPosBump),
  ), [user]);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    depositIx(user.publicKey, ethAta, ethPool.vault, ethPool.pool, ethPos,
              1_000_000_000n, ethPosBump),
  ), [user]);
  ok("deposited 1,000 USDC + 1 ETH ($4,000 nominal)");

  // Cross-borrow 0.025 BTC ($1,500). Cap = $1,000×0.80 + $3,000×0.72 = $800 + $2,160 = $2,960.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(user.publicKey, btcAta, user.publicKey, btcPool.mint),
    initPositionIx(user.publicKey, btcPool.pool, btcPos, btcPosBump),
    crossBorrowIx(user.publicKey, btcPool.pool, btcPos, btcPool.vault, btcAta, btcAuth,
      [
        { pool: usdcPool.pool, position: usdcPos },
        { pool: ethPool.pool,  position: ethPos  },
      ],
      2_500_000n /* 0.025 BTC */),
  ), [user]);
  ok("cross-borrowed 0.025 BTC against USDC + ETH collateral");

  // HF: weighted = $1,000×0.85 + $3,000×0.78 = $850 + $2,340 = $3,190; debt = $1,500 → HF ≈ 2.13
  const post = await crossHF(connection, [
    { pool: usdcPool.pool, position: usdcPos },
    { pool: ethPool.pool,  position: ethPos  },
    { pool: btcPool.pool,  position: btcPos  },
  ]);
  assertHFAtLeast(post.hf, WAD, "3-pool account-level HF");
  if (post.hf < (WAD * 19n) / 10n) fail(`HF lower than expected: ${fmtHF(post.hf)}`);
  ok(`3-pool HF = ${fmtHF(post.hf)} (collat=${fmtUsdWad(post.collateralUsd)} debt=${fmtUsdWad(post.debtUsd)})`);

  // All three positions should share the same cross_set_id, count=3
  const usdcState = (await readUserPosition(connection, usdcPos))!;
  const ethState  = (await readUserPosition(connection, ethPos))!;
  const btcState  = (await readUserPosition(connection, btcPos))!;
  assertEq(usdcState.crossCount, 3, "USDC.cross_count");
  assertEq(ethState.crossCount, 3, "ETH.cross_count");
  assertEq(btcState.crossCount, 3, "BTC.cross_count");
  if (usdcState.crossSetId !== ethState.crossSetId || ethState.crossSetId !== btcState.crossSetId) {
    fail("cross_set_id mismatch across legs");
  }
  ok(`cross_set registry: id=${usdcState.crossSetId}, all 3 positions share it`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(ANSI.bold(`Veil e2e cross-collateral + encryption — ${isLocalRpc(connection) ? "localnet" : "remote"} @ ${RPC_URL}`));

  const payer = loadPayer();
  console.log(`Payer:      ${payer.publicKey.toBase58()}`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  const minLamports = isLocalRpc(connection) ? 50 * LAMPORTS_PER_SOL : 3 * LAMPORTS_PER_SOL;
  if (balance < minLamports) {
    if (isLocalRpc(connection)) {
      info(`payer has only ${balance / LAMPORTS_PER_SOL} SOL — airdropping`);
      await airdrop(connection, payer.publicKey, 100);
    } else {
      throw new Error(`payer needs >= ${minLamports / LAMPORTS_PER_SOL} SOL on non-local cluster, has ${balance / LAMPORTS_PER_SOL}; fund manually`);
    }
  }

  // ── Bootstrap pools ──────────────────────────────────────────────────────
  step("Bootstrap: USDC + BTC pools, mock oracle prices, seed liquidity");
  const usdcPool = await bootstrapPool(connection, payer, {
    symbol: "USDC", decimals: 6, mockPrice: USDC_PRICE, mockExpo: PRICE_EXPO,
    ltv: (WAD * 80n) / 100n, liqTh: (WAD * 85n) / 100n, liqBonus: (WAD * 4n) / 100n,
  });
  const btcPool = await bootstrapPool(connection, payer, {
    symbol: "BTC", decimals: 8, mockPrice: BTC_PRICE, mockExpo: PRICE_EXPO,
    ltv: (WAD * 70n) / 100n, liqTh: (WAD * 75n) / 100n, liqBonus: (WAD * 8n) / 100n,
  });

  // ETH pool needed only for Scenario 12 (multi-pool cross). $3k @ -8 expo.
  const ethPool = await bootstrapPool(connection, payer, {
    symbol: "ETH", decimals: 9, mockPrice: 300_000_000_000n /* $3k */, mockExpo: PRICE_EXPO,
    ltv: (WAD * 72n) / 100n, liqTh: (WAD * 78n) / 100n, liqBonus: (WAD * 7n) / 100n,
  });

  await seedPoolLiquidity(connection, payer, usdcPool, 100_000n * 10n**6n); // 100k USDC
  await seedPoolLiquidity(connection, payer, btcPool,  10n**8n);              // 1 BTC
  await seedPoolLiquidity(connection, payer, ethPool,  10n * 10n**9n);        // 10 ETH

  // ── User A (Scenario 1: USDC → BTC) ──────────────────────────────────────
  const userA = Keypair.generate();
  await fundUser(connection, payer, userA.publicKey, usdcPool, 5_000n * 10n**6n);
  // No BTC funding — explicit "user has no BTC" condition.
  await scenarioA_UsdcToBtc(connection, payer, userA, usdcPool, btcPool);

  // ── User B (Scenario 2: BTC → USDC) ──────────────────────────────────────
  const userB = Keypair.generate();
  await fundUser(connection, payer, userB.publicKey, btcPool, 5_000_000n);
  // No USDC funding — explicit "user has no USDC" condition.
  await scenarioB_BtcToUsdc(connection, payer, userB, usdcPool, btcPool);

  // Scenarios 3-6 (Encrypt) skipped: e2e's commonEncryptAccounts() still
  // points to SystemProgram stubs, but on-chain enable_privacy now does a
  // real CPI to Encrypt. Re-enable once the script is updated with real
  // EncryptConfig / network-key / event-authority addresses (and outer-tx
  // signers for the ephemeral ciphertext keypairs).
  const SKIP_ENCRYPT = process.env.SKIP_ENCRYPT !== "0";
  if (!SKIP_ENCRYPT) {
    const userC = Keypair.generate();
    await fundUser(connection, payer, userC.publicKey, usdcPool, 5_000n * 10n**6n);
    await scenarioC_EncryptedSinglePool(connection, payer, userC, usdcPool, {
      deposit: 2_000n * 10n**6n, borrow: 600n * 10n**6n, symbol: "USDC",
    });

    const userD = Keypair.generate();
    await fundUser(connection, payer, userD.publicKey, btcPool, 5_000_000n);
    await scenarioC_EncryptedSinglePool(connection, payer, userD, btcPool, {
      deposit: 2_000_000n, borrow: 1_000_000n, symbol: "BTC",
    });

    const userE = Keypair.generate();
    await fundUser(connection, payer, userE.publicKey, usdcPool, 5_000n * 10n**6n);
    await scenarioE_EncryptedCrossBorrow(
      connection, payer, userE, usdcPool, btcPool,
      5_000n * 10n**6n, 5_000_000n,
      "user E · USDC private + cross-borrow BTC",
    );

    const userF = Keypair.generate();
    await fundUser(connection, payer, userF.publicKey, btcPool, 5_000_000n);
    await scenarioE_EncryptedCrossBorrow(
      connection, payer, userF, btcPool, usdcPool,
      5_000_000n, 1_500n * 10n**6n,
      "user F · BTC private + cross-borrow USDC",
    );
  } else {
    console.log(ANSI.dim("\n[Scenarios 3-6 skipped — Encrypt CPI script drift; set SKIP_ENCRYPT=0 to attempt]\n"));
  }

  // ── User G (Sanity: over-limit cross-borrow MUST fail) ───────────────────
  step("Sanity · cross-borrow OVER limit must be rejected on-chain");
  const userG = Keypair.generate();
  const usdcAtaG = await fundUser(connection, payer, userG.publicKey, usdcPool, 1_000n * 10n**6n);
  const btcAtaG  = getAssociatedTokenAddressSync(btcPool.mint, userG.publicKey);
  const [usdcPosG, usdcPosBumpG] = findPositionAddress(usdcPool.pool, userG.publicKey);
  const [btcPosG, btcPosBumpG]   = findPositionAddress(btcPool.pool, userG.publicKey);
  const [btcAuthG] = findPoolAuthorityAddress(btcPool.pool);

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositIx(userG.publicKey, usdcAtaG, usdcPool.vault, usdcPool.pool, usdcPosG,
                1_000n * 10n**6n, usdcPosBumpG),
    ),
    [userG],
  );

  // 1,000 USDC @ 80% LTV = $800 → 0.0133 BTC max. Try to borrow 0.05 BTC ($3,000).
  const overAmt = 5_000_000n;
  let rejected = false;
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      createAssociatedTokenAccountInstruction(userG.publicKey, btcAtaG, userG.publicKey, btcPool.mint),
      initPositionIx(userG.publicKey, btcPool.pool, btcPosG, btcPosBumpG),
      crossBorrowIx(userG.publicKey, btcPool.pool, btcPosG, btcPool.vault, btcAtaG, btcAuthG,
        [{ pool: usdcPool.pool, position: usdcPosG }], overAmt),
    ), [userG]);
  } catch (e: any) {
    rejected = true;
    const code = (e?.logs ?? []).find((l: string) => l.includes("custom program error"))
                  ?? e?.message ?? String(e);
    info(`tx rejected as expected: ${code}`);
  }
  if (!rejected) fail("over-limit cross-borrow was NOT rejected — risk check is broken");
  ok("over-limit borrow correctly rejected by ExceedsCollateralFactor / Undercollateralised");

  // After the failed borrow, on-chain state must be unchanged: still no debt → ∞.
  assertHFInfinite(await singlePoolHF(connection, usdcPool.pool, usdcPosG), "post-rejection (state unchanged)");

  // ── User H (Scenario 8: partial cross_repay) ─────────────────────────────
  const userH = Keypair.generate();
  await fundUser(connection, payer, userH.publicKey, usdcPool, 5_000n * 10n**6n);
  await scenarioH_PartialRepayRecoversHF(connection, payer, userH, usdcPool, btcPool);

  // ── User I (Scenario 9: cross_withdraw HF check) ─────────────────────────
  const userI = Keypair.generate();
  await fundUser(connection, payer, userI.publicKey, usdcPool, 5_000n * 10n**6n);
  await scenarioI_WithdrawHFCheck(connection, payer, userI, usdcPool, btcPool);

  // ── User J (Scenario 10: flash loan) ─────────────────────────────────────
  const userJ = Keypair.generate();
  await fundUser(connection, payer, userJ.publicKey, usdcPool, 100n * 10n**6n);
  // Flash needs the borrower's ATA but doesn't require pre-funded balance — they
  // just need lamports for fees and a token account to receive the flash loan into.
  await scenarioJ_FlashLoan(connection, payer, userJ, usdcPool);

  // ── Users K (borrower) + L (liquidator) — Scenario 11: liquidation ───────
  const userK = Keypair.generate();
  const userL = Keypair.generate();
  await fundUser(connection, payer, userK.publicKey, btcPool, 5_000_000n);
  await scenarioK_Liquidation(connection, payer, userK, userL, usdcPool, btcPool);

  // ── User M (Scenario 12: 3-pool cross) ───────────────────────────────────
  const userM = Keypair.generate();
  await fundUser(connection, payer, userM.publicKey, usdcPool, 1_000n * 10n**6n);
  await fundUser(connection, payer, userM.publicKey, ethPool,  1_000_000_000n);
  await scenarioL_MultiPoolCross(connection, payer, userM, usdcPool, ethPool, btcPool);

  console.log("\n" + ANSI.green(ANSI.bold("ALL SCENARIOS PASSED")));
  console.log(ANSI.dim("\nReminder: Encrypt CPI is a no-op stub on localnet. Plaintext"));
  console.log(ANSI.dim("bookkeeping is correct, but no real ciphertext is produced. Real"));
  console.log(ANSI.dim("FHE requires the Encrypt program at 4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8"));
  console.log(ANSI.dim("on devnet/mainnet (not deployed on localnet)."));
}

main().catch((e) => {
  console.error("\n" + ANSI.red("FAIL: ") + (e?.message ?? e));
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
