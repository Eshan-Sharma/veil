"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import {
  SOLANA_RPC_STORAGE_KEY,
  getRpcEndpoint,
  inferRpcConfig,
  type SolanaRpcConfig,
  type SolanaRpcPreset,
} from "@/lib/solana/rpc";
import { logSafe } from "@/lib/log";

type SolanaRpcContextValue = SolanaRpcConfig & {
  endpoint: string;
  setPreset: (preset: SolanaRpcPreset) => void;
};

const DEFAULT_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC;
const defaultConfig = inferRpcConfig(DEFAULT_RPC);

const SolanaRpcContext = createContext<SolanaRpcContextValue>({
  ...defaultConfig,
  endpoint: getRpcEndpoint(defaultConfig),
  setPreset: () => {},
});

export const useSolanaRpc = () => useContext(SolanaRpcContext);

const VALID_PRESETS = new Set<SolanaRpcPreset>(["devnet", "mainnet", "localnet"]);

export default function SolanaProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SolanaRpcConfig>(defaultConfig);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SOLANA_RPC_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SolanaRpcConfig>;
      if (!parsed || typeof parsed !== "object") return;
      // Only accept whitelisted presets — defends against a compromised
      // localStorage redirecting RPC traffic to an attacker. See M1.
      if (parsed.preset && VALID_PRESETS.has(parsed.preset as SolanaRpcPreset)) {
        setConfig({ preset: parsed.preset as SolanaRpcPreset });
      }
    } catch (err) {
      logSafe("warn", "solana.rpc.localstorage_parse", { err: String(err) });
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SOLANA_RPC_STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      logSafe("warn", "solana.rpc.localstorage_write", { err: String(err) });
    }
  }, [config]);

  const endpoint = getRpcEndpoint(config);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  const value = useMemo(
    () => ({
      ...config,
      endpoint,
      setPreset: (preset: SolanaRpcPreset) => {
        if (!VALID_PRESETS.has(preset)) return;
        setConfig({ preset });
      },
    }),
    [config, endpoint]
  );

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
