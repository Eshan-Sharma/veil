import { config } from "dotenv";
import { join } from "path";

// Load .env.local BEFORE any veil lib imports (they read PROGRAM_ID at import time)
config({ path: join(process.cwd(), ".env.local") });

interface PoolConfig {
  symbol: string;
  decimals: number;
  depositAmount: bigint;    // raw token amount (~$50k worth)
  borrowAmount: bigint;     // raw token amount
  ltv: bigint;              // WAD-scaled
  liquidationThreshold: bigint;
  oraclePrice: bigint;      // mock oracle price (e.g. 100_000_000n = $1.00 at expo -8)
  oracleExpo: number;       // oracle exponent (e.g. -8)
  depositor: "payer" | "other"; // who deposits liquidity into this pool
}

async function main() {
  const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, createMint, mintTo } = await import("@solana/spl-token");
  const { buildInitializePoolTx } = await import("../lib/veil/initialize");
  const { updatePoolIx, depositIx, borrowIx, mockOracleIx, setPoolDecimalsIx } = await import("../lib/veil/instructions");
  const { findPositionAddress, findPoolAuthorityAddress } = await import("../lib/veil/pda");
  const { WAD, PROGRAM_ID } = await import("../lib/veil/constants");
  const fs = await import("fs");

  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const keypairPath = join(process.env.HOME ?? "~", "my-solana-testing-dev-wallet.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const payer = Keypair.fromSecretKey(secretKey);

  // Second wallet acts as a separate liquidity provider (e.g. for SOL pool)
  const otherAdmin = Keypair.generate();

  console.log("--- STARTING VEIL MULTI-POOL SETUP ---");
  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("Payer (super admin):", payer.publicKey.toBase58());
  console.log("Other admin:", otherAdmin.publicKey.toBase58());

  // Airdrop both wallets
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < 5_000_000_000) {
    console.log("Funding payer...");
    const sig = await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
    await connection.confirmTransaction(sig);
  }
  {
    console.log("Funding other admin...");
    const sig = await connection.requestAirdrop(otherAdmin.publicKey, 10_000_000_000);
    await connection.confirmTransaction(sig);
  }

  // Pool configurations
  // USDC & USDT: 6 decimals, 50,000 tokens = 50_000_000_000 raw
  // SOL: 9 decimals, ~357 SOL ≈ $50k at ~$140, = 357_000_000_000 raw
  const pools: PoolConfig[] = [
    {
      symbol: "USDC",
      decimals: 6,
      depositAmount: 50_000_000_000n,    // 50,000 USDC
      borrowAmount: 12_000_000_000n,     // 12,000 USDC
      ltv: (WAD * 80n) / 100n,           // 80%
      liquidationThreshold: (WAD * 85n) / 100n,
      oraclePrice: 100_000_000n,         // $1.00
      oracleExpo: -8,
      depositor: "payer",
    },
    {
      symbol: "USDT",
      decimals: 6,
      depositAmount: 50_000_000_000n,    // 50,000 USDT
      borrowAmount: 15_000_000_000n,     // 15,000 USDT
      ltv: (WAD * 80n) / 100n,
      liquidationThreshold: (WAD * 85n) / 100n,
      oraclePrice: 99_990_000n,          // $0.9999
      oracleExpo: -8,
      depositor: "payer",
    },
    {
      symbol: "SOL",
      decimals: 9,
      depositAmount: 357_000_000_000n,   // 357 SOL ≈ $50k
      borrowAmount: 71_000_000_000n,     // 71 SOL
      ltv: 1n,                           // effectively 0% — no collateral
      liquidationThreshold: 2n,          // must be > ltv to pass on-chain validation
      oraclePrice: 14_000_000_000n,      // $140.00
      oracleExpo: -8,
      depositor: "other",               // different admin provides SOL liquidity
    },
  ];

  const results: { symbol: string; pool: string; mint: string; user: string }[] = [];

  for (const cfg of pools) {
    console.log(`\n=== Setting up ${cfg.symbol} pool ===`);

    // 1. Create mock mint
    console.log(`  Creating ${cfg.symbol} mint (${cfg.decimals} decimals)...`);
    const mint = await createMint(connection, payer, payer.publicKey, null, cfg.decimals);
    console.log(`  Mint: ${mint.toBase58()}`);

    // 2. Initialize pool
    console.log(`  Initializing pool...`);
    const { tx: initTx, pool, vault } = buildInitializePoolTx({
      payer: payer.publicKey,
      authority: payer.publicKey,
      tokenMint: mint,
    });
    await sendAndConfirmTransaction(connection, initTx, [payer]);
    console.log(`  Pool: ${pool.toBase58()}`);

    // 3. Update pool parameters
    console.log(`  Setting risk parameters...`);
    const updateTx = new Transaction().add(
      updatePoolIx(payer.publicKey, pool, {
        baseRate: (WAD * 2n) / 100n,           // 2%
        optimalUtilization: (WAD * 80n) / 100n, // 80%
        slope1: (WAD * 4n) / 100n,              // 4%
        slope2: (WAD * 75n) / 100n,             // 75%
        reserveFactor: (WAD * 20n) / 100n,      // 20%
        ltv: cfg.ltv,
        liquidationThreshold: cfg.liquidationThreshold,
        liquidationBonus: (WAD * 5n) / 100n,    // 5%
        protocolLiqFee: (WAD * 10n) / 100n,     // 10%
        closeFactor: (WAD * 50n) / 100n,        // 50%
        flashFeeBps: 9n,
      })
    );
    await sendAndConfirmTransaction(connection, updateTx, [payer]);

    // 4. Set mock oracle price (requires program built with --features testing)
    console.log(`  Setting oracle: $${Number(cfg.oraclePrice) / 10 ** (-cfg.oracleExpo)}...`);
    const oracleTx = new Transaction().add(
      mockOracleIx(payer.publicKey, pool, cfg.oraclePrice, cfg.oracleExpo)
    );
    await sendAndConfirmTransaction(connection, oracleTx, [payer]);
    console.log(`  Oracle set.`);

    // 5. Set token decimals from mint
    console.log(`  Setting decimals (${cfg.decimals})...`);
    const decTx = new Transaction().add(
      setPoolDecimalsIx(payer.publicKey, pool, mint)
    );
    await sendAndConfirmTransaction(connection, decTx, [payer]);

    // 6. Create ATA, mint tokens, deposit (using the designated depositor)
    const depositor = cfg.depositor === "other" ? otherAdmin : payer;
    const depositorLabel = cfg.depositor === "other" ? "other admin" : "super admin";
    console.log(`  Minting & depositing ${cfg.symbol} (${depositorLabel})...`);
    const userAta = getAssociatedTokenAddressSync(mint, depositor.publicKey);
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, userAta, depositor.publicKey, mint)
    );
    await sendAndConfirmTransaction(connection, ataTx, [payer]);

    // Mint 2x deposit amount so we have tokens left after depositing
    const mintAmount = cfg.depositAmount * 2n;
    await mintTo(connection, payer, mint, userAta, payer, Number(mintAmount));

    const [position, positionBump] = findPositionAddress(pool, depositor.publicKey);
    const depositTx = new Transaction().add(
      depositIx(depositor.publicKey, userAta, vault, pool, position, cfg.depositAmount, positionBump)
    );
    await sendAndConfirmTransaction(connection, depositTx, [depositor]);
    console.log(`  Deposited ${Number(cfg.depositAmount) / 10 ** cfg.decimals} ${cfg.symbol}`);

    // 7. Borrow (skip if LTV is effectively zero — pool doesn't allow collateral)
    if (cfg.ltv > 10n) {
      console.log(`  Borrowing ${cfg.symbol}...`);
      const [authorityPda] = findPoolAuthorityAddress(pool);
      const borrowTx = new Transaction().add(
        borrowIx(depositor.publicKey, userAta, vault, pool, position, authorityPda, cfg.borrowAmount)
      );
      await sendAndConfirmTransaction(connection, borrowTx, [depositor]);
      console.log(`  Borrowed ${Number(cfg.borrowAmount) / 10 ** cfg.decimals} ${cfg.symbol}`);
    } else {
      console.log(`  Skipping borrow (no collateral for ${cfg.symbol}).`);
    }

    results.push({
      symbol: cfg.symbol,
      pool: pool.toBase58(),
      mint: mint.toBase58(),
      user: payer.publicKey.toBase58(),
    });
  }

  console.log("\n--- ON-CHAIN SETUP COMPLETE ---");
  console.log("\nPools created:");
  for (const r of results) {
    console.log(`  ${r.symbol}: ${r.pool} (mint: ${r.mint})`);
  }

  const poolArgs = results.map((r) => `${r.pool}:${r.symbol}`).join(" ");
  console.log(`\nSync all to database:`);
  console.log(`  npx tsx scripts/sync-pool.ts ${poolArgs} ${payer.publicKey.toBase58()}`);
}

main().catch(console.error);
