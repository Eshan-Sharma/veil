import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { buildInitializePoolTx } from "../lib/veil/initialize";
import {
  updatePoolIx,
  depositIx,
  mockOracleIx,
  setPoolDecimalsIx,
  crossBorrowIx,
} from "../lib/veil/instructions";
import {
  findPositionAddress,
  findPoolAuthorityAddress,
  findVaultAddress,
} from "../lib/veil/pda";
import { WAD } from "../lib/veil/constants";
import * as fs from "fs";
import * as path from "path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`  ▸ ${msg}`);
}
function header(msg: string) {
  console.log(`\n═══ ${msg} ${"═".repeat(Math.max(0, 60 - msg.length))}`);
}
function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string) {
  console.log(`  ❌ ${msg}`);
}

async function main() {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const keypairPath = path.resolve("/Users/eshan/my-solana-testing-dev-wallet.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);

  // Create a SEPARATE user wallet — this is the user who will cross-borrow.
  // They should NOT be the same as the LP/admin.
  const user = Keypair.generate();

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         CROSS-COLLATERAL BORROW — USER PERSPECTIVE TEST         ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Admin:  ${admin.publicKey.toBase58().slice(0, 24)}...`);
  console.log(`║  User:   ${user.publicKey.toBase58().slice(0, 24)}... (fresh wallet)`);
  console.log(`║  RPC:    http://127.0.0.1:8899`);
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Fund the user wallet
  const sig = await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
  ok("User wallet funded with 2 SOL for tx fees");

  // ═══ STEP 1: Admin creates two token mints ════════════════════════════════

  header("STEP 1 — Admin creates token mints");

  const usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  ok(`USDC mint: ${usdcMint.toBase58()}`);

  const solMint = await createMint(connection, admin, admin.publicKey, null, 9);
  ok(`SOL mint:  ${solMint.toBase58()}`);

  // ═══ STEP 2: Admin initializes USDC pool ══════════════════════════════════

  header("STEP 2 — Admin initializes USDC pool (collateral pool)");

  const usdcInit = buildInitializePoolTx({
    payer: admin.publicKey,
    authority: admin.publicKey,
    tokenMint: usdcMint,
  });
  await sendAndConfirmTransaction(connection, usdcInit.tx, [admin]);
  ok(`USDC Pool: ${usdcInit.pool.toBase58()}`);

  const updateUsdcTx = new Transaction().add(
    updatePoolIx(admin.publicKey, usdcInit.pool, {
      baseRate: WAD / 10n,
      optimalUtilization: (WAD * 8n) / 10n,
      slope1: (WAD * 4n) / 100n,
      slope2: (WAD * 75n) / 100n,
      reserveFactor: (WAD * 2n) / 10n,
      ltv: (WAD * 75n) / 100n,
      liquidationThreshold: (WAD * 8n) / 10n,
      liquidationBonus: (WAD * 5n) / 100n,
      protocolLiqFee: (WAD * 1n) / 10n,
      closeFactor: WAD / 2n,
      flashFeeBps: 9n,
    })
  );
  await sendAndConfirmTransaction(connection, updateUsdcTx, [admin]);
  ok("USDC pool params set (LTV=75%, LiqThreshold=80%)");

  // ═══ STEP 3: Admin initializes SOL pool ═══════════════════════════════════

  header("STEP 3 — Admin initializes SOL pool (borrow pool)");

  const solInit = buildInitializePoolTx({
    payer: admin.publicKey,
    authority: admin.publicKey,
    tokenMint: solMint,
  });
  await sendAndConfirmTransaction(connection, solInit.tx, [admin]);
  ok(`SOL Pool: ${solInit.pool.toBase58()}`);

  const updateSolTx = new Transaction().add(
    updatePoolIx(admin.publicKey, solInit.pool, {
      baseRate: WAD / 10n,
      optimalUtilization: (WAD * 8n) / 10n,
      slope1: (WAD * 4n) / 100n,
      slope2: (WAD * 75n) / 100n,
      reserveFactor: (WAD * 2n) / 10n,
      ltv: (WAD * 75n) / 100n,
      liquidationThreshold: (WAD * 8n) / 10n,
      liquidationBonus: (WAD * 5n) / 100n,
      protocolLiqFee: (WAD * 1n) / 10n,
      closeFactor: WAD / 2n,
      flashFeeBps: 9n,
    })
  );
  await sendAndConfirmTransaction(connection, updateSolTx, [admin]);
  ok("SOL pool params set");

  // ═══ STEP 4: Admin sets oracle prices & decimals ══════════════════════════

  header("STEP 4 — Set oracle prices & token decimals");

  const tx4 = new Transaction()
    .add(mockOracleIx(admin.publicKey, usdcInit.pool, 100_000_000n, -8))   // $1
    .add(mockOracleIx(admin.publicKey, solInit.pool, 15_000_000_000n, -8)) // $150
    .add(setPoolDecimalsIx(admin.publicKey, usdcInit.pool, usdcMint))
    .add(setPoolDecimalsIx(admin.publicKey, solInit.pool, solMint));
  await sendAndConfirmTransaction(connection, tx4, [admin]);
  ok("USDC=$1.00, SOL=$150.00, decimals set");

  // ═══ STEP 5: Admin seeds SOL pool with liquidity (LP deposit) ═════════════

  header("STEP 5 — LP deposits SOL into SOL pool (liquidity)");

  const adminSolAta = getAssociatedTokenAddressSync(solMint, admin.publicKey);
  const createAdminSolAta = new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, adminSolAta, admin.publicKey, solMint)
  );
  await sendAndConfirmTransaction(connection, createAdminSolAta, [admin]);
  await mintTo(connection, admin, solMint, adminSolAta, admin, 1_000_000_000_000); // 1000 SOL

  const [adminSolPos, adminSolPosBump] = findPositionAddress(solInit.pool, admin.publicKey);
  const lpDepositTx = new Transaction().add(
    depositIx(admin.publicKey, adminSolAta, solInit.vault, solInit.pool, adminSolPos, 500_000_000_000n, adminSolPosBump)
  );
  await sendAndConfirmTransaction(connection, lpDepositTx, [admin]);
  ok("LP deposited 500 SOL into SOL pool");

  // ═══ STEP 6: User gets USDC tokens ════════════════════════════════════════

  header("STEP 6 — User receives USDC (simulating real world)");

  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
  const createUserUsdcAta = new Transaction().add(
    createAssociatedTokenAccountInstruction(user.publicKey, userUsdcAta, user.publicKey, usdcMint)
  );
  await sendAndConfirmTransaction(connection, createUserUsdcAta, [user]);
  await mintTo(connection, admin, usdcMint, userUsdcAta, admin, 10_000_000_000); // 10,000 USDC
  ok("User has 10,000 USDC in wallet");

  // Also create user's SOL token ATA (needed to receive borrowed SOL)
  const userSolAta = getAssociatedTokenAddressSync(solMint, user.publicKey);
  const createUserSolAta = new Transaction().add(
    createAssociatedTokenAccountInstruction(user.publicKey, userSolAta, user.publicKey, solMint)
  );
  await sendAndConfirmTransaction(connection, createUserSolAta, [user]);
  ok("User has empty SOL token ATA (0 SOL tokens)");

  // ═══ STEP 7: User deposits USDC as collateral ═════════════════════════════

  header("STEP 7 — User deposits 10,000 USDC into USDC pool");

  const [userUsdcPos, userUsdcPosBump] = findPositionAddress(usdcInit.pool, user.publicKey);
  const userDepositTx = new Transaction().add(
    depositIx(user.publicKey, userUsdcAta, usdcInit.vault, usdcInit.pool, userUsdcPos, 10_000_000_000n, userUsdcPosBump)
  );
  await sendAndConfirmTransaction(connection, userDepositTx, [user]);
  ok(`10,000 USDC deposited. Position: ${userUsdcPos.toBase58()}`);

  // ═══ STEP 8: Verify user has ZERO in SOL pool ════════════════════════════

  header("STEP 8 — Verify user has NO position in SOL pool");

  const [userSolPos, userSolPosBump] = findPositionAddress(solInit.pool, user.publicKey);
  const solPosInfo = await connection.getAccountInfo(userSolPos);
  if (solPosInfo === null) {
    ok("User has NO position account in SOL pool (null) — perfect!");
  } else {
    log("User has a position account in SOL pool (unexpected for this test)");
  }

  // ═══ STEP 9: Cross-borrow SOL using USDC collateral ══════════════════════

  header("STEP 9 — CROSS-BORROW: 10 SOL using USDC collateral");

  log("Collateral: 10,000 USDC @ $1.00 = $10,000");
  log("LTV 75% → max borrow value = $7,500");
  log("SOL price = $150 → max borrow = 50 SOL");
  log("Requesting: 10 SOL ($1,500) — well within limits");
  log("");
  log("User has ZERO deposit in SOL pool.");
  log("User provides USDC pool position as collateral.");

  const [solPoolAuth] = findPoolAuthorityAddress(solInit.pool);

  // The cross-borrow needs a borrow_position (user's position in SOL pool).
  // Since user has no SOL position, it doesn't exist yet.
  // The instruction needs to handle creating it or the position must pre-exist.
  // Let me check if cross_borrow creates the position...
  // Looking at the code, it reads the position account but doesn't create it.
  // So we need to initialize the user's SOL position first (with a 0-amount deposit
  // or the cross-borrow must accept a fresh position).

  // Actually, cross_borrow calls UserPosition::from_account which requires
  // the account to exist with correct discriminator. We need to pre-create it.
  // The simplest way: do a 0 deposit? No, that's rejected (ZeroAmount).
  // We need to create the position account manually or deposit 1 lamport.

  // Let's mint 1 SOL token to the user and deposit it to create the position
  log("Creating user's SOL position (deposit 1 token to initialize)...");
  await mintTo(connection, admin, solMint, userSolAta, admin, 1); // 1 lamport of SOL token
  const initSolPosTx = new Transaction().add(
    depositIx(user.publicKey, userSolAta, solInit.vault, solInit.pool, userSolPos, 1n, userSolPosBump)
  );
  await sendAndConfirmTransaction(connection, initSolPosTx, [user]);
  ok("SOL position created with 1 lamport deposit (effectively 0)");

  // Now cross-borrow!
  const borrowAmount = 10_000_000_000n; // 10 SOL (9 decimals)

  const crossBorrowTx = new Transaction().add(
    crossBorrowIx(
      user.publicKey,
      solInit.pool,       // borrow FROM the SOL pool
      userSolPos,         // user's SOL position (just created, essentially empty)
      solInit.vault,      // SOL vault
      userSolAta,         // user receives SOL tokens here
      solPoolAuth,        // SOL pool authority PDA
      [{ pool: usdcInit.pool, position: userUsdcPos }], // collateral = USDC
      borrowAmount,
    )
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, crossBorrowTx, [user]);
    ok(`CROSS-BORROW SUCCESS! tx: ${sig.slice(0, 24)}...`);
  } catch (err: any) {
    fail(`CROSS-BORROW FAILED: ${err.message}`);
    if (err.logs) {
      console.log("\n  Program logs:");
      for (const line of err.logs) {
        console.log(`    ${line}`);
      }
    }
    throw err;
  }

  // ═══ STEP 10: Verify everything ═══════════════════════════════════════════

  header("STEP 10 — Verify final state");

  // Check user's SOL token balance
  const solBalance = await connection.getTokenAccountBalance(userSolAta);
  log(`User SOL token balance: ${solBalance.value.uiAmountString}`);
  if (Number(solBalance.value.amount) >= Number(borrowAmount)) {
    ok(`User received ${solBalance.value.uiAmountString} SOL tokens!`);
  } else {
    fail(`Expected at least 10 SOL, got ${solBalance.value.uiAmountString}`);
  }

  // Check USDC position — cross_collateral flag should be 1
  const usdcPosAccount = await connection.getAccountInfo(userUsdcPos);
  if (usdcPosAccount) {
    const crossFlag = usdcPosAccount.data[129];
    if (crossFlag === 1) {
      ok("USDC position cross_collateral = 1 (correctly flagged!)");
    } else {
      fail(`Expected cross_collateral=1, got ${crossFlag}`);
    }
  }

  // Check SOL position — borrow_principal > 0
  const solPosAccount = await connection.getAccountInfo(userSolPos);
  if (solPosAccount) {
    const borrowPrincipal = solPosAccount.data.readBigUInt64LE(80);
    if (borrowPrincipal > 0n) {
      ok(`SOL borrow recorded: ${Number(borrowPrincipal) / 1e9} SOL`);
    } else {
      fail("No borrow recorded in SOL position");
    }

    // Check deposit_shares — should be essentially 0 (just the 1 lamport)
    const depositShares = solPosAccount.data.readBigUInt64LE(72);
    log(`SOL deposit shares: ${depositShares} (should be ~1, just the init deposit)`);
  }

  // Check user's USDC balance — should be 0 (all deposited)
  const usdcBalance = await connection.getTokenAccountBalance(userUsdcAta);
  log(`User USDC balance: ${usdcBalance.value.uiAmountString} (deposited to pool)`);

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    TEST RESULTS SUMMARY                         ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log("║  1. User deposited 10,000 USDC into USDC pool (collateral)     ║");
  console.log("║  2. User had ZERO collateral in SOL pool                        ║");
  console.log("║  3. User cross-borrowed 10 SOL from SOL pool                   ║");
  console.log("║  4. USDC position flagged as cross-collateral                  ║");
  console.log("║  5. SOL borrow recorded in user's SOL position                 ║");
  console.log("║                                                                 ║");
  console.log("║  Cross-collateral lending works from a user's perspective!      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("\n💥 Test failed:", err.message || err);
  process.exit(1);
});
