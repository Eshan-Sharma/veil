import { PublicKey } from "@solana/web3.js";
import { NETWORK } from "../network";

/**
 * Network-keyed program ID resolution.
 *
 * Mainnet and devnet IDs are pinned at compile time so a misconfigured env can
 * never silently point production at the System Program (the old fallback).
 * Localnet is read from `NEXT_PUBLIC_VEIL_PROGRAM_ID` because every dev's
 * `solana program deploy` produces a fresh keypair.
 *
 * Update the placeholders below after the corresponding deploy:
 *   cargo build-sbf
 *   solana program deploy --url mainnet-beta target/deploy/veil_lending.so
 */
const MAINNET_PROGRAM_ID = "VeiLMainNetProgramId11111111111111111111111";
const DEVNET_PROGRAM_ID = "VeiLDevnetProgramId111111111111111111111111";

function resolveProgramId(): PublicKey {
  if (NETWORK === "mainnet") {
    return new PublicKey(MAINNET_PROGRAM_ID);
  }
  if (NETWORK === "devnet") {
    return new PublicKey(DEVNET_PROGRAM_ID);
  }
  // localnet — must be set per-machine after deploy.
  const env = process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID;
  if (!env) {
    throw new Error(
      "NEXT_PUBLIC_VEIL_PROGRAM_ID is required when NEXT_PUBLIC_SOLANA_CLUSTER=localnet"
    );
  }
  return new PublicKey(env);
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
