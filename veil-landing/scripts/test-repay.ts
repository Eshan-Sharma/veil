/**
 * Test repay at 25%, 50%, max on localnet — USDT pool (6 decimals).
 * Logs shares, debt, token amounts, tx sigs, balances before/after.
 *
 * Usage: export $(grep -v '^#' .env.local | xargs) && npx tsx scripts/test-repay.ts
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

function repayIx(user: PublicKey, userToken: PublicKey, vault: PublicKey, pool: PublicKey, position: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: concat(u8(0x04), u64LE(amount)),
  });
}

async function decodePool(pk: PublicKey) {
  const info = await conn.getAccountInfo(pk);
  if (!info) throw new Error("Pool not found: " + pk.toBase58());
  const d = new Uint8Array(info.data);
  return {
    tokenMint: new PublicKey(d.slice(40, 72)), vault: new PublicKey(d.slice(72, 104)),
    totalDeposits: readU64(d, 104), totalBorrows: readU64(d, 112),
    supplyIndex: readU128(d, 160), borrowIndex: readU128(d, 144),
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

async function doRepay(poolPk: PublicKey, label: string, amount: bigint, decimals: number) {
  const pool = await decodePool(poolPk);
  const [posPk] = findPos(poolPk, payer.publicKey);
  const pos = await decodePos(posPk);
  const userToken = getAssociatedTokenAddressSync(pool.tokenMint, payer.publicKey, false, TOKEN_PROGRAM_ID);

  const debt = pos.borrowPrincipal > 0n && pos.borrowIdxSnap > 0n
    ? (pos.borrowPrincipal * pool.borrowIndex) / pos.borrowIdxSnap : 0n;
  const balBefore = await tokenBal(pool.tokenMint);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  REPAY ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Amount to repay:      ${amount} (${fmt(amount, decimals)} tokens)`);
  console.log(`  Current debt:         ${pos.borrowPrincipal} principal → ${fmt(debt, decimals)} tokens`);
  console.log(`  Borrow idx snapshot:  ${pos.borrowIdxSnap}`);
  console.log(`  Current borrow idx:   ${pool.borrowIndex}`);
  console.log(`  Wallet balance before: ${fmt(balBefore, decimals)}`);

  const ix = repayIx(payer.publicKey, userToken, pool.vault, poolPk, posPk, amount);
  const tx = new Transaction().add(ix);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    const balAfter = await tokenBal(pool.tokenMint);
    const posAfter = await decodePos(posPk);
    const poolAfter = await decodePool(poolPk);
    const debtAfter = posAfter.borrowPrincipal > 0n && posAfter.borrowIdxSnap > 0n
      ? (posAfter.borrowPrincipal * poolAfter.borrowIndex) / posAfter.borrowIdxSnap : 0n;

    console.log(`  ✓ TX: ${sig}`);
    console.log(`  Tokens spent:         ${fmt(balBefore - balAfter, decimals)}`);
    console.log(`  Wallet balance after:  ${fmt(balAfter, decimals)}`);
    console.log(`  Debt remaining:        ${posAfter.borrowPrincipal} principal → ${fmt(debtAfter, decimals)} tokens`);
    console.log(`  Borrow idx snap after: ${posAfter.borrowIdxSnap}`);
    console.log(`  Pool total borrows:    ${fmt(poolAfter.totalBorrows, decimals)}`);
    return true;
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${e.message?.slice(0, 120)}`);
    if (e.logs) console.log(`  Logs: ${e.logs.filter((l: string) => l.includes("Error") || l.includes("failed")).join("\n        ")}`);
    return false;
  }
}

async function main() {
  const USDT_POOL = new PublicKey("BBWRqo57x4phw8CKWysmeZird1txYBLdTyYLPes8UHF1");
  const DEC = 6;

  console.log("Wallet:", payer.publicKey.toBase58());
  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("USDT Pool:", USDT_POOL.toBase58());

  const pool = await decodePool(USDT_POOL);
  const [posPk] = findPos(USDT_POOL, payer.publicKey);
  const pos = await decodePos(posPk);
  const debt = pos.borrowPrincipal > 0n && pos.borrowIdxSnap > 0n
    ? (pos.borrowPrincipal * pool.borrowIndex) / pos.borrowIdxSnap : 0n;

  console.log("\n── USDT Pool State ──");
  console.log(`  Deposits: ${fmt(pool.totalDeposits, DEC)} | Borrows: ${fmt(pool.totalBorrows, DEC)}`);
  console.log(`  Supply idx: ${pool.supplyIndex} | Borrow idx: ${pool.borrowIndex}`);
  console.log(`  User borrow principal: ${pos.borrowPrincipal} → ${fmt(debt, DEC)} tokens debt`);
  console.log(`  User deposit shares:   ${pos.depositShares}`);

  if (debt === 0n) {
    console.log("\n  No debt to repay — exiting.");
    return;
  }

  // ── TEST 25% of debt ──
  const r25 = debt * 25n / 100n;
  if (!(await doRepay(USDT_POOL, "25%", r25, DEC))) return;

  // ── TEST 50% of remaining debt ──
  {
    const p = await decodePool(USDT_POOL);
    const pos2 = await decodePos(posPk);
    const d2 = pos2.borrowPrincipal > 0n && pos2.borrowIdxSnap > 0n
      ? (pos2.borrowPrincipal * p.borrowIndex) / pos2.borrowIdxSnap : 0n;
    const r50 = d2 * 50n / 100n;
    if (!(await doRepay(USDT_POOL, "50%", r50, DEC))) return;
  }

  // ── TEST MAX (repay all remaining debt) ──
  {
    const p = await decodePool(USDT_POOL);
    const pos3 = await decodePos(posPk);
    const d3 = pos3.borrowPrincipal > 0n && pos3.borrowIdxSnap > 0n
      ? (pos3.borrowPrincipal * p.borrowIndex) / pos3.borrowIdxSnap : 0n;
    // Send u64::MAX to trigger full repay on-chain
    const U64_MAX = 18446744073709551615n;
    if (!(await doRepay(USDT_POOL, "MAX (u64::MAX)", U64_MAX, DEC))) return;
  }

  // Final state
  {
    const p = await decodePool(USDT_POOL);
    const posF = await decodePos(posPk);
    const debtF = posF.borrowPrincipal > 0n && posF.borrowIdxSnap > 0n
      ? (posF.borrowPrincipal * p.borrowIndex) / posF.borrowIdxSnap : 0n;
    const bal = await tokenBal(p.tokenMint);
    console.log(`\n${"═".repeat(60)}`);
    console.log("  FINAL STATE");
    console.log(`${"═".repeat(60)}`);
    console.log(`  Deposit shares:   ${posF.depositShares}`);
    console.log(`  Borrow principal: ${posF.borrowPrincipal} → ${fmt(debtF, DEC)} tokens`);
    console.log(`  Wallet balance:   ${fmt(bal, DEC)}`);
    console.log(`  Pool borrows:     ${fmt(p.totalBorrows, DEC)}`);
  }

  console.log("\nDONE ✓");
}

main().catch(e => { console.error(e); process.exit(1); });
