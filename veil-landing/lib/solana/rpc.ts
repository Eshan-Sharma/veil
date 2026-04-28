"use client";

/**
 * RPC selection on the client.
 *
 * Only mainnet, devnet, and localnet are accepted. Free-form URLs (the old
 * `"custom"` preset) were removed because they let a malicious browser
 * extension or compromised localStorage redirect ALL on-chain reads to an
 * attacker-controlled endpoint — fake balances, fake health factors, fake
 * tx-simulation success. See SECURITY_AUDIT.md M1.
 */

export type SolanaRpcPreset = "devnet" | "mainnet" | "localnet";

export const SOLANA_RPC_STORAGE_KEY = "veil.solana-rpc-config";

export const PRESET_RPC_URLS: Record<SolanaRpcPreset, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export type SolanaRpcConfig = {
  preset: SolanaRpcPreset;
};

export function normalizeRpcUrl(value?: string | null): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** Pick a preset by exact-match against the configured default URL. */
export function inferRpcConfig(defaultRpc?: string): SolanaRpcConfig {
  const normalized = normalizeRpcUrl(defaultRpc);
  for (const [preset, url] of Object.entries(PRESET_RPC_URLS)) {
    if (normalized === url) return { preset: preset as SolanaRpcPreset };
  }
  return { preset: "devnet" };
}

export function getRpcEndpoint(config: SolanaRpcConfig): string {
  return PRESET_RPC_URLS[config.preset];
}

export function getRpcLabel(preset: SolanaRpcPreset): string {
  switch (preset) {
    case "mainnet":
      return "Mainnet";
    case "devnet":
      return "Devnet";
    case "localnet":
      return "Localnet";
  }
}

/**
 * Build a Solana Explorer link for a tx signature.
 *
 * For mainnet/devnet we point at the public Explorer's standard cluster.
 * For localnet we used to embed `customUrl=...` so Explorer would talk to
 * the user's own RPC; that leaked the local RPC URL to a third party (L3)
 * AND has no consumer for end-users, so we fall back to the no-cluster URL
 * which simply 404s on Explorer — the dapp's own tx history is the source
 * of truth on local clusters.
 */
export function buildExplorerTxUrl(signature: string, config: SolanaRpcConfig): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (config.preset === "mainnet") return base;
  if (config.preset === "devnet") return `${base}?cluster=devnet`;
  return base;
}

/** Same idea as buildExplorerTxUrl but for an account address. */
export function buildExplorerAddressUrl(address: string, config: SolanaRpcConfig): string {
  const base = `https://explorer.solana.com/address/${address}`;
  if (config.preset === "mainnet") return base;
  if (config.preset === "devnet") return `${base}?cluster=devnet`;
  return base;
}
