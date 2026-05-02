/**
 * Pre-flight: verify on-chain devnet state matches the devnet DB.
 *
 *  - Program is deployed at the expected ID
 *  - Every DB pool row resolves to a real on-chain account
 *  - Pool params (mint, vault, authority) match between DB and chain
 *  - Oracle has been seeded (pyth_price_feed != 11111... and oracle_price > 0)
 *  - Pool has non-zero liquidity (sanity)
 *  - pool_admins has the seeded super_admin
 *  - No "localnet" cluster rows leaked into the devnet DB
 *
 * Exits non-zero on the first mismatch.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { neon } from "@neondatabase/serverless";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID!);
const SUPER_ADMIN = process.env.SUPER_ADMIN_PUBKEY!;
const CLUSTER = process.env.CLUSTER ?? "devnet";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let failed = 0;
const fail = (msg: string) => {
  console.log(`${RED}✗${RESET} ${msg}`);
  failed++;
};
const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`);
const warn = (msg: string) => console.log(`${YELLOW}!${RESET} ${msg}`);
const info = (msg: string) => console.log(`${DIM}  ${msg}${RESET}`);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const sql = neon(process.env.DATABASE_URL!);

  console.log(`Veil devnet pre-flight @ ${RPC}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Cluster: ${CLUSTER}`);
  console.log("");

  // ── 1. Program is deployed ──────────────────────────────────────────────
  const progAcc = await conn.getAccountInfo(PROGRAM_ID);
  if (!progAcc) fail("program not found on devnet");
  else if (!progAcc.executable) fail("program account is not executable");
  else ok(`program deployed (${progAcc.data.length} bytes, owner ${progAcc.owner.toBase58()})`);

  // ── 2. DB cluster hygiene ───────────────────────────────────────────────
  const byCluster: { cluster: string; n: number }[] = (await sql.query(
    "SELECT cluster, count(*)::int AS n FROM pools GROUP BY cluster",
  )) as never;
  const wrongClusterRows = byCluster.filter((r) => r.cluster !== CLUSTER);
  if (wrongClusterRows.length) {
    fail(
      `pools table has rows under non-${CLUSTER} cluster(s): ${wrongClusterRows
        .map((r) => `${r.cluster}=${r.n}`)
        .join(", ")}`,
    );
  } else {
    ok(`pools table is single-cluster (${CLUSTER})`);
  }

  // ── 3. super_admin seeded ───────────────────────────────────────────────
  const admins: { pubkey: string; role: string; revoked_at: string | null }[] =
    (await sql.query(
      "SELECT pubkey, role, revoked_at FROM pool_admins WHERE pubkey = $1",
      [SUPER_ADMIN],
    )) as never;
  if (!admins.length) fail(`SUPER_ADMIN ${SUPER_ADMIN} not seeded in pool_admins`);
  else if (admins[0].revoked_at) fail(`SUPER_ADMIN row is revoked`);
  else if (admins[0].role !== "super_admin") fail(`SUPER_ADMIN has wrong role: ${admins[0].role}`);
  else ok(`super_admin seeded (${SUPER_ADMIN.slice(0, 8)}…)`);

  // ── 4. Each pool: DB row exists on-chain, params align ──────────────────
  const pools: {
    pool_address: string;
    token_mint: string;
    symbol: string;
    authority: string;
    vault: string;
    pyth_price_feed: string | null;
    oracle_price: string | null;
    total_deposits: string;
    decimals: number;
  }[] = (await sql.query(
    "SELECT pool_address, token_mint, symbol, authority, vault, pyth_price_feed, oracle_price, total_deposits, decimals FROM pools WHERE cluster = $1 ORDER BY symbol",
    [CLUSTER],
  )) as never;

  if (!pools.length) fail("no pools in DB");
  else info(`${pools.length} pools in DB`);

  // Decode minimal pool layout — we only need the Address-typed fields.
  // Layout (from programs/src/state/lending_pool.rs): 8B disc, 32B authority,
  // 32B token_mint, 32B vault, …
  for (const p of pools) {
    const addr = new PublicKey(p.pool_address);
    const acc = await conn.getAccountInfo(addr);
    if (!acc) {
      fail(`${p.symbol}: DB pool ${p.pool_address} has NO on-chain account`);
      continue;
    }
    if (!acc.owner.equals(PROGRAM_ID)) {
      fail(`${p.symbol}: pool owned by ${acc.owner.toBase58()}, expected program`);
      continue;
    }
    if (acc.data.length < 8 + 32 * 3) {
      fail(`${p.symbol}: pool data too small (${acc.data.length}B)`);
      continue;
    }
    const data = acc.data;
    const onchainAuthority = new PublicKey(data.subarray(8, 40)).toBase58();
    const onchainMint = new PublicKey(data.subarray(40, 72)).toBase58();
    const onchainVault = new PublicKey(data.subarray(72, 104)).toBase58();

    const mismatches: string[] = [];
    if (onchainAuthority !== p.authority) mismatches.push(`authority ${onchainAuthority} ≠ DB ${p.authority}`);
    if (onchainMint !== p.token_mint) mismatches.push(`mint ${onchainMint} ≠ DB ${p.token_mint}`);
    if (onchainVault !== p.vault) mismatches.push(`vault ${onchainVault} ≠ DB ${p.vault}`);

    if (mismatches.length) {
      fail(`${p.symbol}: on-chain vs DB mismatch — ${mismatches.join("; ")}`);
      continue;
    }

    // Oracle anchored?
    const noOracle =
      !p.pyth_price_feed ||
      p.pyth_price_feed === "11111111111111111111111111111111" ||
      !p.oracle_price ||
      p.oracle_price === "0";
    if (noOracle) warn(`${p.symbol}: oracle not anchored (price=${p.oracle_price}, feed=${p.pyth_price_feed})`);

    const dep = BigInt(p.total_deposits);
    if (dep === 0n) warn(`${p.symbol}: zero liquidity (no seed deposit)`);

    const vaultAcc = await conn.getAccountInfo(new PublicKey(p.vault));
    if (!vaultAcc) fail(`${p.symbol}: vault ${p.vault} has NO on-chain account`);

    if (!mismatches.length && !noOracle && dep > 0n && vaultAcc) {
      ok(
        `${p.symbol.padEnd(5)} ${p.pool_address.slice(0, 8)}… mint=${p.token_mint.slice(0, 8)}… deposits=${(Number(dep) / 10 ** p.decimals).toFixed(2)}`,
      );
    }
  }

  // ── 5. Positions sanity (should be present iff setup ran with deposits) ──
  const positions: { n: number }[] = (await sql.query(
    "SELECT count(*)::int AS n FROM positions WHERE cluster = $1",
    [CLUSTER],
  )) as never;
  info(`positions: ${positions[0].n}`);

  console.log("");
  if (failed) {
    console.log(`${RED}${failed} check(s) failed${RESET}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}all checks passed${RESET}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
