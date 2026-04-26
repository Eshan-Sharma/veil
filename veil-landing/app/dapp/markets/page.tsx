"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import { buildExplorerTxUrl } from "@/lib/solana/rpc";
import { usePools, type PoolView } from "@/lib/veil/usePools";
import { useVeilActions } from "../hooks/useVeilActions";

const WAD = 1_000_000_000_000_000_000n;
function wadToPct(v: bigint | null): string {
  if (!v) return "—";
  return `${Number((v * 10000n) / WAD) / 100}%`;
}

export default function MarketsPage() {
  const { publicKey } = useWallet();
  const rpc = useSolanaRpc();
  const { pools, loading, error, refresh } = usePools();
  const actions = useVeilActions();

  const [openModal, setOpenModal] = useState<{ kind: "deposit" | "borrow" | "withdraw" | "repay"; pool: PoolView } | null>(null);
  const [amount, setAmount] = useState("");

  function execute() {
    if (!openModal || !amount.trim()) return;
    const a = BigInt(amount.trim().replace(/[^0-9]/g, "") || "0");
    if (a === 0n) return;
    const pool = openModal.pool;
    if (openModal.kind === "deposit")  void actions.deposit(pool, a);
    if (openModal.kind === "withdraw") void actions.withdraw(pool, a);
    if (openModal.kind === "borrow")   void actions.borrow(pool, a);
    if (openModal.kind === "repay")    void actions.repay(pool, a);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fa" }}>
      <header style={hdr}>
        <div style={hdrInner}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/dapp" style={back}>← Back</Link>
            <div style={{ width: 1, height: 18, background: "#e5e7eb" }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Markets</span>
            <span style={{ ...mono, fontSize: 10, color: "#9ca3af", letterSpacing: ".18em", textTransform: "uppercase" }}>
              live · {pools.length} pool{pools.length === 1 ? "" : "s"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Link href="/dapp/positions" style={navLink}>POSITIONS</Link>
            <Link href="/dapp/history" style={navLink}>HISTORY</Link>
            <Link href="/dapp/liquidate" style={navLink}>LIQUIDATE</Link>
            <WalletMultiButton style={btn} />
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 24px 64px" }}>
        {loading ? (
          <Empty><span style={{ color: "#6b7280" }}>Loading pools from API…</span></Empty>
        ) : error ? (
          <Empty>
            <div style={{ color: "#dc2626", marginBottom: 8 }}>API error: {error}</div>
            <button onClick={refresh} style={miniBtn}>retry</button>
          </Empty>
        ) : pools.length === 0 ? (
          <Empty>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No pools initialized yet</div>
            <div style={{ fontSize: 13, color: "#6b7280", maxWidth: 480, margin: "0 auto" }}>
              An allowlisted admin must create pools via <Link href="/dapp/admin" style={{ color: "#2563eb" }}>/dapp/admin → Initialize Pool</Link>.
              Once a pool is created and registered, it will appear here automatically.
            </div>
          </Empty>
        ) : (
          <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
            <div style={tableHead}>
              <span>SYMBOL</span><span>POOL</span><span>DEPOSITS</span><span>BORROWS</span><span>LTV</span><span>LIQ.TH.</span><span>ACTIONS</span>
            </div>
            {pools.map((p) => (
              <div key={p.poolAddress.toBase58()} style={tableRow}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...mono, fontWeight: 700, color: "#0b0b10" }}>{p.symbol}</span>
                  {p.paused && <span style={pausedTag}>PAUSED</span>}
                </span>
                <span style={{ ...mono, color: "#6b7280" }}>{p.poolAddress.toBase58().slice(0, 6)}…{p.poolAddress.toBase58().slice(-4)}</span>
                <span style={mono}>{p.totalDeposits.toString()}</span>
                <span style={mono}>{p.totalBorrows.toString()}</span>
                <span style={mono}>{wadToPct(p.ltvWad)}</span>
                <span style={mono}>{wadToPct(p.liquidationThresholdWad)}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  <ActionBtn kind="deposit"  onClick={() => publicKey && setOpenModal({ kind: "deposit",  pool: p })}>Supply</ActionBtn>
                  <ActionBtn kind="borrow"   onClick={() => publicKey && setOpenModal({ kind: "borrow",   pool: p })}>Borrow</ActionBtn>
                  <ActionBtn kind="repay"    onClick={() => publicKey && setOpenModal({ kind: "repay",    pool: p })}>Repay</ActionBtn>
                  <ActionBtn kind="withdraw" onClick={() => publicKey && setOpenModal({ kind: "withdraw", pool: p })}>Wd</ActionBtn>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Tx status */}
        {actions.status !== "idle" && (
          <div style={{
            marginTop: 18, padding: "12px 14px", borderRadius: 10,
            background: actions.status === "success" ? "#f0fdf4" : actions.status === "error" ? "#fef2f2" : "#eff6ff",
            border: `1px solid ${actions.status === "success" ? "#bbf7d0" : actions.status === "error" ? "#fecaca" : "#bfdbfe"}`,
            fontSize: 13, color: actions.status === "success" ? "#166534" : actions.status === "error" ? "#991b1b" : "#1e40af",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>
              {actions.status === "building" ? "Building…" :
               actions.status === "signing"  ? "Approve in wallet…" :
               actions.status === "confirming" ? "Confirming on-chain…" :
               actions.status === "success" ? "Confirmed" :
               actions.errorMsg ?? "Failed"}
            </span>
            {actions.status === "success" && actions.txSig && (
              <a href={buildExplorerTxUrl(actions.txSig, rpc)} target="_blank" rel="noreferrer" style={{ ...mono, color: "#059669", textDecoration: "none" }}>
                {actions.txSig.slice(0, 10)}… ↗
              </a>
            )}
            <button onClick={actions.reset} style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 11 }}>✕</button>
          </div>
        )}
      </main>

      {openModal && (
        <div style={modalOverlay} onClick={() => setOpenModal(null)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              {openModal.kind.toUpperCase()} {openModal.pool.symbol}
            </div>
            <div style={{ fontSize: 11.5, color: "#6b7280", marginBottom: 14, fontFamily: "var(--font-mono),monospace" }}>
              {openModal.pool.poolAddress.toBase58()}
            </div>
            <input
              type="text" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder={openModal.kind === "withdraw" ? "shares" : "amount in base units (lamports)"}
              autoFocus
              style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-mono),monospace", background: "#f9f9fb", outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setOpenModal(null)} style={{ ...miniBtn, flex: 1 }}>Cancel</button>
              <button onClick={() => { execute(); setOpenModal(null); setAmount(""); }} style={{ ...miniBtn, flex: 1, background: "#0b0b10", color: "white", border: "1px solid #0b0b10" }}>
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBtn({ kind, onClick, children }: { kind: "deposit" | "borrow" | "withdraw" | "repay"; onClick: () => void; children: React.ReactNode }) {
  const colors: Record<string, { bg: string; fg: string; bd: string }> = {
    deposit:  { bg: "#ecfdf5", fg: "#065f46", bd: "#a7f3d0" },
    borrow:   { bg: "#eff6ff", fg: "#1e40af", bd: "#bfdbfe" },
    repay:    { bg: "#f0fdf4", fg: "#15803d", bd: "#bbf7d0" },
    withdraw: { bg: "#faf5ff", fg: "#6b21a8", bd: "#e9d5ff" },
  };
  const c = colors[kind]

  return (
    <button onClick={onClick} style={{
      padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, cursor: "pointer",
    }}>{children}</button>
  );
}

const hdr: React.CSSProperties = { background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px" };
const hdrInner: React.CSSProperties = { maxWidth: 1000, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" };
const back: React.CSSProperties = { textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 };
const btn: React.CSSProperties = { fontSize: 12, height: 34, borderRadius: 8, padding: "0 14px", background: "#0b0b10", color: "white", border: "none", fontWeight: 600 };
const navLink: React.CSSProperties = { fontFamily: "var(--font-mono),monospace", fontSize: 10.5, letterSpacing: ".18em", color: "#374151", textDecoration: "none" };
const tableHead: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "100px 1fr 130px 130px 80px 80px 280px",
  padding: "10px 18px", borderBottom: "1px solid #e5e7eb",
  fontFamily: "var(--font-mono),monospace", fontSize: 10, letterSpacing: ".18em",
  color: "#9ca3af", textTransform: "uppercase",
};
const tableRow: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "100px 1fr 130px 130px 80px 80px 280px",
  padding: "12px 18px", borderBottom: "1px solid #f3f4f6", alignItems: "center", gap: 8,
};
const mono: React.CSSProperties = { fontFamily: "var(--font-mono),monospace", fontSize: 12, color: "#0b0b10" };
const pausedTag: React.CSSProperties = { fontFamily: "var(--font-mono),monospace", fontSize: 9, padding: "1px 6px", border: "1px solid #fecaca", color: "#dc2626", background: "#fef2f2", letterSpacing: ".15em" };
const miniBtn: React.CSSProperties = { padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "1px solid #e5e7eb", background: "white", color: "#0b0b10", cursor: "pointer" };
const modalOverlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(11,11,16,0.6)", display: "grid", placeItems: "center", zIndex: 100 };
const modal: React.CSSProperties = { background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "20px 22px", width: 380, boxShadow: "0 20px 60px rgba(0,0,0,.2)" };

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "48px 24px", textAlign: "center" }}>{children}</div>;
}
