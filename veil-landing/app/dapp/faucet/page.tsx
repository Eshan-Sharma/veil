"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";

type Status = "idle" | "requesting" | "confirming" | "success" | "error";

export default function FaucetPage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<Status>("idle");
  const [sig, setSig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function airdrop() {
    if (!publicKey) { setErr("Connect a wallet"); setStatus("error"); return; }
    setStatus("requesting"); setErr(null); setSig(null);
    try {
      const lamports = 2 * LAMPORTS_PER_SOL;
      const txSig = await connection.requestAirdrop(publicKey, lamports);
      setStatus("confirming");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
      setSig(txSig);
      setStatus("success");
    } catch (e) {
      setStatus("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fa" }}>
      <header style={hdr}>
        <div style={hdrInner}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/dapp" style={back}>← Back to app</Link>
            <div style={{ width: 1, height: 18, background: "#e5e7eb" }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Devnet Faucet</span>
          </div>
          <WalletMultiButton style={btn} />
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px 64px" }}>
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "24px 26px" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0b0b10", marginBottom: 6 }}>Get devnet SOL</div>
          <div style={{ fontSize: 13.5, color: "#6b7280", lineHeight: 1.6, marginBottom: 18 }}>
            Devnet SOL pays transaction fees and creates accounts. Veil&apos;s SPL pool tokens are separate — see the resources below.
          </div>
          <button
            onClick={airdrop}
            disabled={!publicKey || status === "requesting" || status === "confirming"}
            style={{
              padding: "12px 18px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: publicKey ? "pointer" : "not-allowed",
              background: publicKey ? "#0b0b10" : "#e5e7eb", color: publicKey ? "white" : "#9ca3af",
              border: "none", letterSpacing: "-0.01em",
            }}
          >
            {!publicKey ? "Connect wallet" :
             status === "requesting" ? "Requesting…" :
             status === "confirming" ? "Confirming…" :
             "Request 2 SOL airdrop"}
          </button>
          {status === "success" && sig && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 12.5, color: "#065f46" }}>
              Airdropped 2 SOL.{" "}
              <a href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`} target="_blank" rel="noreferrer" style={{ color: "#059669", fontFamily: "var(--font-mono),monospace" }}>
                {sig.slice(0, 10)}… ↗
              </a>
            </div>
          )}
          {status === "error" && err && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 12.5, color: "#991b1b" }}>
              {err}
              {err.includes("429") && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#7f1d1d" }}>
                  Devnet airdrops are rate-limited per IP. Try{" "}
                  <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" style={{ color: "#7f1d1d", textDecoration: "underline" }}>
                    faucet.solana.com
                  </a>.
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginTop: 16, background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", marginBottom: 12 }}>Other devnet resources</div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.9 }}>
            <li><strong>Solana faucet:</strong> <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" style={link}>faucet.solana.com</a> — alternative SOL drip</li>
            <li><strong>Devnet USDC:</strong> <a href="https://spl-token-faucet.com" target="_blank" rel="noreferrer" style={link}>spl-token-faucet.com</a> — mint test USDC for the canonical mint</li>
            <li><strong>Test mints:</strong> use <a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer" style={link}>solana explorer</a> to inspect mint authorities</li>
            <li><strong>Airdrop limits:</strong> 2 SOL/request, 24/day per IP</li>
          </ul>
        </div>

        <div style={{ marginTop: 16, padding: "12px 14px", background: "#fffbeb", border: "1px solid #fef08a", borderRadius: 10, fontSize: 12.5, color: "#854d0e", lineHeight: 1.6 }}>
          <strong>Note:</strong> Veil&apos;s pools are denominated in SPL tokens (e.g. USDC). To deposit, you need both devnet SOL (for fees) and devnet tokens of the pool&apos;s mint. SOL is also a pool asset via wrapped SOL — depositing wrapped SOL needs a wSOL ATA, not native SOL.
        </div>
      </main>
    </div>
  );
}

const hdr: React.CSSProperties = { background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px" };
const hdrInner: React.CSSProperties = { maxWidth: 720, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" };
const back: React.CSSProperties = { textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 };
const btn: React.CSSProperties = { fontSize: 12, height: 34, borderRadius: 8, padding: "0 14px", background: "#0b0b10", color: "white", border: "none", fontWeight: 600 };
const link: React.CSSProperties = { color: "#2563eb", textDecoration: "none", fontFamily: "var(--font-mono),monospace", fontSize: 12 };
