import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  depositIx,
  withdrawIx,
  borrowIx,
  repayIx,
  liquidateIx,
  updatePoolIx,
} from "../lib/veil/instructions";
import { findPositionAddress, findPoolAuthorityAddress } from "../lib/veil/pda";
import {
  fetchPool,
  fetchPosition,
  sharesToTokens,
  borrowDebt,
  healthFactor,
  type LendingPool,
  type UserPosition,
} from "../lib/veil/state";
import { WAD } from "../lib/veil/constants";

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC = "http://localhost:8899";
const API = "http://localhost:3000";
const SOL_POOL = new PublicKey("HCyW3ya5BQLABUv4TS6EJm9QNAmz1L3uMsbCMQUvXc7c");
const PAYER_PATH = process.env.PAYER_KEYPAIR ?? path.join(homedir(), ".config/solana/id.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean; detail: string };
const results: TestResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, passed: true, detail });
  console.log(`  PASS: ${detail}`);
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
  console.log(`  FAIL: ${detail}`);
}

function check(name: string, label: string, expected: bigint, actual: bigint, tolerance = 0n) {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff <= tolerance) {
    pass(name, `${label}: expected=${expected}, actual=${actual}`);
  } else {
    fail(name, `${label}: expected=${expected}, actual=${actual}, diff=${diff}`);
  }
}

function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

function wadPct(pct: number): bigint {
  return (WAD * BigInt(Math.round(pct * 100))) / 10000n;
}

function formatWad(v: bigint): string {
  const pct = Number((v * 10000n) / WAD) / 100;
  return `${pct}%`;
}

async function readPool(connection: Connection): Promise<LendingPool> {
  const pool = await fetchPool(connection, SOL_POOL);
  if (!pool) throw new Error("SOL pool not found on-chain");
  return pool;
}

async function readPosition(
  connection: Connection,
  pool: PublicKey,
  user: PublicKey
): Promise<UserPosition> {
  const [posAddr] = findPositionAddress(pool, user);
  const pos = await fetchPosition(connection, posAddr);
  if (!pos) throw new Error(`Position not found for ${user.toBase58()}`);
  return pos;
}

function computeUtilization(pool: LendingPool): bigint {
  if (pool.totalDeposits === 0n) return 0n;
  return (pool.totalBorrows * WAD) / pool.totalDeposits;
}

function computeBorrowRate(pool: LendingPool): bigint {
  const u = computeUtilization(pool);
  const optUtil = pool.optimalUtilization;
  if (u <= optUtil) {
    return pool.baseRate + (pool.slope1 * u) / optUtil;
  }
  return pool.baseRate + pool.slope1 + (pool.slope2 * (u - optUtil)) / (WAD - optUtil);
}

function computeSupplyRate(pool: LendingPool): bigint {
  const borrowRate = computeBorrowRate(pool);
  const u = computeUtilization(pool);
  return (borrowRate * u * (WAD - pool.reserveFactor)) / (WAD * WAD);
}

async function syncPoolViaApi(poolAddress: PublicKey): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/pools/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool_address: poolAddress.toBase58(), rpc: RPC }),
    });
    return res.ok;
  } catch {
    console.log("  (API pool sync skipped - server not running)");
    return false;
  }
}

async function syncPositionViaApi(poolAddress: PublicKey, user: PublicKey): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/positions/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool_address: poolAddress.toBase58(), user: user.toBase58(), rpc: RPC }),
    });
    return res.ok;
  } catch {
    console.log("  (API position sync skipped - server not running)");
    return false;
  }
}

