"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import { buildExplorerTxUrl } from "@/lib/solana/rpc";
import { buildInitializePoolTx } from "@/lib/veil/initialize";
import { requestSignedAuth } from "@/lib/auth/client";

type Status = "idle" | "building" | "signing" | "confirming" | "registering" | "success" | "error";

export function InitPoolPanel() {
  const { publicKey, sendTransaction } = useWallet();
  const wallet = useWallet();
  const { connection } = useConnection();
  const rpc = useSolanaRpc();

  const [tokenMint, setTokenMint] = useState("");
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [sig, setSig] = useState<string | null>(null);
  const [poolAddr, setPoolAddr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function reset() { setStatus("idle"); setSig(null); setPoolAddr(null); setErr(null); }

  async function handleSubmit() {
    if (!publicKey) { setErr("connect a wallet first"); return; }
    const trimmed = tokenMint.trim();
    if (!trimmed) { setErr("token mint required"); return; }
    let mint: PublicKey;
    try { mint = new PublicKey(trimmed); } catch { setErr("invalid mint pubkey"); return; }

    reset();
    try {
      setStatus("building");
      const built = buildInitializePoolTx({
        payer: publicKey,
        authority: publicKey,
        tokenMint: mint,
      });
      const { blockhash } = await connection.getLatestBlockhash();
      built.tx.recentBlockhash = blockhash;
      built.tx.feePayer = publicKey;

      setStatus("signing");
      const txSig = await sendTransaction(built.tx, connection);

      setStatus("confirming");
      await connection.confirmTransaction(txSig, "confirmed");
      setSig(txSig);
      setPoolAddr(built.pool.toBase58());

      setStatus("registering");
      const auth = await requestSignedAuth(wallet, `init_pool:${mint.toBase58()}`);
      const res = await fetch("/api/pools/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...auth,
          pool_address: built.pool.toBase58(),
          token_mint: mint.toBase58(),
          symbol: symbol.trim() || null,
          authority: publicKey.toBase58(),
          vault: built.vault.toBase58(),
          pool_bump: built.poolBump,
          authority_bump: built.authorityBump,
          vault_bump: 0,
          init_signature: txSig,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`registration failed: ${j.error ?? res.status}`);
      }

      // Log tx
      void fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signature: txSig, wallet: publicKey.toBase58(), action: "init",
          pool_address: built.pool.toBase58(), status: "confirmed",
        }),
      });

      setStatus("success");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  const busy = ["building", "signing", "confirming", "registering"].includes(status)

  return (
    <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "20px 22px", maxWidth: 640 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", marginBottom: 4 }}>Initialize a New Pool</div>
      <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 18 }}>
        Creates the on-chain LendingPool PDA and vault for an SPL token mint. This wallet
        becomes the pool authority and can later update parameters, pause/resume, and collect fees.
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Token mint</div>
        <input
          value={tokenMint}
          onChange={(e) => setTokenMint(e.target.value)}
          placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          spellCheck={false}
          style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-mono),monospace", background: "#f9f9fb", outline: "none", boxSizing: "border-box" }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Symbol (optional)</div>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 8))}
          placeholder="USDC"
          style={{ width: 200, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, background: "#f9f9fb", outline: "none", boxSizing: "border-box" }}
        />
      </div>

      <div style={{ padding: "12px 14px", background: "#fffbeb", border: "1px solid #fef08a", borderRadius: 10, fontSize: 12, color: "#854d0e", marginBottom: 14, lineHeight: 1.6 }}>
        <strong>What happens:</strong> creates the pool authority ATA (vault) for this mint and
        calls Initialize on the Veil program. Defaults are set on-chain (LTV 75%, LiqThreshold 80%,
        kink 80%, etc.) — you can update them after creation.
      </div>

      <button
        onClick={handleSubmit}
        disabled={busy || !publicKey || !tokenMint.trim()}
        style={{ width: "100%", padding: "11px", borderRadius: 12, background: busy || !publicKey || !tokenMint.trim() ? "#e5e7eb" : "#0b0b10", color: busy || !publicKey || !tokenMint.trim() ? "#9ca3af" : "white", border: "none", fontSize: 14, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}
      >
        {status === "building"     ? "Building transaction…"
         : status === "signing"     ? "Approve in wallet…"
         : status === "confirming"  ? "Confirming on-chain…"
         : status === "registering" ? "Registering with API…"
         : "Create Pool"}
      </button>

      {status === "success" && poolAddr && (
        <div style={{ marginTop: 14, padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 12.5, color: "#065f46" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Pool created.</div>
          <div style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11, marginBottom: 4 }}>
            Pool: {poolAddr}
          </div>
          {sig && (
            <a href={buildExplorerTxUrl(sig, rpc)} target="_blank" rel="noreferrer"
               style={{ color: "#059669", fontSize: 11, fontFamily: "var(--font-mono),monospace" }}>
              tx {sig.slice(0, 10)}…{sig.slice(-6)} ↗
            </a>
          )}
          <button onClick={reset} style={{ marginLeft: 12, fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>create another</button>
        </div>
      )}

      {status === "error" && err && (
        <div style={{ marginTop: 14, padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 12.5, color: "#991b1b" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Failed</div>
          <div style={{ fontSize: 12 }}>{err}</div>
          <button onClick={reset} style={{ marginTop: 6, fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>dismiss</button>
        </div>
      )}
    </div>
  );
}
