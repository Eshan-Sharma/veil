"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import {
  SOLANA_RPC_STORAGE_KEY,
  getRpcEndpoint,
  inferRpcConfig,
  normalizeRpcUrl,
  type SolanaRpcConfig,
  type SolanaRpcPreset,
} from "@/lib/solana/rpc";

type SolanaRpcContextValue = SolanaRpcConfig & {
  endpoint: string;
  setPreset: (preset: SolanaRpcPreset) => void;
  setCustomRpc: (value: string) => void;
};

const DEFAULT_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC;
const defaultConfig = inferRpcConfig(DEFAULT_RPC);

const SolanaRpcContext = createContext<SolanaRpcContextValue>({
  ...defaultConfig,
  endpoint: getRpcEndpoint(defaultConfig, DEFAULT_RPC),
  setPreset: () => {},
  setCustomRpc: () => {},
});

export function useSolanaRpc() {
  return useContext(SolanaRpcContext);
}

export default function SolanaProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SolanaRpcConfig>(defaultConfig);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SOLANA_RPC_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SolanaRpcConfig>;
      if (!parsed || typeof parsed !== "object") return;
      setConfig({
        preset:
          parsed.preset === "devnet" ||
          parsed.preset === "mainnet" ||
          parsed.preset === "localnet" ||
          parsed.preset === "custom"
            ? parsed.preset
            : defaultConfig.preset,
        customRpc: normalizeRpcUrl(parsed.customRpc),
      });
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SOLANA_RPC_STORAGE_KEY, JSON.stringify(config));
    } catch {}
  }, [config]);

  const endpoint = getRpcEndpoint(config, DEFAULT_RPC);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  const value = useMemo(
    () => ({
      ...config,
      endpoint,
      setPreset: (preset: SolanaRpcPreset) =>
        setConfig((current) => ({
          ...current,
          preset,
          customRpc:
            preset === "custom"
              ? current.customRpc || normalizeRpcUrl(DEFAULT_RPC)
              : current.customRpc,
        })),
      setCustomRpc: (value: string) =>
        setConfig({
          preset: "custom",
          customRpc: normalizeRpcUrl(value),
        }),
    }),
    [config, endpoint]
  )

  return (
    <SolanaRpcContext.Provider value={value}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </SolanaRpcContext.Provider>
  );
}
