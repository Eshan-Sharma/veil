"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

export default function ConnectButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  const h = size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-[13.5px]";

  if (publicKey) {
    const addr = publicKey.toBase58();
    const short = `${addr.slice(0, 4)}…${addr.slice(-4)}`;
    return (
      <button
        onClick={() => disconnect()}
        className={`inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/80 font-medium text-zinc-700 transition hover:border-rose-200 hover:text-rose-600 ${h}`}
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        {short}
      </button>
    );
  }

  return (
    <button
      onClick={() => setVisible(true)}
      disabled={connecting}
      className={`group inline-flex items-center gap-1.5 rounded-full bg-zinc-950 font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-60 ${h}`}
    >
      {connecting ? "Connecting…" : "Connect wallet"}
      {!connecting && (
        <svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" className="transition group-hover:translate-x-0.5">
          <path d="M4 10h12M11 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
