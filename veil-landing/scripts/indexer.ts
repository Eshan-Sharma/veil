/* Position indexer.
 *   Subscribes to Veil program-account changes for accounts matching the
 *   UserPosition discriminator (b"VEILPOS!") and upserts decoded snapshots
 *   plus a derived health_factor_wad into the `positions` table.
 *
 *   ENV:
 *     INDEXER_RPC            — RPC ws/http endpoint (default = NEXT_PUBLIC_SOLANA_RPC)
 *     NEXT_PUBLIC_VEIL_PROGRAM_ID
 *     DATABASE_URL           — Neon HTTP driver works for the indexer too
 *
 *   Run:   npm run keeper:indexer
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Pool, neonConfig } from "@neondatabase/serverless";
import bs58 from "bs58";
import ws from "ws";
import { config } from "dotenv";
import { join } from "node:path";

config({ path: join(process.cwd(), ".env.local") });
neonConfig.webSocketConstructor = ws;

import { decodeUserPosition, decodeLendingPool } from "../lib/veil/state";
import { POSITION_DISCRIMINATOR, POSITION_SIZE } from "../lib/veil/constants";
import { clusterEnv } from "./_cluster";

const env = clusterEnv();
const RPC = process.env.INDEXER_RPC ?? env.rpc;
if (!env.programId) {
  console.error("NEXT_PUBLIC_VEIL_PROGRAM_ID not set");
  process.exit(1);
}
const PROGRAM_ID = new PublicKey(env.programId);
const DATABASE_URL = env.databaseUrl;
const CLUSTER = env.cluster;

const WAD = 1_000_000_000_000_000_000n;

if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
const dbPool = new Pool({ connectionString: DATABASE_URL });

/** Cache of pool -> {liqThresholdWad, supplyIndex, borrowIndex} for fast HF computation.
 *  Refreshed on cache miss; the cache itself is cheap. */
const poolCache = new Map<string, { liq: bigint; sup: bigint; bor: bigint; expires: number }>();
const POOL_CACHE_MS = 30_000;

async function getPoolFacts(conn: Connection, poolAddr: PublicKey): Promise<{ liq: bigint; sup: bigint; bor: bigint } | null> {
  const key = poolAddr.toBase58();
  const cached = poolCache.get(key);
  if (cached && cached.expires > Date.now()) return cached;
  const info = await conn.getAccountInfo(poolAddr);
  if (!info) return null;
  try {
    const p = decodeLendingPool(Buffer.from(info.data));
    const facts = { liq: p.liquidationThreshold, sup: p.supplyIndex, bor: p.borrowIndex };
    poolCache.set(key, { ...facts, expires: Date.now() + POOL_CACHE_MS });
    return facts;
  } catch (e) {
    console.warn(`[indexer] decode pool ${key.slice(0, 6)}…: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function computeHF(
  depositShares: bigint, supplyIndex: bigint,
  borrowPrincipal: bigint, currentBorrowIndex: bigint, snapshotIndex: bigint,
  liquidationThreshold: bigint,
): bigint {
  const collateral = (depositShares * supplyIndex) / WAD;
  if (borrowPrincipal === 0n) return 1n << 127n; // sentinel "very healthy"
  if (snapshotIndex === 0n) return 1n << 127n;
  const debt = (borrowPrincipal * currentBorrowIndex) / snapshotIndex;
  if (debt === 0n) return 1n << 127n;

  return (collateral * liquidationThreshold) / debt;
}

async function upsertPosition(
  positionAddr: PublicKey,
  data: Buffer,
  conn: Connection,
) {
  const pos = decodeUserPosition(data);
  const facts = await getPoolFacts(conn, pos.pool);
  if (!facts) return;
  const hf = computeHF(
    pos.depositShares, facts.sup,
    pos.borrowPrincipal, facts.bor, pos.borrowIndexSnapshot,
    facts.liq,
  );
  const client = await dbPool.connect();
  try {
    await client.query(
      `INSERT INTO positions (
         cluster, position_address, pool_address, owner,
         deposit_shares, borrow_principal,
         deposit_idx_snap, borrow_idx_snap,
         health_factor_wad, last_synced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (cluster, position_address) DO UPDATE SET
         deposit_shares    = EXCLUDED.deposit_shares,
         borrow_principal  = EXCLUDED.borrow_principal,
         deposit_idx_snap  = EXCLUDED.deposit_idx_snap,
         borrow_idx_snap   = EXCLUDED.borrow_idx_snap,
         health_factor_wad = EXCLUDED.health_factor_wad,
         last_synced_at    = now()`,
      [
        CLUSTER,
        positionAddr.toBase58(),
        pos.pool.toBase58(),
        pos.owner.toBase58(),
        pos.depositShares.toString(),
        pos.borrowPrincipal.toString(),
        pos.depositIndexSnapshot.toString(),
        pos.borrowIndexSnapshot.toString(),
        hf.toString(),
      ],
    );
  } finally {
    client.release();
  }
}

async function backfillExisting(conn: Connection): Promise<number> {
  // memcmp at offset 0 == "VEILPOS!"
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: POSITION_SIZE },
      { memcmp: { offset: 0, bytes: bs58encode(POSITION_DISCRIMINATOR) } },
    ],
  });
  for (const a of accounts) {
    try { await upsertPosition(a.pubkey, Buffer.from(a.account.data), conn); }
    catch (e) { console.warn(`[indexer] backfill ${a.pubkey.toBase58().slice(0, 6)}…: ${e instanceof Error ? e.message : e}`); }
  }
  return accounts.length;
}

function bs58encode(buf: Buffer): string {
  return bs58.encode(new Uint8Array(buf));
}

async function main() {
  console.log(`[indexer] RPC ${RPC}`);
  console.log(`[indexer] PROGRAM_ID ${PROGRAM_ID.toBase58()}`);
  const conn = new Connection(RPC, "confirmed");

  const n = await backfillExisting(conn);
  console.log(`[indexer] backfilled ${n} positions`);

  const subId = conn.onProgramAccountChange(
    PROGRAM_ID,
    (info) => {
      const data = Buffer.from(info.accountInfo.data);
      if (data.length !== POSITION_SIZE) return;
      if (data.subarray(0, 8).compare(POSITION_DISCRIMINATOR) !== 0) return;
      void upsertPosition(info.accountId, data, conn).catch((e) =>
        console.warn(`[indexer] upsert ${info.accountId.toBase58().slice(0, 6)}…: ${e instanceof Error ? e.message : e}`)
      );
    },
    "confirmed",
    [
      { dataSize: POSITION_SIZE },
      { memcmp: { offset: 0, bytes: bs58encode(POSITION_DISCRIMINATOR) } },
    ],
  );
  console.log(`[indexer] subscribed (id=${subId})`);

  // Heartbeat
  setInterval(() => console.log(`[indexer] alive · cache ${poolCache.size} pools`), 60_000);

  // Keep alive
  await new Promise(() => { /* eternal */ });
}

main().catch((e) => { console.error(e); process.exit(1); });
