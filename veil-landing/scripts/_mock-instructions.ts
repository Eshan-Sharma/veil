/**
 * Test-only instruction builders. Kept under `scripts/` so they're never
 * pulled into the browser bundle via `lib/veil/instructions.ts`.
 *
 * Discriminators 0xFD / 0xFE are gated by the on-chain program behind a
 * compile-time feature flag and an authority check; this file only constructs
 * the wire format used by local validator tests and devnet seeding.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "@/lib/veil/constants";

function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}

function concat(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ONLY FOR TESTING: Set oracle price/expo directly on a pool. Disc 0xFD. */
export function mockOracleIx(
  authority: PublicKey,
  pool: PublicKey,
  price: bigint,
  expo: number,
): TransactionInstruction {
  const priceBuf = new Uint8Array(8);
  new DataView(priceBuf.buffer).setBigInt64(0, price, true);
  const expoBuf = new Uint8Array(4);
  new DataView(expoBuf.buffer).setInt32(0, expo, true);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: concat(u8(0xfd), priceBuf, expoBuf),
  });
}

/** ONLY FOR TESTING: Inject 100 tokens of fees into the pool state. Disc 0xFE. */
export function mockFeesIx(
  authority: PublicKey,
  pool: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([0xfe]),
  });
}
