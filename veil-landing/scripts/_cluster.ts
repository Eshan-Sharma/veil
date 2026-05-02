/**
 * Cluster-aware env helper for tsx scripts.
 *
 * Scripts run via `tsx` and load `.env.local` through dotenv at the top of
 * the file. `lib/network.ts` reads `process.env` at module load (which would
 * execute before dotenv), so scripts can't import that module directly.
 * Calling `clusterEnv()` defers the read until after dotenv has populated
 * the environment, and exposes the active cluster as a string for
 * column-scoped queries.
 */
export type Cluster = "mainnet" | "devnet" | "localnet";

const RPC_FALLBACK: Record<Cluster, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

function resolveCluster(): Cluster {
  const raw = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet").toLowerCase();
  if (raw === "mainnet" || raw === "mainnet-beta") return "mainnet";
  if (raw === "localnet" || raw === "local") return "localnet";
  return "devnet";
}

export function clusterEnv() {
  const cluster = resolveCluster();
  return {
    cluster,
    rpc: process.env.NEXT_PUBLIC_SOLANA_RPC ?? RPC_FALLBACK[cluster],
    databaseUrl: process.env.DATABASE_URL,
    programId: process.env.NEXT_PUBLIC_VEIL_PROGRAM_ID,
  };
}
