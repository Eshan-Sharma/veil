"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";

type PositionRow = {
  position_address: string;
  pool_address: string;
  owner: string;
  deposit_shares: string;
  borrow_principal: string;
  health_factor_wad: string | null;
  last_synced_at: string;
};

const WAD = 1_000_000_000_000_000_000n;

function formatHF(raw: string | null): { label: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (!raw) return { label: "—", tone: "muted" };
  const v = BigInt(raw);
  if (v >= 1n << 100n) return { label: "∞", tone: "ok" };
  // Display as fixed-point with 2 decimals
  const whole = v / WAD;
  const frac = ((v % WAD) * 100n) / WAD;
  const display = `${whole}.${String(frac).padStart(2, "0")}`;
  const tone = v < WAD ? "err" : v < (WAD * 12n) / 10n ? "warn" : "ok";
  return { label: display, tone };
}

function formatBigInt(s: string): string {
  // Cosmetic — format with thin spaces every 3 chars
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function PositionsPage() {
  const { publicKey } = useWallet();
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) { setRows([]); return; }
    setLoading(true);
    setErr(null);
    fetch(`/api/positions/${encodeURIComponent(publicKey.toBase58())}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { positions: PositionRow[] }) => setRows(d.positions ?? []))
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
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Your Positions</span>
          </div>
          <WalletMultiButton style={btn} />
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px 64px" }}>
        {!publicKey ? (
          <Empty>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Connect a wallet</div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Your open deposits and borrows on Veil will appear here.</div>
          </Empty>
        ) : loading ? (
          <Empty><span style={{ color: "#6b7280" }}>Loading positions…</span></Empty>
        ) : err ? (
          <Empty><span style={{ color: "#dc2626" }}>Error: {err}</span></Empty>
        ) : rows.length === 0 ? (
          <Empty>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No positions yet</div>
            <div style={{ fontSize: 13, color: "#6b7280", maxWidth: 460 }}>
              Deposit collateral or borrow from a pool on the markets page. Positions sync from the on-chain account via the indexer; if you just deposited, it may take a few seconds to appear.
            </div>
            <Link href="/dapp/markets" style={{ ...cta, marginTop: 14, display: "inline-block" }}>
              Open markets →
            </Link>
          </Empty>
        ) : (
          <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
            <div style={tableHead}>
              <span>POOL</span><span>DEPOSIT SHARES</span><span>BORROW PRINCIPAL</span><span>HEALTH FACTOR</span><span>SYNCED</span>
            </div>
            {rows.map((r) => {
              const hf = formatHF(r.health_factor_wad);
              const toneCol = hf.tone === "err" ? "#dc2626" : hf.tone === "warn" ? "#d97706" : hf.tone === "ok" ? "#059669" : "#9ca3af";
              return (
                <div key={r.position_address} style={tableRow}>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, color: "#374151" }}>
                    {r.pool_address.slice(0, 6)}…{r.pool_address.slice(-4)}
                  </span>
                  <span style={mono}>{formatBigInt(r.deposit_shares)}</span>
                  <span style={mono}>{formatBigInt(r.borrow_principal)}</span>
                  <span style={{ ...mono, color: toneCol, fontWeight: 700 }}>{hf.label}</span>
                  <span style={{ ...mono, color: "#9ca3af", fontSize: 11 }}>
                    {new Date(r.last_synced_at).toLocaleTimeString()}
                  </span>
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
const hdrInner: React.CSSProperties = { maxWidth: 900, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" };
const back: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 };
const btn: React.CSSProperties = { fontSize: 12, height: 34, borderRadius: 8, padding: "0 14px", background: "#0b0b10", color: "white", border: "none", fontWeight: 600 };
const cta: React.CSSProperties = { padding: "8px 14px", background: "#0b0b10", color: "white", textDecoration: "none", fontSize: 13, fontWeight: 600, borderRadius: 8 };
const tableHead: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "140px 1fr 1fr 130px 110px",
  padding: "10px 18px", borderBottom: "1px solid #e5e7eb",
  fontFamily: "var(--font-mono),monospace", fontSize: 10, letterSpacing: ".18em",
  color: "#9ca3af", textTransform: "uppercase",
};
const tableRow: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "140px 1fr 1fr 130px 110px",
  padding: "12px 18px", borderBottom: "1px solid #f3f4f6", alignItems: "center",
};
const mono: React.CSSProperties = { fontFamily: "var(--font-mono),monospace", fontSize: 12.5, color: "#0b0b10" };

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "white", border: "1px solid #e5e7eb", borderRadius: 14,
      padding: "48px 24px", textAlign: "center",
    }}>{children}</div>
  );
}
