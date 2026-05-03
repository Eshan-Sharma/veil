/**
 * Bootstrap BTC and ETH pools on localnet (or devnet) with mock oracles.
 *
 * Run after `setup-localnet.ts` so the dApp shows BTC/ETH alongside SOL/USDC.
 *
 * What it does, per pool:
 *   1. Creates an SPL test mint (8 dec for BTC, 9 dec for ETH).
 *   2. `Initialize` the pool PDA + vault.
 *   3. `UpdatePool` with conservative LTV / liq-threshold tuned for volatility.
 *   4. `mockOracleIx` — sets a realistic oracle price (BTC=$60k, ETH=$3k).
 *      The mockOracle disc is gated by the `testing` cargo feature, so this
 *      only works on a localnet build of the program (or a devnet build that
 *      explicitly opted into testing instructions).
 *   5. Mints test tokens to the payer and seeds a baseline deposit so flash
 *      loans and cross-borrow demos have liquidity.
 *   6. Syncs the new pool + position rows into Postgres.
 *
 * Why the pool is "Ika" only by tag:
 *   The on-chain `LendingPool` is generic SPL. BTC/ETH are tagged "ika" in
 *   `app/dapp/lib/tokens.ts` so the dApp shows the dWallet setup modal
 *   instead of a plain Supply button. The dWallet flow itself happens on
 *   the Ika program (devnet only — pre-alpha is not deployed on localnet),
 *   so on localnet the dWallet step is best demoed by recording against
 *   devnet, while the rest (deposit, borrow, flash) demos cleanly here.
 */

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
  setIkaCollateralCapIx,
} from "../lib/veil/instructions";
import { mockOracleIx } from "./_mock-instructions";
import { findPositionAddress } from "../lib/veil/pda";
import { WAD } from "../lib/veil/constants";

const RPC = process.env.RPC_URL ?? process.env.RPC ?? "http://127.0.0.1:8899";
const CLUSTER = process.env.CLUSTER ?? "localnet";

type IkaPoolConfig = {
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
  /** Mock oracle price in raw integer × 10^expo. */
  mockPrice: bigint;
  mockExpo: number;
  depositAmount: bigint;
  /** Per-position USD cap (cents) for Ika dWallet registrations on this pool. */
  maxIkaUsdCents: bigint;
};

// BTC: $60,000 → 60_000 × 10^-2 with expo -2, but using -8 to match Pyth
// convention so token_to_usd_wad produces correct WAD values. price = 60_000
// × 10^8 = 6_000_000_000_000. Confirmed with `token_to_usd_wad(amount=1e8,
// price=6e12, expo=-8, decimals=8) = $60,000 WAD`.
const BTC_PRICE_8DP = 6_000_000_000_000n;
// ETH: $3,000 → 3_000 × 10^8 = 300_000_000_000.
const ETH_PRICE_8DP = 300_000_000_000n;

