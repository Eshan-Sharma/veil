"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import { TestWalletAdapter } from "@/app/dapp/lib/TestWalletAdapter";
import {
  getRpcEndpoint,
  type SolanaRpcConfig,
  type SolanaRpcPreset,
} from "@/lib/solana/rpc";

type SolanaRpcContextValue = SolanaRpcConfig & {
  endpoint: string;
};

// The cluster is fixed at build time by `NEXT_PUBLIC_SOLANA_CLUSTER`. Each
// deploy serves exactly one cluster — API routes, Neon DB, and the program
// ID are all pinned to it, so letting users flip clusters in the UI would
// only desync the wallet from everything else.
const RAW_CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet").toLowerCase();
const PRESET: SolanaRpcPreset =
  RAW_CLUSTER === "mainnet" || RAW_CLUSTER === "mainnet-beta"
    ? "mainnet"
    : RAW_CLUSTER === "localnet" || RAW_CLUSTER === "local"
      ? "localnet"
      : "devnet";
const config: SolanaRpcConfig = { preset: PRESET };
const ENDPOINT = getRpcEndpoint(config);

const SolanaRpcContext = createContext<SolanaRpcContextValue>({
  ...config,
  endpoint: ENDPOINT,
});

export const useSolanaRpc = () => useContext(SolanaRpcContext);

export default function SolanaProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => {
    const base: Adapter[] = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
    // Test wallet: only loaded when explicitly enabled and never on mainnet.
    if (process.env.NEXT_PUBLIC_TEST_WALLET === "1" && PRESET !== "mainnet") {
      base.unshift(new TestWalletAdapter());
    }
    return base;
  }, []);

  return (
    <SolanaRpcContext.Provider value={{ ...config, endpoint: ENDPOINT }}>
      <ConnectionProvider endpoint={ENDPOINT}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </SolanaRpcContext.Provider>
  );
}
