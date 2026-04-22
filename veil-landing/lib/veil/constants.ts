import { PublicKey } from "@solana/web3.js";

/**
 * Set NEXT_PUBLIC_VEIL_PROGRAM_ID in your .env.local after deploying.
 * Build:  cd programs && cargo build-sbf
 * Deploy: solana program deploy target/deploy/veil_lending.so --url devnet
 */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID ??
    "11111111111111111111111111111111" // placeholder until deployed
);

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
