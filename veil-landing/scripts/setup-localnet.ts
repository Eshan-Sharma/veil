import * as path from "path";
import * as os from "os";
import * as fs from "fs";
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
  createMint,
  mintTo,
} from "@solana/spl-token";
import { neon } from "@neondatabase/serverless";
import { buildInitializePoolTx } from "../lib/veil/initialize";
import {
  updatePoolIx,
  depositIx,
  borrowIx,
} from "../lib/veil/instructions";
import { mockFeesIx } from "./_mock-instructions";
import { findPositionAddress, findPoolAuthorityAddress } from "../lib/veil/pda";
import { WAD } from "../lib/veil/constants";

const RPC = "http://127.0.0.1:8899";

type PoolConfig = {
  symbol: string;
  decimals: number;
  baseRate: bigint;
  optimalUtil: bigint;
  slope1: bigint;
  slope2: bigint;
  reserveFactor: bigint;
  ltv: bigint;
  liqThreshold: bigint;
  liqBonus: bigint;
  protocolLiqFee: bigint;
  closeFactor: bigint;
  flashFeeBps: bigint;
  depositAmount: bigint;
  borrowAmount: bigint;
};

const POOLS: PoolConfig[] = [
  {
    symbol: "SOL",
    decimals: 9,
    baseRate: (WAD * 1n) / 100n,       // 1%
    optimalUtil: (WAD * 80n) / 100n,   // 80%
    slope1: (WAD * 4n) / 100n,         // 4%
    slope2: (WAD * 75n) / 100n,        // 75%
    reserveFactor: (WAD * 10n) / 100n, // 10%
    ltv: (WAD * 75n) / 100n,           // 75%
    liqThreshold: (WAD * 80n) / 100n,  // 80%
    liqBonus: (WAD * 5n) / 100n,       // 5%
    protocolLiqFee: (WAD * 10n) / 100n,// 10%
    closeFactor: WAD / 2n,             // 50%
    flashFeeBps: 9n,
    depositAmount: 50_000_000_000n,    // 50 SOL
    borrowAmount: 20_000_000_000n,     // 20 SOL
  },
  {
    symbol: "USDC",
    decimals: 6,
    baseRate: (WAD * 2n) / 100n,       // 2%
    optimalUtil: (WAD * 85n) / 100n,   // 85%
    slope1: (WAD * 5n) / 100n,         // 5%
    slope2: (WAD * 60n) / 100n,        // 60%
    reserveFactor: (WAD * 15n) / 100n, // 15%
    ltv: (WAD * 80n) / 100n,           // 80%
    liqThreshold: (WAD * 85n) / 100n,  // 85%
    liqBonus: (WAD * 4n) / 100n,       // 4%
    protocolLiqFee: (WAD * 10n) / 100n,// 10%
    closeFactor: WAD / 2n,             // 50%
    flashFeeBps: 5n,
    depositAmount: 100_000_000_000n,   // 100,000 USDC
    borrowAmount: 60_000_000_000n,     // 60,000 USDC
  },
  {
    symbol: "USDT",
    decimals: 6,
    baseRate: (WAD * 2n) / 100n,       // 2%
    optimalUtil: (WAD * 85n) / 100n,   // 85%
    slope1: (WAD * 5n) / 100n,         // 5%
    slope2: (WAD * 60n) / 100n,        // 60%
    reserveFactor: (WAD * 15n) / 100n, // 15%
    ltv: (WAD * 78n) / 100n,           // 78%
    liqThreshold: (WAD * 83n) / 100n,  // 83%
    liqBonus: (WAD * 4n) / 100n,       // 4%
    protocolLiqFee: (WAD * 10n) / 100n,// 10%
    closeFactor: WAD / 2n,             // 50%
    flashFeeBps: 5n,
    depositAmount: 75_000_000_000n,    // 75,000 USDT
    borrowAmount: 40_000_000_000n,     // 40,000 USDT
  },
];

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = process.env.PAYER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const payer = Keypair.fromSecretKey(secretKey);

  console.log("=== VEIL LOCALNET SETUP ===");
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const sql = neon(dbUrl);

  const results: { symbol: string; pool: string; mint: string }[] = [];

  for (const cfg of POOLS) {
    console.log(`--- Setting up ${cfg.symbol} pool ---`);

    // 1. Create mint
    const mint = await createMint(connection, payer, payer.publicKey, null, cfg.decimals);
    console.log(`  Mint: ${mint.toBase58()}`);

    // 2. Initialize pool
    const { tx: initTx, pool, poolAuthority, vault } = buildInitializePoolTx({
      payer: payer.publicKey,
      authority: payer.publicKey,
      tokenMint: mint,
    });
    await sendAndConfirmTransaction(connection, initTx, [payer]);
    console.log(`  Pool: ${pool.toBase58()}`);

    // 3. Update parameters
    const updateTx = new Transaction().add(
      updatePoolIx(payer.publicKey, pool, {
        baseRate: cfg.baseRate,
        optimalUtilization: cfg.optimalUtil,
        slope1: cfg.slope1,
        slope2: cfg.slope2,
        reserveFactor: cfg.reserveFactor,
        ltv: cfg.ltv,
        liquidationThreshold: cfg.liqThreshold,
        liquidationBonus: cfg.liqBonus,
        protocolLiqFee: cfg.protocolLiqFee,
        closeFactor: cfg.closeFactor,
        flashFeeBps: cfg.flashFeeBps,
      })
    );
    await sendAndConfirmTransaction(connection, updateTx, [payer]);
    console.log(`  Parameters set.`);

    // 4. Create user ATA and mint tokens
    const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, userAta, payer.publicKey, mint)
    );
    await sendAndConfirmTransaction(connection, ataTx, [payer]);

    // Mint enough for deposit + borrow repay headroom
    const mintAmount = cfg.depositAmount * 3n;
    await mintTo(connection, payer, mint, userAta, payer, Number(mintAmount));
    console.log(`  Minted ${mintAmount} base units.`);

    // 5. Deposit
    const [position, positionBump] = findPositionAddress(pool, payer.publicKey);
    const depositTx = new Transaction().add(
      depositIx(payer.publicKey, userAta, vault, pool, position, cfg.depositAmount, positionBump)
    );
    await sendAndConfirmTransaction(connection, depositTx, [payer]);
    console.log(`  Deposited ${cfg.depositAmount} base units.`);

    // 6. Borrow
    const [authority] = findPoolAuthorityAddress(pool);
    const borrowTx = new Transaction().add(
      borrowIx(payer.publicKey, userAta, vault, pool, position, authority, cfg.borrowAmount)
    );
    await sendAndConfirmTransaction(connection, borrowTx, [payer]);
    console.log(`  Borrowed ${cfg.borrowAmount} base units.`);

    // 7. Mock fees
    const feesTx = new Transaction().add(mockFeesIx(payer.publicKey, pool));
    await sendAndConfirmTransaction(connection, feesTx, [payer]);
    console.log(`  Mock fees injected.`);

    // 8. Sync to DB
    // Read pool state and upsert directly
    const info = await connection.getAccountInfo(pool);
    if (!info) throw new Error("Pool account not found after init");
    const { decodeLendingPool } = await import("../lib/veil/state");
    const p = decodeLendingPool(Buffer.from(info.data));
    const pythFeed = p.pythPriceFeed.toBase58();
    const hasOracle = pythFeed !== "11111111111111111111111111111111";

    await sql`
      INSERT INTO pools (
        pool_address, token_mint, symbol, authority, vault,
        pool_bump, authority_bump, vault_bump, paused,
        total_deposits, total_borrows, accumulated_fees,
        ltv_wad, liquidation_threshold_wad, liquidation_bonus_wad, protocol_liq_fee_wad,
        reserve_factor_wad, close_factor_wad,
        base_rate_wad, optimal_util_wad, slope1_wad, slope2_wad,
        flash_fee_bps,
        oracle_price, oracle_conf, oracle_expo, pyth_price_feed,
        last_synced_at
      ) VALUES (
        ${pool.toBase58()}, ${p.tokenMint.toBase58()}, ${cfg.symbol},
        ${p.authority.toBase58()}, ${p.vault.toBase58()},
        ${p.poolBump}, ${p.authorityBump}, ${p.vaultBump},
        ${p.paused},
        ${p.totalDeposits.toString()}, ${p.totalBorrows.toString()}, ${p.accumulatedFees.toString()},
        ${p.ltv.toString()}, ${p.liquidationThreshold.toString()}, ${p.liquidationBonus.toString()}, ${p.protocolLiqFee.toString()},
        ${p.reserveFactor.toString()}, ${p.closeFactor.toString()},
        ${p.baseRate.toString()}, ${p.optimalUtilization.toString()}, ${p.slope1.toString()}, ${p.slope2.toString()},
        ${Number(p.flashFeeBps)},
        ${p.oraclePrice.toString()}, ${p.oracleConf.toString()}, ${p.oracleExpo},
        ${hasOracle ? pythFeed : null},
        now()
      )
      ON CONFLICT (pool_address) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        total_deposits = EXCLUDED.total_deposits,
        total_borrows = EXCLUDED.total_borrows,
        accumulated_fees = EXCLUDED.accumulated_fees,
        ltv_wad = EXCLUDED.ltv_wad,
        liquidation_threshold_wad = EXCLUDED.liquidation_threshold_wad,
        liquidation_bonus_wad = EXCLUDED.liquidation_bonus_wad,
        protocol_liq_fee_wad = EXCLUDED.protocol_liq_fee_wad,
        reserve_factor_wad = EXCLUDED.reserve_factor_wad,
        close_factor_wad = EXCLUDED.close_factor_wad,
        base_rate_wad = EXCLUDED.base_rate_wad,
        optimal_util_wad = EXCLUDED.optimal_util_wad,
        slope1_wad = EXCLUDED.slope1_wad,
        slope2_wad = EXCLUDED.slope2_wad,
        flash_fee_bps = EXCLUDED.flash_fee_bps,
        paused = EXCLUDED.paused,
        last_synced_at = now()
    `;
    console.log(`  Synced to database.`);

    // 9. Sync position to DB
    const posInfo = await connection.getAccountInfo(position);
    if (posInfo) {
      const { decodeUserPosition } = await import("../lib/veil/state");
      const pos = decodeUserPosition(Buffer.from(posInfo.data));
      await sql`
        INSERT INTO positions (position_address, pool_address, owner, deposit_shares, borrow_principal, last_synced_at)
        VALUES (${position.toBase58()}, ${pool.toBase58()}, ${payer.publicKey.toBase58()},
                ${pos.depositShares.toString()}, ${pos.borrowPrincipal.toString()}, now())
        ON CONFLICT (position_address) DO UPDATE SET
          deposit_shares = EXCLUDED.deposit_shares,
          borrow_principal = EXCLUDED.borrow_principal,
          last_synced_at = now()
      `;
      console.log(`  Position synced to database.`);
    }

    results.push({ symbol: cfg.symbol, pool: pool.toBase58(), mint: mint.toBase58() });
    console.log("");
  }

  // Log audit
  await sql`
    INSERT INTO audit_log (actor, action, target, details)
    VALUES (${payer.publicKey.toBase58()}, 'localnet_setup', 'system',
            ${JSON.stringify({ pools: results })}::jsonb)
  `;

  console.log("=== SETUP COMPLETE ===");
  console.log("");
  for (const r of results) {
    console.log(`${r.symbol}: pool=${r.pool} mint=${r.mint}`);
  }
  console.log("");
  console.log("Super admin:", payer.publicKey.toBase58());
  console.log("Start dev server: npm run dev");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
