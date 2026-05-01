/**
 * Single source of truth for the cluster the server is currently serving.
 * Read once at module load — Vercel sets `NEXT_PUBLIC_SOLANA_CLUSTER` at build time.
 *
 * Why this lives here (and not co-located with rpc.ts):
 *   `lib/solana/rpc.ts` is `"use client"` and ships to the browser. Server code
 *   needs the same enum without the client directive, so it lives in plain TS.
 */

export type NetworkPreset = "mainnet" | "devnet" | "localnet";

const RAW = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet").toLowerCase();

export const NETWORK: NetworkPreset =
  RAW === "mainnet" || RAW === "mainnet-beta"
    ? "mainnet"
    : RAW === "localnet" || RAW === "local"
      ? "localnet"
      : "devnet";

export const IS_MAINNET = NETWORK === "mainnet";
export const IS_DEVNET = NETWORK === "devnet";
export const IS_LOCALNET = NETWORK === "localnet";

/**
 * Trusted RPC URLs the server uses for sync/health endpoints.
 * Mainnet/devnet are hard-coded; localnet falls back to the conventional port.
 * Operators can override per-cluster via dedicated env vars when running their
 * own validator or a paid mainnet RPC.
 */
const RPC_FALLBACK: Record<NetworkPreset, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export function serverRpcUrl(): string {
  // `||` (not `??`): empty-string env vars are written to .env.local for
  // documentation; treat them the same as unset so we fall through to the
  // default endpoint instead of returning "" (which fails URL parsing).
  switch (NETWORK) {
    case "mainnet":
      return process.env.MAINNET_RPC || RPC_FALLBACK.mainnet;
    case "devnet":
      return process.env.DEVNET_RPC || RPC_FALLBACK.devnet;
    case "localnet":
      return process.env.LOCALNET_RPC || RPC_FALLBACK.localnet;
  }
}
