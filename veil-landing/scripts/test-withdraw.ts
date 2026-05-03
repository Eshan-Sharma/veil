/**
 * Test withdraw at 25%, 50%, max on localnet — USDT pool (6 decimals).
 * Logs shares, token amounts, tx sigs, balances before/after.
 *
 * Usage: export $(grep -v '^#' .env.local | xargs) && npx tsx scripts/test-withdraw.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID!);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WAD = 1_000_000_000_000_000_000n;
const conn = new Connection("http://localhost:8899", "confirmed");

const KEYPAIR_PATH = process.env.PAYER_KEYPAIR ?? join(homedir(), ".config/solana/id.json");
const secret = JSON.parse(readFileSync(KEYPAIR_PATH, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

function readU64(d: Uint8Array, o: number) { return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true); }
function readU128(d: Uint8Array, o: number) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return (dv.getBigUint64(o + 8, true) << 64n) | dv.getBigUint64(o, true);
}
function u8(n: number) { return new Uint8Array([n]); }
function u64LE(n: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function concat(...p: Uint8Array[]) { const r = Buffer.alloc(p.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of p) { r.set(x, o); o += x.length; } return r; }
function findPos(pool: PublicKey, user: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), user.toBuffer()], PROGRAM_ID); }
function findAuth(pool: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("authority"), pool.toBuffer()], PROGRAM_ID); }

function withdrawIx(user: PublicKey, userToken: PublicKey, vault: PublicKey, pool: PublicKey, position: PublicKey, authority: PublicKey, shares: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: concat(u8(0x02), u64LE(shares)),
  });
}

async function decodePool(pk: PublicKey) {
  const info = await conn.getAccountInfo(pk);
  if (!info) throw new Error("Pool not found: " + pk.toBase58());
  const d = new Uint8Array(info.data);
  return {
    tokenMint: new PublicKey(d.slice(40, 72)), vault: new PublicKey(d.slice(72, 104)),
    totalDeposits: readU64(d, 104), totalBorrows: readU64(d, 112),
    supplyIndex: readU128(d, 160), borrowIndex: readU128(d, 144), liqThreshold: readU128(d, 272),
  };
}

async function decodePos(pk: PublicKey) {
  const info = await conn.getAccountInfo(pk);
  if (!info) throw new Error("Position not found: " + pk.toBase58());
  const d = new Uint8Array(info.data);
  return { depositShares: readU64(d, 72), borrowPrincipal: readU64(d, 80), borrowIdxSnap: readU128(d, 112) };
}

async function tokenBal(mint: PublicKey) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
    return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
  } catch { return 0n; }
}

function fmt(n: bigint, dec: number) { return (Number(n) / 10 ** dec).toFixed(dec > 4 ? 4 : dec); }

async function doWithdraw(poolPk: PublicKey, label: string, shares: bigint, decimals: number) {
  const pool = await decodePool(poolPk);
  const [posPk] = findPos(poolPk, payer.publicKey);
  const [authPk] = findAuth(poolPk);
  const pos = await decodePos(posPk);
  const userToken = getAssociatedTokenAddressSync(pool.tokenMint, payer.publicKey, false, TOKEN_PROGRAM_ID);

  const balBefore = await tokenBal(pool.tokenMint);
  const depTokens = (pos.depositShares * pool.supplyIndex) / WAD;
  const expectedTokens = (shares * pool.supplyIndex) / WAD;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  WITHDRAW ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Shares to withdraw:   ${shares} (${fmt(expectedTokens, decimals)} tokens)`);
  console.log(`  Total deposit shares: ${pos.depositShares} (${fmt(depTokens, decimals)} tokens)`);
  console.log(`  Wallet balance before: ${fmt(balBefore, decimals)}`);

  const ix = withdrawIx(payer.publicKey, userToken, pool.vault, poolPk, posPk, authPk, shares);
  const tx = new Transaction().add(ix);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    const balAfter = await tokenBal(pool.tokenMint);
    const posAfter = await decodePos(posPk);
    const depAfter = (posAfter.depositShares * pool.supplyIndex) / WAD;

    console.log(`  ✓ TX: ${sig}`);
    console.log(`  Tokens received:      ${fmt(balAfter - balBefore, decimals)}`);
    console.log(`  Wallet balance after:  ${fmt(balAfter, decimals)}`);
    console.log(`  Shares remaining:      ${posAfter.depositShares} (${fmt(depAfter, decimals)} tokens)`);
    console.log(`  Borrow principal:      ${posAfter.borrowPrincipal}`);
    return true;
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${e.message?.slice(0, 120)}`);
    if (e.logs) console.log(`  Logs: ${e.logs.filter((l: string) => l.includes("Error") || l.includes("failed")).join("\n        ")}`);
    return false;
  }
}

async function main() {
  // Use USDT pool (new addresses from setup-localnet)
  const USDT_POOL = new PublicKey("BBWRqo57x4phw8CKWysmeZird1txYBLdTyYLPes8UHF1");
  const DEC = 6;

  console.log("Wallet:", payer.publicKey.toBase58());
  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("USDT Pool:", USDT_POOL.toBase58());

  const pool = await decodePool(USDT_POOL);
  const [posPk] = findPos(USDT_POOL, payer.publicKey);
  const pos = await decodePos(posPk);
  const depTokens = (pos.depositShares * pool.supplyIndex) / WAD;
  const debt = pos.borrowPrincipal > 0n && pos.borrowIdxSnap > 0n
    ? (pos.borrowPrincipal * pool.borrowIndex) / pos.borrowIdxSnap : 0n;

  console.log("\n── USDT Pool State ──");
  console.log(`  Deposits: ${fmt(pool.totalDeposits, DEC)} | Borrows: ${fmt(pool.totalBorrows, DEC)}`);
  console.log(`  Supply idx: ${pool.supplyIndex} | Borrow idx: ${pool.borrowIndex}`);
  console.log(`  User shares: ${pos.depositShares} → ${fmt(depTokens, DEC)} tokens`);
  console.log(`  User debt:   ${pos.borrowPrincipal} → ${fmt(debt, DEC)} tokens`);

  // Compute max withdrawable shares (keep HF > 1.01)
  let maxShares = pos.depositShares;
  if (debt > 0n) {
    const minColl = (debt * WAD * 101n) / (pool.liqThreshold * 100n);
    const withdrawable = depTokens > minColl ? depTokens - minColl : 0n;
    maxShares = depTokens > 0n ? (pos.depositShares * withdrawable) / depTokens : 0n;
    console.log(`  Min collateral:  ${fmt(minColl, DEC)}`);
    console.log(`  Max withdrawable: ${fmt(withdrawable, DEC)} (${maxShares} shares)`);
  }

  // ── TEST 25% ──
  const s25 = maxShares * 25n / 100n;
  if (!(await doWithdraw(USDT_POOL, "25%", s25, DEC))) return;

  // ── TEST 50% of new max ──
  {
    const p = await decodePool(USDT_POOL);
    const pos2 = await decodePos(posPk);
    const dep2 = (pos2.depositShares * p.supplyIndex) / WAD;
    const d2 = pos2.borrowPrincipal > 0n && pos2.borrowIdxSnap > 0n
      ? (pos2.borrowPrincipal * p.borrowIndex) / pos2.borrowIdxSnap : 0n;
    let ms2 = pos2.depositShares;
    if (d2 > 0n) {
      const mc = (d2 * WAD * 101n) / (p.liqThreshold * 100n);
      const w = dep2 > mc ? dep2 - mc : 0n;
      ms2 = dep2 > 0n ? (pos2.depositShares * w) / dep2 : 0n;
    }
    const s50 = ms2 * 50n / 100n;
    if (!(await doWithdraw(USDT_POOL, "50%", s50, DEC))) return;
  }

  // ── TEST MAX ──
  {
    const p = await decodePool(USDT_POOL);
    const pos3 = await decodePos(posPk);
    const dep3 = (pos3.depositShares * p.supplyIndex) / WAD;
    const d3 = pos3.borrowPrincipal > 0n && pos3.borrowIdxSnap > 0n
      ? (pos3.borrowPrincipal * p.borrowIndex) / pos3.borrowIdxSnap : 0n;
    let ms3 = pos3.depositShares;
    if (d3 > 0n) {
      const mc = (d3 * WAD * 101n) / (p.liqThreshold * 100n);
      const w = dep3 > mc ? dep3 - mc : 0n;
      ms3 = dep3 > 0n ? (pos3.depositShares * w) / dep3 : 0n;
    }
    if (!(await doWithdraw(USDT_POOL, "MAX", ms3, DEC))) return;
  }

  // Final state
  {
    const p = await decodePool(USDT_POOL);
    const posF = await decodePos(posPk);
    const depF = (posF.depositShares * p.supplyIndex) / WAD;
    const dF = posF.borrowPrincipal > 0n && posF.borrowIdxSnap > 0n
      ? (posF.borrowPrincipal * p.borrowIndex) / posF.borrowIdxSnap : 0n;
    const bal = await tokenBal(p.tokenMint);
    console.log(`\n${"═".repeat(60)}`);
    console.log("  FINAL STATE");
    console.log(`${"═".repeat(60)}`);
    console.log(`  Shares remaining: ${posF.depositShares} → ${fmt(depF, DEC)} tokens`);
    console.log(`  Debt remaining:   ${posF.borrowPrincipal} → ${fmt(dF, DEC)} tokens`);
    console.log(`  Wallet balance:   ${fmt(bal, DEC)}`);
  }

  console.log("\nDONE ✓");
}

main().catch(e => { console.error(e); process.exit(1); });
