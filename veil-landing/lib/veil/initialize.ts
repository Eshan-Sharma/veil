import {
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  findPoolAddress,
  findPoolAuthorityAddress,
} from "./pda";
import { initializePoolIx } from "./instructions";

export type BuiltInitTx = {
  tx: Transaction;
  pool: PublicKey;
  poolAuthority: PublicKey;
  vault: PublicKey;
  poolBump: number;
  authorityBump: number;
};

/**
 * Build a Transaction that:
 *   1. Creates the vault ATA (owned by the pool_authority PDA, off-curve allowed),
 *   2. Calls Initialize on the Veil program.
 *
 * Caller (admin) signs as both `payer` and `authority` of the pool.
 */
export function buildInitializePoolTx(params: {
  payer: PublicKey;
  authority: PublicKey;
  tokenMint: PublicKey;
}): BuiltInitTx {
  const { payer, authority, tokenMint } = params;
  const [pool, poolBump] = findPoolAddress(tokenMint);
  const [poolAuthority, authorityBump] = findPoolAuthorityAddress(pool);

  // Vault is the ATA of poolAuthority for the token mint. Off-curve allowed because
  // poolAuthority is a PDA. Bump for the ATA itself is not required by Initialize —
  // the program derives it via address comparison; we pass 0 as a placeholder.
  const vault = getAssociatedTokenAddressSync(
    tokenMint,
    poolAuthority,
    true,
    SPL_TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountInstruction(
      payer,
      vault,
      poolAuthority,
      tokenMint,
      SPL_TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  tx.add(
    initializePoolIx(
      payer,
      authority,
      pool,
      tokenMint,
      vault,
      poolBump,
      authorityBump,
      0 /* vault_bump — informational only; the on-chain code re-derives */
    )
  );

  return { tx, pool, poolAuthority, vault, poolBump, authorityBump };
}

/** Tag-along constant export so callers don't import from spl-token directly. */
export { SystemProgram };
