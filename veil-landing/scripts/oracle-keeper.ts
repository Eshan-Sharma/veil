/* Oracle keeper.
 *   Loops every INTERVAL_SECONDS, fetches /api/pools, and for each pool that
 *   has an anchored pyth_price_feed, sends an UpdateOraclePrice tx.
 *
 *   ENV:
 *     KEEPER_KEYPAIR        — JSON array of secret-key bytes (Solana CLI format)
 *                             OR base58 secret-key string.
 *     KEEPER_RPC            — RPC endpoint (defaults to NEXT_PUBLIC_SOLANA_RPC
 *                             or https://api.devnet.solana.com)
 *     KEEPER_INTERVAL_SEC   — seconds between rounds (default 30)
 *     KEEPER_API_BASE       — where to fetch /api/pools (default http://localhost:4321)
 *
 *   The keypair just pays tx fees — UpdateOraclePrice is permissionless.
 *   Run:   npm run keeper:oracle
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

config({ path: join(process.cwd(), ".env.local") });
void fileURLToPath; void dirname;

import { updateOraclePriceIx } from "../lib/veil/instructions";
import { clusterEnv } from "./_cluster";

interface ApiPool {
  pool_address: string;
  symbol: string | null;
  pyth_price_feed: string | null;
}

function loadKeypair(): Keypair {
  const raw = process.env.KEEPER_KEYPAIR;
  if (!raw) throw new Error("KEEPER_KEYPAIR not set");
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr: number[] = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

const INTERVAL = Math.max(5, Number(process.env.KEEPER_INTERVAL_SEC ?? 30));
const API_BASE = process.env.KEEPER_API_BASE ?? "http://localhost:4321";
const RPC = process.env.KEEPER_RPC ?? clusterEnv().rpc;

async function fetchPools(): Promise<ApiPool[]> {
  const res = await fetch(`${API_BASE}/api/pools`, { cache: "no-store" });
  if (!res.ok) throw new Error(`pools fetch ${res.status}`);
  const { pools } = await res.json() as { pools: ApiPool[] };
  return pools;
}

async function refreshPool(conn: Connection, payer: Keypair, pool: ApiPool): Promise<string> {
  if (!pool.pyth_price_feed) throw new Error("no anchored feed");
  const ix = updateOraclePriceIx(new PublicKey(pool.pool_address), new PublicKey(pool.pyth_price_feed));
  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function round(conn: Connection, payer: Keypair) {
  const pools = await fetchPools();
  const candidates = pools.filter((p) => p.pyth_price_feed);
  const tag = new Date().toISOString();
  if (candidates.length === 0) {
    console.log(`[${tag}] [keeper] no pools with anchored feeds (${pools.length} total)`);
    return;
  }
  for (const p of candidates) {
    try {
      const sig = await refreshPool(conn, payer, p);
      console.log(`[${tag}] [keeper] ✓ ${p.symbol ?? p.pool_address.slice(0, 6)} ${sig.slice(0, 10)}…`);
    } catch (e) {
      console.warn(`[${tag}] [keeper] ✗ ${p.symbol ?? p.pool_address.slice(0, 6)}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function main() {
  const payer = loadKeypair();
  const conn = new Connection(RPC, "confirmed");
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`[keeper] payer ${payer.publicKey.toBase58()}, balance ${(bal / 1e9).toFixed(4)} SOL`);
  console.log(`[keeper] RPC ${RPC}, API ${API_BASE}, interval ${INTERVAL}s`);

  // Run forever — exit on SIGINT
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await round(conn, payer);
    } catch (e) {
      console.warn(`[keeper] round failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
