"use client";

export type SolanaRpcPreset = "devnet" | "mainnet" | "localnet" | "custom";

export const SOLANA_RPC_STORAGE_KEY = "veil.solana-rpc-config";

export const PRESET_RPC_URLS: Record<
  Exclude<SolanaRpcPreset, "custom">,
  string
> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export type SolanaRpcConfig = {
  preset: SolanaRpcPreset;
  customRpc: string;
};

export function normalizeRpcUrl(value?: string | null): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function inferRpcConfig(defaultRpc?: string): SolanaRpcConfig {
  const normalized = normalizeRpcUrl(defaultRpc);
  if (!normalized) return { preset: "devnet", customRpc: "" };

  for (const [preset, url] of Object.entries(PRESET_RPC_URLS)) {
    if (normalized === url) {
      return {
        preset: preset as Exclude<SolanaRpcPreset, "custom">,
        customRpc: "",
      };
    }
  }
  return { preset: "custom", customRpc: normalized };
}

export function getRpcEndpoint(
  config: SolanaRpcConfig,
  defaultRpc?: string,
): string {
  if (config.preset === "custom") {
    const custom = normalizeRpcUrl(config.customRpc);
    if (custom) return custom;
  }

  if (config.preset !== "custom") {
    return PRESET_RPC_URLS[config.preset];
  }
  return normalizeRpcUrl(defaultRpc) || PRESET_RPC_URLS.devnet;
}

export function getRpcLabel(preset: SolanaRpcPreset): string {
  switch (preset) {
    case "mainnet":
      return "Mainnet";
    case "devnet":
      return "Devnet";
    case "localnet":
      return "Localnet";
    case "custom":
      return "Custom RPC";
  }
}

export function buildExplorerTxUrl(
  signature: string,
  config: SolanaRpcConfig,
  defaultRpc?: string,
): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (config.preset === "mainnet") return base;
  if (config.preset === "devnet") return `${base}?cluster=devnet`;

  const endpoint = getRpcEndpoint(config, defaultRpc);
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(endpoint)}`;
}
