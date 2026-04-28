/**
 * Sync pools + positions from localnet to the database.
 * Usage: npx tsx scripts/sync-pool.ts <pool1> [pool2] [pool3] ... [user_pubkey]
 *
 * The last argument is treated as the user pubkey if more than 1 arg is provided.
 * Clears old pools/positions first, then reads on-chain state and inserts.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { config } from "dotenv";
import { join } from "path";

config({ path: join(process.cwd(), ".env.local") });
neonConfig.webSocketConstructor = ws;

// Symbol lookup by known Pyth feeds (localnet mints are random, so we tag by oracle)
const PYTH_SYMBOL: Record<string, string> = {
  "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD": "USDC",
  "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL": "USDT",
  "H6ARHfE2SExveS69S4SsiXryAhGisW7pY9X7M29Gz9V6": "SOL",
};

// Reverse lookup: symbol → Pyth feed address (for localnet where oracle doesn't anchor)
const SYMBOL_PYTH: Record<string, string> = {
  USDC: "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD",
  USDT: "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL",
  SOL:  "H6ARHfE2SExveS69S4SsiXryAhGisW7pY9X7M29Gz9V6",
};

// Hardcoded oracle prices for localnet (no Pyth available)
const ORACLE_PRICES: Record<string, { price: number; conf: number; expo: number }> = {
  USDC: { price: 100000000, conf: 50000, expo: -8 },      // $1.00
  USDT: { price: 99990000, conf: 60000, expo: -8 },       // $0.9999
  SOL:  { price: 14000000000, conf: 5000000, expo: -8 },  // $140.00
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/sync-pool.ts <pool1> [pool2] ... [user_pubkey]");
    process.exit(1);
  }

  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { decodeLendingPool, decodeUserPosition, healthFactor } = await import("../lib/veil/state");
  const { findPositionAddress } = await import("../lib/veil/pda");

  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "http://127.0.0.1:8899";
  const conn = new Connection(rpc, "confirmed");

  // Parse args: pool addresses (optionally with :SYMBOL suffix) followed by optional user pubkey
  // Example: npx tsx scripts/sync-pool.ts POOL1:USDC POOL2:USDT POOL3:SOL USER_PUBKEY
  let userPubkey: string | undefined;
  let rawArgs: string[];

  if (args.length > 1) {
    // Last arg is user pubkey (no colon = not a pool:symbol pair)
    const last = args[args.length - 1];
    if (!last.includes(":")) {
      userPubkey = last;
      rawArgs = args.slice(0, -1);
    } else {
      rawArgs = args;
    }
  } else {
    rawArgs = args;
  }

  // Parse pool address and optional symbol hint
  const poolEntries = rawArgs.map((a) => {
    const [addr, sym] = a.split(":");
    return { addr, symbolHint: sym ?? undefined };
  });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL not set"); process.exit(1); }

  const dbPool = new Pool({ connectionString: dbUrl });
  const client = await dbPool.connect();

  try {
    // Clear stale data
    await client.query(`DELETE FROM positions`);
    await client.query(`DELETE FROM pools`);
    console.log("Cleared old DB data.");

    for (const entry of poolEntries) {
      const poolAddr = entry.addr;
      const poolPk = new PublicKey(poolAddr);
      const poolInfo = await conn.getAccountInfo(poolPk);
      if (!poolInfo) {
        console.warn(`Pool not found on-chain: ${poolAddr}, skipping.`);
        continue;
      }

      const p = decodeLendingPool(new Uint8Array(poolInfo.data));
      const pythAddr = p.pythPriceFeed.toBase58();
      const hasOracle = pythAddr !== "11111111111111111111111111111111";
      // Use hint first, then Pyth lookup, then fallback
      const symbol = entry.symbolHint ?? ((hasOracle && PYTH_SYMBOL[pythAddr]) || "UNKNOWN");

      // Use hardcoded oracle prices for localnet
      const oracleData = ORACLE_PRICES[symbol] ?? {
        price: Number(p.oraclePrice),
        conf: Number(p.oracleConf),
        expo: p.oracleExpo,
      };

      await client.query(
        `INSERT INTO pools (
          pool_address, token_mint, symbol, authority, vault,
          pool_bump, authority_bump, vault_bump, paused,
          total_deposits, total_borrows, accumulated_fees,
          supply_index, borrow_index,
          ltv_wad, liquidation_threshold_wad, liquidation_bonus_wad, protocol_liq_fee_wad,
          reserve_factor_wad, close_factor_wad,
          base_rate_wad, optimal_util_wad, slope1_wad, slope2_wad,
          flash_fee_bps, decimals,
          oracle_price, oracle_conf, oracle_expo, pyth_price_feed,
          last_synced_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14,
          $15, $16, $17, $18,
          $19, $20,
          $21, $22, $23, $24,
          $25, $26,
          $27, $28, $29, $30,
          now()
        )
        ON CONFLICT (pool_address) DO NOTHING`,
        [
          poolAddr, p.tokenMint.toBase58(), symbol, p.authority.toBase58(), p.vault.toBase58(),
          p.poolBump, p.authorityBump, p.vaultBump, p.paused,
          p.totalDeposits.toString(), p.totalBorrows.toString(), p.accumulatedFees.toString(),
          p.supplyIndex.toString(), p.borrowIndex.toString(),
          p.ltv.toString(), p.liquidationThreshold.toString(), p.liquidationBonus.toString(), p.protocolLiqFee.toString(),
          p.reserveFactor.toString(), p.closeFactor.toString(),
          p.baseRate.toString(), p.optimalUtilization.toString(), p.slope1.toString(), p.slope2.toString(),
          Number(p.flashFeeBps),
          symbol === "SOL" ? 9 : 6,
          oracleData.price, oracleData.conf, oracleData.expo,
          hasOracle ? pythAddr : (SYMBOL_PYTH[symbol] ?? null),
        ]
      );
      console.log(`Pool synced: ${symbol} (${poolAddr})`);

      // Sync position if user provided
      if (userPubkey) {
        const userPk = new PublicKey(userPubkey);
        const [positionPk] = findPositionAddress(poolPk, userPk);
        const posInfo = await conn.getAccountInfo(positionPk);
        if (posInfo) {
          const pos = decodeUserPosition(new Uint8Array(posInfo.data));
          const hf = healthFactor(
            pos.depositShares, p.supplyIndex,
            pos.borrowPrincipal, p.borrowIndex,
            pos.borrowIndexSnapshot, p.liquidationThreshold,
          );
          await client.query(
            `INSERT INTO positions (
              position_address, pool_address, owner,
              deposit_shares, borrow_principal,
              deposit_idx_snap, borrow_idx_snap,
              health_factor_wad, last_synced_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
            ON CONFLICT (position_address) DO UPDATE SET
              deposit_shares = EXCLUDED.deposit_shares,
              borrow_principal = EXCLUDED.borrow_principal,
              health_factor_wad = EXCLUDED.health_factor_wad,
              last_synced_at = now()`,
            [
              positionPk.toBase58(), poolAddr, userPubkey,
              pos.depositShares.toString(), pos.borrowPrincipal.toString(),
              pos.depositIndexSnapshot.toString(), pos.borrowIndexSnapshot.toString(),
              hf.toString(),
            ]
          );
          console.log(`  Position synced: ${positionPk.toBase58()}`);
        } else {
          console.log(`  No position found for ${userPubkey} in ${symbol}`);
        }
      }
    }
  } finally {
    client.release();
    await dbPool.end();
  }
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
