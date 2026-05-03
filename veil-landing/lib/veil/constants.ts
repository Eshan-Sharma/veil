import { PublicKey } from "@solana/web3.js";
import { NETWORK } from "../network";

/**
 * Program ID is taken from `NEXT_PUBLIC_VEIL_PROGRAM_ID`. Each Vercel
 * environment sets this to the program deployed on its target cluster; in
 * local dev you flip it whenever you switch `NEXT_PUBLIC_SOLANA_CLUSTER`.
 *
 * `NETWORK` is imported solely so this throws with the active cluster name
 * in the error path — the resolution itself is single-source.
 */
function resolveProgramId(): PublicKey {
  const id = process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID;
  if (!id) {
    throw new Error(
      `NEXT_PUBLIC_VEIL_PROGRAM_ID is required (active cluster: ${NETWORK})`
    );
  }
  return new PublicKey(id);
}

export const PROGRAM_ID = resolveProgramId();

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn"
);

export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/** WAD = 1e18, stored as bigint */
export const WAD = BigInt("1000000000000000000");

/** LendingPool on-chain size (bytes) */
export const POOL_SIZE = 416;

/** UserPosition on-chain size (bytes) */
export const POSITION_SIZE = 144;

export const POOL_DISCRIMINATOR = Buffer.from("VEILPOOL");
export const POSITION_DISCRIMINATOR = Buffer.from("VEILPOS!");
