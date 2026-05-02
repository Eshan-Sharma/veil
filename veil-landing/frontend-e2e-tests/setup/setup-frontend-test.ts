/**
 * Pre-flight for the Playwright user-flow + admin-flow specs.
 *
 *  1. Fund test_user (~/tmp/test-user.json) with native SOL for fees
 *  2. Fund victim (~/tmp/test-victim.json) with native SOL
 *  3. Mint pool test tokens (SOL/USDC/USDT) to test_user's ATAs
 *  4. Plant victim's unhealthy position (BTC collateral → USDC debt → drop oracle)
 *  5. Print the planted state so the spec can assert on it
 *
 * Idempotent on re-run — skips already-funded transfers and skips deposit/borrow
 * if victim's position is already open.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { neon } from "@neondatabase/serverless";
import * as fs from "node:fs";
import {
  depositIx,
  initPositionIx,
  crossBorrowIx,
} from "../../lib/veil/instructions";
import { findPositionAddress, findPoolAuthorityAddress } from "../../lib/veil/pda";
import { mockOracleIx } from "../../scripts/_mock-instructions";
import { decodeUserPosition, decodeLendingPool, healthFactor } from "../../lib/veil/state";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER ?? "devnet";

function loadKp(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function ensureFunded(conn: Connection, payer: Keypair, who: PublicKey, targetSol: number) {
  const have = await conn.getBalance(who);
  const need = targetSol * LAMPORTS_PER_SOL;
  if (have >= need) {
    console.log(`  ${who.toBase58().slice(0, 8)}… already has ${(have / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    return;
  }
  const top = need - have;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: who, lamports: top }),
  );
  await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log(`  funded ${who.toBase58().slice(0, 8)}… +${(top / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
}

async function ensureAtaWithBalance(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  targetBaseUnits: bigint,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await conn.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
    );
    await sendAndConfirmTransaction(conn, tx, [payer]);
  }
  const acc = await getAccount(conn, ata);
  if (acc.amount >= targetBaseUnits) return ata;
  const need = targetBaseUnits - acc.amount;
  await mintTo(conn, payer, mint, ata, payer, Number(need));
  console.log(
    `  minted ${need} → ${owner.toBase58().slice(0, 8)}… (mint ${mint.toBase58().slice(0, 8)}…)`,
  );
  return ata;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const sql = neon(process.env.DATABASE_URL!);

  const adminPath = process.env.TEST_ADMIN_KEYPAIR ?? process.env.PAYER_KEYPAIR;
  const userPath = process.env.TEST_USER_KEYPAIR ?? "/tmp/test-user.json";
  const victimPath = process.env.TEST_VICTIM_KEYPAIR ?? "/tmp/test-victim.json";
  if (!adminPath) {
    throw new Error("TEST_ADMIN_KEYPAIR (or PAYER_KEYPAIR) env var not set; see .env.example");
  }
  const admin = loadKp(adminPath);
  const testUser = loadKp(userPath);
  const victim = loadKp(victimPath);

  console.log(`Frontend test pre-flight @ ${RPC}`);
  console.log(`Admin:     ${admin.publicKey.toBase58()}`);
  console.log(`Test user: ${testUser.publicKey.toBase58()}`);
  console.log(`Victim:    ${victim.publicKey.toBase58()}`);
  console.log("");

  // 1. Fund native SOL on test users
  console.log("Funding native SOL:");
  await ensureFunded(conn, admin, testUser.publicKey, 0.5);
  await ensureFunded(conn, admin, victim.publicKey, 0.3);

  // 2. Load pools from DB
  const pools = (await sql.query(
    "SELECT pool_address, token_mint, vault, symbol, decimals FROM pools WHERE cluster = $1",
    [CLUSTER],
  )) as { pool_address: string; token_mint: string; vault: string; symbol: string; decimals: number }[];
  const byS = (s: string) => pools.find((p) => p.symbol === s);
  const sol = byS("SOL")!;
  const usdc = byS("USDC")!;
  const usdt = byS("USDT")!;
  const btc = byS("BTC")!;
  if (!sol || !usdc || !usdt || !btc) throw new Error("missing required pool in DB");

  // 3. Mint test tokens to test_user
  console.log("\nMinting test tokens to test_user:");
  await ensureAtaWithBalance(conn, admin, new PublicKey(sol.token_mint), testUser.publicKey, 10_000_000_000n); // 10 SOL token
  await ensureAtaWithBalance(conn, admin, new PublicKey(usdt.token_mint), testUser.publicKey, 5_000_000_000n); // 5,000 USDT
  await ensureAtaWithBalance(conn, admin, new PublicKey(usdc.token_mint), testUser.publicKey, 5_000_000_000n); // 5,000 USDC (for repay headroom etc.)
  // Test user needs an empty BTC ATA so they can RECEIVE BTC borrowed cross-asset.
  // We don't pre-mint BTC to test_user.

  // Liquidator (test_user is also the liquidator) needs USDC ATA already funded
  // (above) AND a BTC ATA to receive seized collateral. Pre-create the empty ATA.
  const btcAtaUser = getAssociatedTokenAddressSync(new PublicKey(btc.token_mint), testUser.publicKey);
  if (!(await conn.getAccountInfo(btcAtaUser))) {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          btcAtaUser,
          testUser.publicKey,
          new PublicKey(btc.token_mint),
        ),
      ),
      [admin],
    );
    console.log(`  created BTC ATA for test_user`);
  }

  // 4. Plant victim's unhealthy position
  console.log("\nPlanting unhealthy position (victim):");
  const btcPool = new PublicKey(btc.pool_address);
  const usdcPool = new PublicKey(usdc.pool_address);
  const btcMint = new PublicKey(btc.token_mint);
  const btcVault = new PublicKey(btc.vault);
  const usdcVault = new PublicKey(usdc.vault);
  const [btcPos, btcPosBump] = findPositionAddress(btcPool, victim.publicKey);
  const [usdcPos, usdcPosBump] = findPositionAddress(usdcPool, victim.publicKey);
  const [usdcAuth] = findPoolAuthorityAddress(usdcPool);

  const btcPosInfo = await conn.getAccountInfo(btcPos);
  const usdcPosInfo = await conn.getAccountInfo(usdcPos);
  const alreadyPlanted = !!(btcPosInfo && usdcPosInfo);

  if (!alreadyPlanted) {
    // Mint 0.05 BTC to victim
    const btcAtaVictim = await ensureAtaWithBalance(conn, admin, btcMint, victim.publicKey, 5_000_000n);
    const usdcAtaVictim = getAssociatedTokenAddressSync(new PublicKey(usdc.token_mint), victim.publicKey);
    if (!(await conn.getAccountInfo(usdcAtaVictim))) {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,
            usdcAtaVictim,
            victim.publicKey,
            new PublicKey(usdc.token_mint),
          ),
        ),
        [admin],
      );
    }

    // Step a: deposit 0.05 BTC
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        depositIx(victim.publicKey, btcAtaVictim, btcVault, btcPool, btcPos, 5_000_000n, btcPosBump),
      ),
      [victim],
    );
    console.log("  victim deposited 0.05 BTC ($3,000 @ $60k)");

    // Step b: cross-borrow 1500 USDC against BTC ($3,000 × 70% LTV = $2,100 max → 1,500 USDC = $1,500)
    const ixs = [];
    ixs.push(initPositionIx(victim.publicKey, usdcPool, usdcPos, usdcPosBump));
    ixs.push(
      crossBorrowIx(
        victim.publicKey,
        usdcPool,
        usdcPos,
        usdcVault,
        usdcAtaVictim,
        usdcAuth,
        [{ pool: btcPool, position: btcPos }],
        1_500_000_000n, // 1500 USDC
      ),
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [victim]);
    console.log("  victim cross-borrowed 1,500 USDC against BTC (HF ≈ 1.5)");
  } else {
    console.log("  position already planted — skipping deposit/borrow");
  }

  // Step c: drop BTC oracle to $25,000 → makes HF ≈ 0.625 (under 1)
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(mockOracleIx(admin.publicKey, btcPool, 25_000_00n, -2)),
    [admin],
  );
  console.log("  admin dropped BTC oracle to $25,000 → victim's HF now ~0.625 (LIQUIDATABLE)");

  // 4b. Sync DB so the dapp's API routes see the planted state
  console.log("\nSyncing DB:");
  for (const pos of [btcPos, usdcPos]) {
    const info = await conn.getAccountInfo(pos);
    if (!info) continue;
    const decoded = decodeUserPosition(Buffer.from(info.data));
    const poolKey = pos.equals(btcPos) ? btcPool : usdcPool;
    const poolInfo = await conn.getAccountInfo(poolKey);
    if (!poolInfo) continue;
    const pool = decodeLendingPool(Buffer.from(poolInfo.data));
    const hf = healthFactor(
      decoded.depositShares, pool.supplyIndex,
      decoded.borrowPrincipal, pool.borrowIndex,
      decoded.borrowIndexSnapshot, pool.liquidationThreshold,
    );
    await sql.query(
      `INSERT INTO positions (cluster, position_address, pool_address, owner, deposit_shares, borrow_principal, deposit_idx_snap, borrow_idx_snap, health_factor_wad, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (cluster, position_address) DO UPDATE SET
         deposit_shares = EXCLUDED.deposit_shares,
         borrow_principal = EXCLUDED.borrow_principal,
         deposit_idx_snap = EXCLUDED.deposit_idx_snap,
         borrow_idx_snap = EXCLUDED.borrow_idx_snap,
         health_factor_wad = EXCLUDED.health_factor_wad,
         last_synced_at = now()`,
      [
        CLUSTER,
        pos.toBase58(),
        poolKey.toBase58(),
        victim.publicKey.toBase58(),
        decoded.depositShares.toString(),
        decoded.borrowPrincipal.toString(),
        decoded.depositIndexSnapshot.toString(),
        decoded.borrowIndexSnapshot.toString(),
        hf.toString(),
      ],
    );
    console.log(`  synced ${pos.toBase58().slice(0, 8)}… (HF=${hf.toString()})`);
  }
  // Update BTC pool's DB oracle to match the dropped on-chain price.
  const btcPoolInfoNow = await conn.getAccountInfo(btcPool);
  if (btcPoolInfoNow) {
    const decoded = decodeLendingPool(Buffer.from(btcPoolInfoNow.data));
    await sql.query(
      `UPDATE pools SET oracle_price = $1, oracle_expo = $2, last_synced_at = now() WHERE cluster = $3 AND pool_address = $4`,
      [decoded.oraclePrice.toString(), decoded.oracleExpo, CLUSTER, btcPool.toBase58()],
    );
    console.log(`  synced BTC pool oracle → $${(Number(decoded.oraclePrice) * 10 ** decoded.oracleExpo).toFixed(2)}`);
  }

  // 5. Print final state
  console.log("\n=== READY ===");
  console.log(`test_user pubkey: ${testUser.publicKey.toBase58()}`);
  console.log(`victim pubkey:    ${victim.publicKey.toBase58()}`);
  console.log(`unhealthy: BTC pool ${btcPool.toBase58()}, victim's BTC pos ${btcPos.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
