"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useWallet } from "@solana/wallet-adapter-react";

import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import { buildExplorerTxUrl } from "@/lib/solana/rpc";

import { Empty } from "../components/Empty";

type TxRow = {
  id: number;
  signature: string;
  pool_address: string | null;
  wallet: string;
  action: string;
  amount: string | null;
  status: "pending" | "confirmed" | "failed";
  error_msg: string | null;
  created_at: string;
};

const ACTION_COLOR: Record<string, string> = {
  deposit:  "#059669",
  withdraw: "#7c3aed",
  borrow:   "#0284c7",
  repay:    "#16a34a",
  liquidate:"#dc2626",
  flash:    "#d97706",
  init:     "#0b0b10",
  update_pool: "#6b7280",
  pause:    "#dc2626",
  resume:   "#059669",
  collect_fees: "#a16207",
  update_oracle: "#0891b2",
};

const STATUS_TONE: Record<string, { fg: string; bg: string }> = {
  confirmed: { fg: "#065f46", bg: "#d1fae5" },
  pending:   { fg: "#92400e", bg: "#fef3c7" },
  failed:    { fg: "#991b1b", bg: "#fee2e2" },
};

export default function HistoryPage() {
  const { publicKey } = useWallet();
  const rpc = useSolanaRpc();
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) { setRows([]); return; }
    setLoading(true); setErr(null);
    fetch(`/api/transactions?wallet=${encodeURIComponent(publicKey.toBase58())}&limit=200`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { transactions: TxRow[] }) => setRows(d.transactions ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [publicKey]);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fa" }}>
      <header style={hdr}>
        <div style={hdrInner}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/dapp" style={back}>← Back to app</Link>
            <div style={{ width: 1, height: 18, background: "#e5e7eb" }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Transaction History</span>
          </div>
          <WalletMultiButton style={btn} />
        </div>
      </header>

      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 24px 64px" }}>
        {!publicKey ? (
          <Empty>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Connect a wallet</div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Your transaction log will appear here.</div>
          </Empty>
        ) : loading ? (
          <Empty><span style={{ color: "#6b7280" }}>Loading…</span></Empty>
        ) : err ? (
          <Empty><span style={{ color: "#dc2626" }}>Error: {err}</span></Empty>
        ) : rows.length === 0 ? (
          <Empty>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No transactions yet</div>
            <div style={{ fontSize: 13, color: "#6b7280", maxWidth: 460 }}>
              Transactions sent from this dApp are logged here automatically. Older transactions sent from other clients are not retroactively backfilled.
            </div>
          </Empty>
        ) : (
          <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
            <div style={tableHead}>
              <span>WHEN</span><span>ACTION</span><span>AMOUNT</span><span>POOL</span><span>STATUS</span><span>SIG</span>
            </div>
            {rows.map((r) => {
              const tone = STATUS_TONE[r.status] ?? STATUS_TONE.pending;
              const actionColor = ACTION_COLOR[r.action] ?? "#374151";

              return (
                <div key={r.signature} style={tableRow}>
                  <span style={{ ...mono, color: "#9ca3af", fontSize: 11 }}>
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                  <span style={{ ...mono, color: actionColor, fontWeight: 700 }}>{r.action}</span>
                  <span style={mono}>{r.amount ?? "—"}</span>
                  <span style={{ ...mono, color: "#6b7280" }}>
                    {r.pool_address ? `${r.pool_address.slice(0, 6)}…${r.pool_address.slice(-4)}` : "—"}
                  </span>
                  <span style={{
                    fontFamily: "var(--font-mono),monospace", fontSize: 10,
                    padding: "2px 8px", borderRadius: 999,
                    background: tone.bg, color: tone.fg, fontWeight: 700,
                    width: "fit-content",
                  }}>{r.status.toUpperCase()}</span>
                  <a
                    href={buildExplorerTxUrl(r.signature, rpc)}
                    target="_blank" rel="noreferrer"
                    style={{ ...mono, color: "#2563eb", textDecoration: "none" }}
                  >{r.signature.slice(0, 8)}…{r.signature.slice(-4)} ↗</a>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

const hdr: React.CSSProperties = { background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px" };
const hdrInner: React.CSSProperties = { maxWidth: 1000, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" };
const back: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 };
const btn: React.CSSProperties = { fontSize: 12, height: 34, borderRadius: 8, padding: "0 14px", background: "#0b0b10", color: "white", border: "none", fontWeight: 600 };
const tableHead: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "180px 110px 1fr 140px 100px 130px",
  padding: "10px 18px", borderBottom: "1px solid #e5e7eb",
  fontFamily: "var(--font-mono),monospace", fontSize: 10, letterSpacing: ".18em",
  color: "#9ca3af", textTransform: "uppercase",
};
const tableRow: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "180px 110px 1fr 140px 100px 130px",
  padding: "10px 18px", borderBottom: "1px solid #f3f4f6", alignItems: "center", gap: 8,
};
const mono: React.CSSProperties = { fontFamily: "var(--font-mono),monospace", fontSize: 12.5, color: "#0b0b10" };
