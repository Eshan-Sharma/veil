import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
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
import { updatePoolIx, depositIx, updateOraclePriceIx, borrowIx, mockFeesIx } from "../lib/veil/instructions";
import { findPositionAddress, findPoolAuthorityAddress } from "../lib/veil/pda";
import { WAD } from "../lib/veil/constants";
import * as fs from "fs";
import * as path from "path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FULL SETUP SCRIPT for Localnet/Devnet
 * 
 * 1. Creates a mock token mint.
 * 2. Initializes a Veil Lending Pool.
 * 3. Anchors a Pyth Price Feed (Oracle).
 * 4. Mints tokens to the payer.
 * 5. Performs an initial deposit.
 * 6. Performs a borrow.
 * 7. Injects mock fees for testing.
 */

async function main() {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const keypairPath = path.resolve("/Users/eshan/my-solana-testing-dev-wallet.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const payer = Keypair.fromSecretKey(secretKey);

  console.log("--- STARTING VEIL SETUP ---");
  console.log("Payer:", payer.publicKey.toBase58());

  // Airdrop if balance is low
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < 1000000000) {
    console.log("Funding account...");
    const sig = await connection.requestAirdrop(payer.publicKey, 2000000000);
    await connection.confirmTransaction(sig);
  }

  // 1. Create Mock Mint
  console.log("Creating mock mint...");
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  console.log("Mint created:", mint.toBase58());

  // 2. Initialize Pool
  console.log("Initializing pool...");
  const { tx: initTx, pool, poolAuthority, vault, poolBump, authorityBump } = buildInitializePoolTx({
    payer: payer.publicKey,
    authority: payer.publicKey,
    tokenMint: mint,
  });
  await sendAndConfirmTransaction(connection, initTx, [payer]);
  console.log("Pool initialized:", pool.toBase58());

  // 3. Update Pool Parameters
  console.log("Updating pool parameters...");
  const updateTx = new Transaction().add(
    updatePoolIx(
      payer.publicKey,
      pool,
      {
        baseRate: WAD / 10n, // 10%
        optimalUtilization: (WAD * 8n) / 10n, // 80%
        slope1: (WAD * 4n) / 100n, // 4%
        slope2: (WAD * 75n) / 100n, // 75%
        reserveFactor: (WAD * 2n) / 10n, // 20%
        ltv: (WAD * 75n) / 100n, // 75%
        liquidationThreshold: (WAD * 8n) / 10n, // 80%
        liquidationBonus: (WAD * 5n) / 100n, // 5%
        protocolLiqFee: (WAD * 1n) / 10n, // 10%
        closeFactor: WAD / 2n, // 50%
        flashFeeBps: 9n,
      }
    )
  );
  await sendAndConfirmTransaction(connection, updateTx, [payer]);
  console.log("Pool parameters updated.");

  // 4. Anchor Pyth Feed (Oracle)
  console.log("Anchoring Pyth feed...");
  const pythFeed = new PublicKey("H6ARHfE2SExveS69S4SsiXryAhGisW7pY9X7M29Gz9V6");
  try {
    const oracleTx = new Transaction().add(updateOraclePriceIx(pool, pythFeed));
    await sendAndConfirmTransaction(connection, oracleTx, [payer]);
    console.log("Oracle anchored successfully.");
  } catch (err) {
    console.warn("Oracle anchor failed (expected if on localnet). Continuing...");
  }

  // 5. Bootstrap: Mint tokens and Deposit
  console.log("Bootstrapping with initial deposit...");
  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const bootstrapTx = new Transaction();
  
  bootstrapTx.add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      userAta,
      payer.publicKey,
      mint
    )
  );
  
  await sendAndConfirmTransaction(connection, bootstrapTx, [payer]);
  await mintTo(connection, payer, mint, userAta, payer, 10_000_000_000); // 10k tokens

  // Deposit 5,000 tokens
  const [position, positionBump] = findPositionAddress(pool, payer.publicKey);
  const depositTx = new Transaction().add(
    depositIx(
      payer.publicKey,
      userAta,
      vault,
      pool,
      position,
      5_000_000_000n, // 5k tokens
      positionBump
    )
  );
  await sendAndConfirmTransaction(connection, depositTx, [payer]);
  console.log("Deposit complete.");

  // 6. Borrow some tokens
  console.log("Performing a borrow of 2,000 tokens...");
  const [authorityPda] = findPoolAuthorityAddress(pool);
  const borrowTx = new Transaction().add(
    borrowIx(
      payer.publicKey,
      userAta,
      vault,
      pool,
      position,
      authorityPda,
      2_000_000_000n // 2k tokens
    )
  );
  await sendAndConfirmTransaction(connection, borrowTx, [payer]);
  console.log("Borrow complete.");

  // 7. Inject mock fees for testing collection logic
  console.log("Injecting 100 mock fees for testing...");
  const mockFeesTx = new Transaction().add(mockFeesIx(payer.publicKey, pool));
  await sendAndConfirmTransaction(connection, mockFeesTx, [payer]);
  console.log("Mock fees injected.");
  
  console.log("Syncing with local API database...");
  try {
    const apiResponse = await fetch("http://localhost:3000/api/pools/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pool_address: pool.toBase58(),
        symbol: "MOCK",
        rpc: "http://127.0.0.1:8899"
      })
    });
    if (apiResponse.ok) {
      console.log("Database sync successful.");
    } else {
      console.warn("Database sync failed:", await apiResponse.text());
    }
  } catch (err) {
    console.warn("Could not connect to API for sync (is the dev server running?).");
  }

  console.log("--- SETUP COMPLETE ---");
  console.log("Pool is live with 5,000 deposits, 2,000 borrows, and 100 mock fees.");
  console.log("Treasury Token Account (for fee collection):", userAta.toBase58());
  console.log("Ready for showcase!");
}

main().catch(console.error);
