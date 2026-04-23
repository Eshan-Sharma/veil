"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useVeilActions } from "../hooks/useVeilActions";

const POOLS = [
  { id: "sol",  symbol: "SOL",  icon: "◎", color: "#7c3aed" },
  { id: "btc",  symbol: "BTC",  icon: "₿", color: "#f97316" },
  { id: "eth",  symbol: "ETH",  icon: "Ξ", color: "#6366f1" },
  { id: "xau",  symbol: "XAU",  icon: "◈", color: "#ca8a04" },
  { id: "usdc", symbol: "USDC", icon: "$", color: "#2563eb" },
];

interface UnhealthyRow {
  position_address: string;
  pool_address: string;
  owner: string;
  borrow_principal: string;
  health_factor_wad: string;
  last_synced_at: string;
}

const WAD = 1_000_000_000_000_000_000n;
function fmtHF(raw: string): string {
  const v = BigInt(raw);
  if (v >= 1n << 100n) return "∞";
  const whole = v / WAD;
  const frac = ((v % WAD) * 100n) / WAD;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

export default function LiquidatePage() {
  const { publicKey } = useWallet();
  const { liquidate, status, txSig, errorMsg, reset } = useVeilActions();
  const [poolId, setPoolId] = useState("usdc");
  const [borrower, setBorrower] = useState("");
  const [borrowerErr, setBorrowerErr] = useState<string | null>(null);

  // ── Unhealthy-positions scan ─────────────────────────────────────────────
  const [unhealthy, setUnhealthy] = useState<UnhealthyRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  async function scanUnhealthy() {
    setScanning(true); setScanErr(null);
    try {
      const r = await fetch("/api/positions/unhealthy?limit=50", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { positions: UnhealthyRow[] };
      setUnhealthy(d.positions ?? []);
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }
  useEffect(() => { void scanUnhealthy(); }, []);

  function handleSubmit() {
    setBorrowerErr(null);
    let pk: PublicKey;
    try { pk = new PublicKey(borrower.trim()); }
    catch { setBorrowerErr("Invalid wallet pubkey"); return; }
    void liquidate(poolId, pk);
  }

  const busy = ["building", "signing", "confirming"].includes(status);
  const selected = POOLS.find((p) => p.id === poolId)!;

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fa" }}>
      <header style={{ background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/dapp" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 12L6 8l4-4" /></svg>
              Back to app
            </Link>
            <div style={{ width: 1, height: 18, background: "#e5e7eb" }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", letterSpacing: "-0.02em" }}>Liquidator</div>
          </div>
          <WalletMultiButton style={{ fontSize: "12px", height: "34px", borderRadius: "8px", padding: "0 14px", background: "#0b0b10", color: "white", border: "none", fontWeight: 600 }}/>
        </div>
      </header>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px 64px" }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#0b0b10", letterSpacing: "-0.02em", marginBottom: 6 }}>
            Liquidate an unhealthy position
          </div>
          <div style={{ fontSize: 13.5, color: "#6b7280", maxWidth: 560 }}>
            When a borrower&apos;s health factor drops below 1.0, anyone can repay up to the
            close-factor portion of their debt and seize collateral at the current liquidation
            bonus. Protocol takes a small share of the seized collateral.
          </div>
        </div>

        {/* ── Unhealthy positions scan ─────────────────────────────────── */}
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "16px 20px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0b0b10" }}>Live unhealthy positions</div>
              <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>
                Indexed by the position indexer; sorted by HF ascending.
              </div>
            </div>
            <button onClick={() => void scanUnhealthy()} disabled={scanning}
              style={{ padding: "5px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "#374151", background: "white", cursor: scanning ? "not-allowed" : "pointer" }}>
              {scanning ? "scanning…" : "scan"}
            </button>
          </div>
          {scanErr ? (
            <div style={{ fontSize: 12, color: "#dc2626" }}>{scanErr}</div>
          ) : unhealthy.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9ca3af", padding: "10px 0" }}>
              No unhealthy positions. The indexer must be running (<code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 3 }}>npm run keeper:indexer</code>) to populate this list.
            </div>
          ) : (
            <div>
              {unhealthy.slice(0, 10).map((u) => (
                <div key={u.position_address} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px auto", gap: 12, padding: "8px 0", borderBottom: "1px solid #f3f4f6", alignItems: "center", fontSize: 12 }}>
                  <span style={{ fontFamily: "var(--font-mono),monospace", color: "#9ca3af" }}>
                    {u.pool_address.slice(0, 6)}…{u.pool_address.slice(-4)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono),monospace", color: "#374151" }}>
                    owner {u.owner.slice(0, 6)}…{u.owner.slice(-4)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono),monospace", color: "#dc2626", fontWeight: 700 }}>
                    HF {fmtHF(u.health_factor_wad)}
                  </span>
                  <button
                    onClick={() => { setBorrower(u.owner); }}
                    style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", cursor: "pointer" }}
                  >load</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "20px 22px", marginBottom: 16 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Market</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {POOLS.map((p) => {
                const sel = p.id === poolId;
                return (
                  <button key={p.id} onClick={() => setPoolId(p.id)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 999,
                      border: `1px solid ${sel ? p.color : "#e5e7eb"}`,
                      background: sel ? `${p.color}1a` : "white",
                      cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: sel ? p.color : "#374151" }}>
                    <span style={{ width: 18, height: 18, borderRadius: 5, background: p.color, color: "white", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>{p.icon}</span>
                    {p.symbol}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Borrower wallet</div>
            <input value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Wallet pubkey of the unhealthy borrower"
              spellCheck={false}
              style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-mono),monospace", background: "#f9f9fb", outline: "none", boxSizing: "border-box" }}/>
            {borrowerErr && <div style={{ marginTop: 6, color: "#dc2626", fontSize: 12 }}>{borrowerErr}</div>}
          </div>

          <div style={{ padding: "12px 14px", background: "#fffbeb", border: "1px solid #fef08a", borderRadius: 10, fontSize: 12, color: "#854d0e", marginBottom: 14, lineHeight: 1.6 }}>
            <strong>Reverts if borrower is healthy.</strong> The on-chain check requires
            health_factor &lt; 1.0 (WAD). Repay amount is auto-set to debt × close_factor (default 50%).
            Liquidator receives repay × (1 + bonus) × (1 − protocol_fee) in the {selected.symbol} pool.
          </div>

          <button onClick={handleSubmit} disabled={busy || !publicKey || !borrower.trim()}
            style={{ width: "100%", padding: "11px", borderRadius: 12,
              background: busy || !publicKey || !borrower.trim() ? "#e5e7eb" : "linear-gradient(135deg,#dc2626,#f97316)",
              color: busy || !publicKey || !borrower.trim() ? "#9ca3af" : "white",
              border: "none", fontSize: 14, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            {!publicKey ? "Connect wallet" :
             status === "building" ? "Building transaction…" :
             status === "signing" ? "Approve in wallet…" :
             status === "confirming" ? "Confirming on-chain…" :
             "Liquidate position"}
          </button>

          {status === "success" && txSig && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 12.5, color: "#065f46", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Liquidation confirmed</div>
                <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer"
                   style={{ color: "#059669", fontSize: 11, fontFamily: "var(--font-mono),monospace" }}>
                  {txSig.slice(0, 10)}…{txSig.slice(-6)} ↗
                </a>
              </div>
              <button onClick={reset} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>liquidate another</button>
            </div>
          )}

          {status === "error" && errorMsg && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 12.5, color: "#991b1b" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Transaction failed</div>
              <div style={{ fontSize: 12 }}>{errorMsg}</div>
              <button onClick={reset} style={{ marginTop: 6, fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>dismiss</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