const POOLS: IkaPoolConfig[] = [
  {
    symbol: "BTC",
    decimals: 8,
    baseRate: (WAD * 1n) / 100n,        // 1%
    optimalUtil: (WAD * 70n) / 100n,    // 70% (BTC liquidity is thinner)
    slope1: (WAD * 4n) / 100n,          // 4%
    slope2: (WAD * 100n) / 100n,        // 100% above kink
    reserveFactor: (WAD * 15n) / 100n,  // 15%
    ltv: (WAD * 70n) / 100n,            // 70% (volatile asset)
    liqThreshold: (WAD * 75n) / 100n,   // 75%
    liqBonus: (WAD * 8n) / 100n,        // 8%
    protocolLiqFee: (WAD * 10n) / 100n, // 10%
    closeFactor: WAD / 2n,              // 50%
    flashFeeBps: 9n,
    mockPrice: BTC_PRICE_8DP,
    mockExpo: -8,
    depositAmount: 100_000_000n,        // 1 BTC (8 decimals)
    // $250k cap per dWallet — generous for a single position, prevents
    // u64::MAX inflation if a malicious caller bypasses frontend bounds.
    maxIkaUsdCents: 25_000_000n,
  },
  {
    symbol: "ETH",
    decimals: 9,
    baseRate: (WAD * 1n) / 100n,        // 1%
    optimalUtil: (WAD * 75n) / 100n,    // 75%
    slope1: (WAD * 4n) / 100n,          // 4%
    slope2: (WAD * 90n) / 100n,         // 90% above kink
    reserveFactor: (WAD * 12n) / 100n,  // 12%
    ltv: (WAD * 72n) / 100n,            // 72%
    liqThreshold: (WAD * 78n) / 100n,   // 78%
    liqBonus: (WAD * 7n) / 100n,        // 7%
    protocolLiqFee: (WAD * 10n) / 100n, // 10%
    closeFactor: WAD / 2n,              // 50%
    flashFeeBps: 9n,
    mockPrice: ETH_PRICE_8DP,
    mockExpo: -8,
    depositAmount: 10_000_000_000n,     // 10 ETH (9 decimals)
    // $100k cap per dWallet (ETH cap lower than BTC reflects depth).
    maxIkaUsdCents: 10_000_000n,
  },
];

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keypairPath = process.env.PAYER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const payer = Keypair.fromSecretKey(secretKey);

  console.log("=== VEIL IKA POOL SETUP (BTC + ETH) ===");
  console.log("RPC:   ", RPC);
  console.log("Payer: ", payer.publicKey.toBase58());
  console.log("");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set — run `npm run db:migrate` first");
  const sql = neon(dbUrl);

  const results: { symbol: string; pool: string; mint: string }[] = [];

  for (const cfg of POOLS) {
    console.log(`--- ${cfg.symbol} pool ---`);

    const mint = await createMint(connection, payer, payer.publicKey, null, cfg.decimals);
    console.log(`  Mint:   ${mint.toBase58()}`);

    const { tx: initTx, pool, vault } = buildInitializePoolTx({
      payer: payer.publicKey,
      authority: payer.publicKey,
      tokenMint: mint,
    });
    await sendAndConfirmTransaction(connection, initTx, [payer]);
    console.log(`  Pool:   ${pool.toBase58()}`);

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
      }),
    );
    await sendAndConfirmTransaction(connection, updateTx, [payer]);
    console.log(`  Params: LTV=${(Number(cfg.ltv) / 1e16).toFixed(0)}%  liqTh=${(Number(cfg.liqThreshold) / 1e16).toFixed(0)}%`);

    // Mock oracle — $60k BTC / $3k ETH
    const oracleTx = new Transaction().add(
      mockOracleIx(payer.publicKey, pool, cfg.mockPrice, cfg.mockExpo),
    );
    await sendAndConfirmTransaction(connection, oracleTx, [payer]);
    console.log(`  Oracle: $${(Number(cfg.mockPrice) / 10 ** -cfg.mockExpo).toLocaleString()} (mock)`);

    // Opt the pool into Ika collateral with a per-position USD cap.
    const capTx = new Transaction().add(
      setIkaCollateralCapIx(payer.publicKey, pool, cfg.maxIkaUsdCents),
    );
    await sendAndConfirmTransaction(connection, capTx, [payer]);
    console.log(`  IkaCap: $${(Number(cfg.maxIkaUsdCents) / 100).toLocaleString()} per position`);

    // Mint + ATA
    const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, userAta, payer.publicKey, mint),
    );
    await sendAndConfirmTransaction(connection, ataTx, [payer]);
    const totalMint = cfg.depositAmount * 5n;
    await mintTo(connection, payer, mint, userAta, payer, Number(totalMint));
    console.log(`  Minted: ${totalMint} base units`);

    // Seed liquidity so flash + cross-borrow demos have something to draw from.
    const [position, positionBump] = findPositionAddress(pool, payer.publicKey);
    const depositTx = new Transaction().add(
      depositIx(payer.publicKey, userAta, vault, pool, position, cfg.depositAmount, positionBump),
    );
    await sendAndConfirmTransaction(connection, depositTx, [payer]);
    console.log(`  Seeded: ${cfg.depositAmount} base units (single depositor)`);

    // Sync pool + position to Postgres so the dApp picks them up.
    const info = await connection.getAccountInfo(pool);
    if (!info) throw new Error("Pool account not found after init");
    const { decodeLendingPool, decodeUserPosition } = await import("../lib/veil/state");
    const p = decodeLendingPool(Buffer.from(info.data));
    const pythFeed = p.pythPriceFeed.toBase58();
    const hasOracle = pythFeed !== "11111111111111111111111111111111";

    await sql`
      INSERT INTO pools (
        cluster, pool_address, token_mint, symbol, authority, vault,
        pool_bump, authority_bump, vault_bump, paused,
        total_deposits, total_borrows, accumulated_fees,
        ltv_wad, liquidation_threshold_wad, liquidation_bonus_wad, protocol_liq_fee_wad,
        reserve_factor_wad, close_factor_wad,
        base_rate_wad, optimal_util_wad, slope1_wad, slope2_wad,
        flash_fee_bps, decimals,
        oracle_price, oracle_conf, oracle_expo, pyth_price_feed,
        last_synced_at
      ) VALUES (
        ${CLUSTER}, ${pool.toBase58()}, ${p.tokenMint.toBase58()}, ${cfg.symbol},
        ${p.authority.toBase58()}, ${p.vault.toBase58()},
        ${p.poolBump}, ${p.authorityBump}, ${p.vaultBump},
        ${p.paused},
        ${p.totalDeposits.toString()}, ${p.totalBorrows.toString()}, ${p.accumulatedFees.toString()},
        ${p.ltv.toString()}, ${p.liquidationThreshold.toString()}, ${p.liquidationBonus.toString()}, ${p.protocolLiqFee.toString()},
        ${p.reserveFactor.toString()}, ${p.closeFactor.toString()},
        ${p.baseRate.toString()}, ${p.optimalUtilization.toString()}, ${p.slope1.toString()}, ${p.slope2.toString()},
        ${Number(p.flashFeeBps)}, ${cfg.decimals},
        ${p.oraclePrice.toString()}, ${p.oracleConf.toString()}, ${p.oracleExpo},
        ${hasOracle ? pythFeed : null},
        now()
      )
      ON CONFLICT (cluster, pool_address) DO UPDATE SET
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
        oracle_price = EXCLUDED.oracle_price,
        oracle_conf = EXCLUDED.oracle_conf,
        oracle_expo = EXCLUDED.oracle_expo,
        pyth_price_feed = EXCLUDED.pyth_price_feed,
        paused = EXCLUDED.paused,
        last_synced_at = now()
    `;

    const posInfo = await connection.getAccountInfo(position);
    if (posInfo) {
      const pos = decodeUserPosition(Buffer.from(posInfo.data));
      await sql`
        INSERT INTO positions (cluster, position_address, pool_address, owner, deposit_shares, borrow_principal, last_synced_at)
        VALUES (${CLUSTER}, ${position.toBase58()}, ${pool.toBase58()}, ${payer.publicKey.toBase58()},
                ${pos.depositShares.toString()}, ${pos.borrowPrincipal.toString()}, now())
        ON CONFLICT (cluster, position_address) DO UPDATE SET
          deposit_shares = EXCLUDED.deposit_shares,
          borrow_principal = EXCLUDED.borrow_principal,
          last_synced_at = now()
      `;
    }

    results.push({ symbol: cfg.symbol, pool: pool.toBase58(), mint: mint.toBase58() });
    console.log("");
  }

  await sql`
    INSERT INTO audit_log (cluster, actor, action, target, details)
    VALUES (${CLUSTER}, ${payer.publicKey.toBase58()}, 'ika_pool_setup', 'system',
            ${JSON.stringify({ pools: results })}::jsonb)
  `;

  console.log("=== IKA POOLS READY ===");
  for (const r of results) {
    console.log(`${r.symbol.padEnd(4)} pool=${r.pool}  mint=${r.mint}`);
  }
  console.log("");
  console.log("Note: dWallet creation (step 1 of IkaSetupModal) calls the");
  console.log("Ika pre-alpha network at pre-alpha-dev-1.ika.ika-network.net.");
  console.log("That requires devnet — record demos that reach DKG against devnet,");
  console.log("or stub the DKG step in tests.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
