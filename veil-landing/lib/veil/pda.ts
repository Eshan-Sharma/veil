import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";

/** PDA: ["pool", tokenMint] */
export function findPoolAddress(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

/** PDA: ["authority", pool] */
export function findPoolAuthorityAddress(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authority"), pool.toBuffer()],
    PROGRAM_ID
  );
}

/** PDA: ["position", pool, user] */
export function findPositionAddress(
  pool: PublicKey,
  user: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), user.toBuffer()],
    PROGRAM_ID
  );
}

/** ATA of pool_authority for the token mint — this is the vault. */
export function findVaultAddress(
  tokenMint: PublicKey,
  poolAuthority: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(
    tokenMint,
    poolAuthority,
    true, // allowOwnerOffCurve = true because poolAuthority is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}