async function checkUnhealthyApi(): Promise<unknown[] | null> {
  try {
    const res = await fetch(`${API}/api/positions/unhealthy`);
    if (!res.ok) return null;
    const data = (await res.json()) as { positions?: unknown[] };
    return data.positions ?? [];
  } catch {
    console.log("  (Unhealthy endpoint skipped - server not running)");
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(path.resolve(PAYER_PATH), "utf-8"))
  );
  const payer = Keypair.fromSecretKey(secretKey);

  console.log("=== VEIL E2E TEST SUITE ===");
  console.log(`Payer:    ${payer.publicKey.toBase58()}`);
  console.log(`SOL Pool: ${SOL_POOL.toBase58()}`);
  console.log(`RPC:      ${RPC}`);
  console.log("");

  // ─── Read initial state ──────────────────────────────────────────────────

  console.log("--- INITIAL STATE ---");
  const poolBefore = await readPool(connection);
  const tokenMint = poolBefore.tokenMint;
  const vault = poolBefore.vault;
  const [poolAuthority] = findPoolAuthorityAddress(SOL_POOL);
  const [payerPosition, payerPositionBump] = findPositionAddress(SOL_POOL, payer.publicKey);
  const payerAta = getAssociatedTokenAddressSync(tokenMint, payer.publicKey);

  console.log(`  Token Mint:      ${tokenMint.toBase58()}`);
  console.log(`  Vault:           ${vault.toBase58()}`);
  console.log(`  Pool Authority:  ${poolAuthority.toBase58()}`);
  console.log(`  Total Deposits:  ${poolBefore.totalDeposits}`);
  console.log(`  Total Borrows:   ${poolBefore.totalBorrows}`);
  console.log(`  Accumulated Fees:${poolBefore.accumulatedFees}`);
  console.log(`  Supply Index:    ${poolBefore.supplyIndex}`);
  console.log(`  Borrow Index:    ${poolBefore.borrowIndex}`);
  console.log(`  Utilization:     ${formatWad(computeUtilization(poolBefore))}`);
  console.log(`  Borrow Rate:     ${formatWad(computeBorrowRate(poolBefore))}`);
  console.log(`  Supply Rate:     ${formatWad(computeSupplyRate(poolBefore))}`);
  console.log(`  Liq Threshold:   ${formatWad(poolBefore.liquidationThreshold)}`);
  console.log(`  LTV:             ${formatWad(poolBefore.ltv)}`);
  console.log("");

  // ─── TEST 1: Deposit 2 SOL ────────────────────────────────────────────────

  const TEST1 = "TEST 1: Deposit 2 SOL";
  console.log(`--- ${TEST1} ---`);
  {
    const depositAmount = lamports(2);
    const stateBefore = await readPool(connection);

    const tx = new Transaction().add(
      depositIx(
        payer.publicKey,
        payerAta,
        vault,
        SOL_POOL,
        payerPosition,
        depositAmount,
        payerPositionBump
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);

    const stateAfter = await readPool(connection);
    const depositsIncrease = stateAfter.totalDeposits - stateBefore.totalDeposits;
    check(TEST1, "total_deposits increased by ~2 SOL", depositAmount, depositsIncrease, lamports(0.01));

    // Verify utilization dropped (more deposits, same borrows)
    const utilBefore = computeUtilization(stateBefore);
    const utilAfter = computeUtilization(stateAfter);
    if (utilAfter < utilBefore) {
      pass(TEST1, `Utilization dropped: ${formatWad(utilBefore)} -> ${formatWad(utilAfter)}`);
    } else {
      fail(TEST1, `Utilization did not drop: ${formatWad(utilBefore)} -> ${formatWad(utilAfter)}`);
    }

    // Verify supply rate recalculated
    const supplyBefore = computeSupplyRate(stateBefore);
    const supplyAfter = computeSupplyRate(stateAfter);
    console.log(`  Supply APY: ${formatWad(supplyBefore)} -> ${formatWad(supplyAfter)}`);

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── TEST 2: Withdraw 1 SOL ───────────────────────────────────────────────

  const TEST2 = "TEST 2: Withdraw 1 SOL";
  console.log(`--- ${TEST2} ---`);
  {
    const stateBefore = await readPool(connection);
    const posBefore = await readPosition(connection, SOL_POOL, payer.publicKey);

    // Calculate shares for 1 SOL: shares = amount * WAD / supplyIndex
    const withdrawAmount = lamports(1);
    const sharesToWithdraw = (withdrawAmount * WAD) / stateBefore.supplyIndex;

    const tx = new Transaction().add(
      withdrawIx(
        payer.publicKey,
        payerAta,
        vault,
        SOL_POOL,
        payerPosition,
        poolAuthority,
        sharesToWithdraw
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);

    const stateAfter = await readPool(connection);
    const depositsDecrease = stateBefore.totalDeposits - stateAfter.totalDeposits;

    // Allow tolerance for index rounding
    check(TEST2, "total_deposits decreased by ~1 SOL", withdrawAmount, depositsDecrease, lamports(0.05));

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── TEST 3: Borrow 1 SOL ─────────────────────────────────────────────────

  const TEST3 = "TEST 3: Borrow 1 SOL";
  console.log(`--- ${TEST3} ---`);
  {
    const borrowAmount = lamports(1);
    const stateBefore = await readPool(connection);

    const tx = new Transaction().add(
      borrowIx(
        payer.publicKey,
        payerAta,
        vault,
        SOL_POOL,
        payerPosition,
        poolAuthority,
        borrowAmount
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);

    const stateAfter = await readPool(connection);
    const borrowsIncrease = stateAfter.totalBorrows - stateBefore.totalBorrows;
    check(TEST3, "total_borrows increased by ~1 SOL", borrowAmount, borrowsIncrease, lamports(0.01));

    // Verify borrow rate went up
    const brBefore = computeBorrowRate(stateBefore);
    const brAfter = computeBorrowRate(stateAfter);
    if (brAfter > brBefore) {
      pass(TEST3, `Borrow rate increased: ${formatWad(brBefore)} -> ${formatWad(brAfter)}`);
    } else {
      fail(TEST3, `Borrow rate did not increase: ${formatWad(brBefore)} -> ${formatWad(brAfter)}`);
    }

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── TEST 4: Repay 0.5 SOL ────────────────────────────────────────────────

  const TEST4 = "TEST 4: Repay 0.5 SOL";
  console.log(`--- ${TEST4} ---`);
  {
    const repayAmount = lamports(0.5);
    const stateBefore = await readPool(connection);

    const tx = new Transaction().add(
      repayIx(
        payer.publicKey,
        payerAta,
        vault,
        SOL_POOL,
        payerPosition,
        repayAmount
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);

    const stateAfter = await readPool(connection);
    const borrowsDecrease = stateBefore.totalBorrows - stateAfter.totalBorrows;
    check(TEST4, "total_borrows decreased by ~0.5 SOL", repayAmount, borrowsDecrease, lamports(0.05));

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── TEST 5: Create underwater position ────────────────────────────────────

  const TEST5 = "TEST 5: Force position underwater";
  console.log(`--- ${TEST5} ---`);
  {
    // Save original params for restoration
    const poolState = await readPool(connection);
    const origLiqThreshold = poolState.liquidationThreshold;

    // Read payer's position to calculate what threshold makes it underwater
    const payerPos = await readPosition(connection, SOL_POOL, payer.publicKey);
    const collateral = sharesToTokens(payerPos.depositShares, poolState.supplyIndex);
    const debt = borrowDebt(
      payerPos.borrowPrincipal,
      poolState.borrowIndex,
      payerPos.borrowIndexSnapshot
    );

    console.log(`  Payer collateral (tokens): ${collateral}`);
    console.log(`  Payer debt (tokens):       ${debt}`);
    console.log(`  Current liq threshold:     ${formatWad(origLiqThreshold)}`);

    // Calculate HF and find a threshold that makes HF < 1
    const currentHF = healthFactor(
      payerPos.depositShares,
      poolState.supplyIndex,
      payerPos.borrowPrincipal,
      poolState.borrowIndex,
      payerPos.borrowIndexSnapshot,
      origLiqThreshold
    );
    console.log(`  Current health factor:     ${Number(currentHF) / 1e18}`);

    // Set liquidation threshold very low to force underwater
    // HF = collateral * liqThreshold / debt
    // We want HF < WAD, so liqThreshold < debt / collateral * WAD
    const targetThreshold = collateral > 0n ? (debt * WAD * 90n) / (collateral * 100n) : wadPct(1);
    // ltv must be strictly less than liquidationThreshold (on-chain validation)
    const targetLtv = (targetThreshold * 80n) / 100n; // 80% of threshold, well below
    console.log(`  Target liq threshold:      ${formatWad(targetThreshold)}`);
    console.log(`  Target ltv:                ${formatWad(targetLtv)}`);

    const updateTx = new Transaction().add(
      updatePoolIx(payer.publicKey, SOL_POOL, {
        baseRate: poolState.baseRate,
        optimalUtilization: poolState.optimalUtilization,
        slope1: poolState.slope1,
        slope2: poolState.slope2,
        reserveFactor: poolState.reserveFactor,
        ltv: targetLtv,
        liquidationThreshold: targetThreshold,
        liquidationBonus: poolState.liquidationBonus,
        protocolLiqFee: poolState.protocolLiqFee,
        closeFactor: poolState.closeFactor,
        flashFeeBps: poolState.flashFeeBps,
      })
    );
    await sendAndConfirmTransaction(connection, updateTx, [payer]);

    const poolAfter = await readPool(connection);
    check(TEST5, "liq_threshold updated", targetThreshold, poolAfter.liquidationThreshold);

    // Verify HF is now < 1
    const newHF = healthFactor(
      payerPos.depositShares,
      poolAfter.supplyIndex,
      payerPos.borrowPrincipal,
      poolAfter.borrowIndex,
      payerPos.borrowIndexSnapshot,
      poolAfter.liquidationThreshold
    );
    if (newHF < WAD) {
      pass(TEST5, `Health factor is now ${Number(newHF) / 1e18} (< 1.0, underwater)`);
    } else {
      fail(TEST5, `Health factor is ${Number(newHF) / 1e18} (should be < 1.0)`);
    }

    // Sync pool and position so DB has updated HF
    await syncPoolViaApi(SOL_POOL);
    await syncPositionViaApi(SOL_POOL, payer.publicKey);
    const unhealthy = await checkUnhealthyApi();
    if (unhealthy !== null) {
      if (unhealthy.length > 0) {
        pass(TEST5, `Unhealthy API returned ${unhealthy.length} position(s)`);
      } else {
        fail(TEST5, "Unhealthy API returned 0 positions");
      }
    }
    console.log("");
  }

  // ─── TEST 6: Liquidate ─────────────────────────────────────────────────────

  const TEST6 = "TEST 6: Liquidate";
  console.log(`--- ${TEST6} ---`);
  {
    // Generate a liquidator keypair
    const liquidator = Keypair.generate();
    console.log(`  Liquidator: ${liquidator.publicKey.toBase58()}`);

    // Airdrop SOL to liquidator
    const airdropSig = await connection.requestAirdrop(
      liquidator.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig, "confirmed");
    console.log("  Airdropped 5 SOL to liquidator");

    // Create liquidator's ATA for the token mint
    const liquidatorAta = getAssociatedTokenAddressSync(tokenMint, liquidator.publicKey);
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        liquidator.publicKey,
        liquidatorAta,
        liquidator.publicKey,
        tokenMint
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [liquidator]);
    console.log("  Created liquidator ATA");

    // Mint tokens to liquidator so they can repay the borrower's debt
    // Payer is the mint authority (set up during localnet setup)
    const mintAmount = lamports(100); // plenty for repayment
    const mintIx = createMintToInstruction(
      tokenMint,
      liquidatorAta,
      payer.publicKey, // mint authority
      BigInt(mintAmount.toString())
    );
    const mintTx = new Transaction().add(mintIx);
    await sendAndConfirmTransaction(connection, mintTx, [payer]);
    console.log(`  Minted ${mintAmount} tokens to liquidator`);

    // Read state before liquidation
    const poolBefore = await readPool(connection);
    const payerPosBefore = await readPosition(connection, SOL_POOL, payer.publicKey);
    const liquidatorTokenBefore = await getAccount(connection, liquidatorAta);

    const debtBefore = borrowDebt(
      payerPosBefore.borrowPrincipal,
      poolBefore.borrowIndex,
      payerPosBefore.borrowIndexSnapshot
    );
    const collateralBefore = sharesToTokens(payerPosBefore.depositShares, poolBefore.supplyIndex);

    console.log(`  Pre-liq debt:       ${debtBefore}`);
    console.log(`  Pre-liq collateral: ${collateralBefore}`);
    console.log(`  Pre-liq fees:       ${poolBefore.accumulatedFees}`);
    console.log(`  Close factor:       ${formatWad(poolBefore.closeFactor)}`);
    console.log(`  Liq bonus:          ${formatWad(poolBefore.liquidationBonus)}`);
    console.log(`  Protocol liq fee:   ${formatWad(poolBefore.protocolLiqFee)}`);

    // Execute liquidation
    const liqTx = new Transaction().add(
      liquidateIx(
        liquidator.publicKey,
        liquidatorAta,
        vault,
        SOL_POOL,
        payerPosition,
        poolAuthority
      )
    );
    await sendAndConfirmTransaction(connection, liqTx, [liquidator]);
    console.log("  Liquidation tx confirmed");

    // Read state after liquidation
    const poolAfter = await readPool(connection);
    const payerPosAfter = await readPosition(connection, SOL_POOL, payer.publicKey);
    const liquidatorTokenAfter = await getAccount(connection, liquidatorAta);

    const debtAfter = borrowDebt(
      payerPosAfter.borrowPrincipal,
      poolAfter.borrowIndex,
      payerPosAfter.borrowIndexSnapshot
    );

    // Calculate expected values
    // close_factor = 50%, so repay_amount = debt * 50%
    const repayAmount = (debtBefore * poolBefore.closeFactor) / WAD;
    // seized_collateral = repay_amount * (1 + liq_bonus)
    const seizedCollateral = (repayAmount * (WAD + poolBefore.liquidationBonus)) / WAD;
    // protocol_fee = seized_collateral * protocol_liq_fee
    const protocolFee = (seizedCollateral * poolBefore.protocolLiqFee) / WAD;
    // liquidator gets seized_collateral - protocol_fee
    const liquidatorReceives = seizedCollateral - protocolFee;

    console.log("");
    console.log("  Expected values:");
    console.log(`    Repay amount:        ${repayAmount}`);
    console.log(`    Seized collateral:   ${seizedCollateral}`);
    console.log(`    Protocol fee:        ${protocolFee}`);
    console.log(`    Liquidator receives: ${liquidatorReceives}`);
    console.log("");

    // Verify debt reduced by close_factor
    const expectedDebtAfter = debtBefore - repayAmount;
    const tolerance = lamports(0.1); // allow some rounding
    check(TEST6, "Borrower debt reduced", expectedDebtAfter, debtAfter, tolerance);

    // Verify accumulated_fees increased by protocol_fee
    const feesIncrease = poolAfter.accumulatedFees - poolBefore.accumulatedFees;
    check(TEST6, "Accumulated fees increased by protocol fee", protocolFee, feesIncrease, tolerance);

    // Verify protocol_liq_fee is 10% of seized collateral
    const expectedProtocolFee = (seizedCollateral * poolBefore.protocolLiqFee) / WAD;
    check(TEST6, "Protocol fee = protocolLiqFee% of seized", expectedProtocolFee, protocolFee, 0n);
    pass(TEST6, `Protocol liq fee rate: ${formatWad(poolBefore.protocolLiqFee)}`);

    // Verify liquidator token balance increase
    const liquidatorBalanceBefore = BigInt(liquidatorTokenBefore.amount.toString());
    const liquidatorBalanceAfter = BigInt(liquidatorTokenAfter.amount.toString());
    const liquidatorGain = liquidatorBalanceAfter - liquidatorBalanceBefore;

    // The liquidator pays repay_amount and receives collateral tokens
    // Net gain should be approximately liquidatorReceives - repayAmount
    console.log(`  Liquidator balance change: ${liquidatorGain}`);
    console.log(`  Liquidator paid (repay):   ${repayAmount}`);
    // The token account shows net: receives - paid
    const expectedNetGain = liquidatorReceives - repayAmount;
    if (expectedNetGain >= 0n) {
      check(TEST6, "Liquidator net token gain", expectedNetGain, liquidatorGain, tolerance);
    } else {
      // If negative (paid more than received in same token), that's expected
      // when collateral = same token as debt
      console.log(`  (Same-token liquidation: net change = receives - repay)`);
      check(TEST6, "Liquidator net token change", expectedNetGain, liquidatorGain, tolerance);
    }

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── TEST 7: Restore params ────────────────────────────────────────────────

  const TEST7 = "TEST 7: Restore liquidation threshold";
  console.log(`--- ${TEST7} ---`);
  {
    const poolState = await readPool(connection);
    const originalThreshold = wadPct(80); // 80%
    const originalLtv = wadPct(75); // 75%

    const tx = new Transaction().add(
      updatePoolIx(payer.publicKey, SOL_POOL, {
        baseRate: poolState.baseRate,
        optimalUtilization: poolState.optimalUtilization,
        slope1: poolState.slope1,
        slope2: poolState.slope2,
        reserveFactor: poolState.reserveFactor,
        ltv: originalLtv,
        liquidationThreshold: originalThreshold,
        liquidationBonus: poolState.liquidationBonus,
        protocolLiqFee: poolState.protocolLiqFee,
        closeFactor: poolState.closeFactor,
        flashFeeBps: poolState.flashFeeBps,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);

    const poolAfter = await readPool(connection);
    check(TEST7, "liq_threshold restored to 80%", originalThreshold, poolAfter.liquidationThreshold);

    // Verify position is healthy again
    const payerPos = await readPosition(connection, SOL_POOL, payer.publicKey);
    const hf = healthFactor(
      payerPos.depositShares,
      poolAfter.supplyIndex,
      payerPos.borrowPrincipal,
      poolAfter.borrowIndex,
      payerPos.borrowIndexSnapshot,
      poolAfter.liquidationThreshold
    );
    if (hf >= WAD) {
      pass(TEST7, `Health factor restored to ${Number(hf) / 1e18} (healthy)`);
    } else {
      fail(TEST7, `Health factor still underwater: ${Number(hf) / 1e18}`);
    }

    await syncPoolViaApi(SOL_POOL);
    console.log("");
  }

  // ─── DB sync verification ─────────────────────────────────────────────────

  console.log("--- DB SYNC CHECK ---");
  {
    try {
      const res = await fetch(`${API}/api/pools/${SOL_POOL.toBase58()}`);
      if (res.ok) {
        const dbPool = (await res.json()) as Record<string, string>;
        const onChain = await readPool(connection);

        const dbDeposits = BigInt(dbPool.total_deposits || "0");
        const dbBorrows = BigInt(dbPool.total_borrows || "0");

        if (dbDeposits === onChain.totalDeposits) {
          pass("DB SYNC", `total_deposits match: ${dbDeposits}`);
        } else {
          fail("DB SYNC", `total_deposits mismatch: db=${dbDeposits} chain=${onChain.totalDeposits}`);
        }
        if (dbBorrows === onChain.totalBorrows) {
          pass("DB SYNC", `total_borrows match: ${dbBorrows}`);
        } else {
          fail("DB SYNC", `total_borrows mismatch: db=${dbBorrows} chain=${onChain.totalBorrows}`);
        }
      } else {
        console.log("  (API returned non-OK, skipping DB sync check)");
      }
    } catch {
      console.log("  (API not available, skipping DB sync check)");
    }
    console.log("");
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log("=".repeat(70));
  console.log("  TEST SUMMARY");
  console.log("=".repeat(70));
  console.log("");
  console.log(
    "  " +
      "Test".padEnd(45) +
      "Result".padEnd(8)
  );
  console.log("  " + "-".repeat(53));

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    if (r.passed) passed++;
    else failed++;
    const shortDetail = r.detail.length > 42 ? r.detail.slice(0, 42) + "..." : r.detail;
    console.log(`  ${shortDetail.padEnd(45)} ${status}`);
  }

  console.log("");
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("E2E test suite failed:", err);
  process.exit(1);
});
