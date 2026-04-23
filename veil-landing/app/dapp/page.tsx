"use client";

import React, { useState, useEffect, CSSProperties } from "react";
import { WalletButton as WalletMultiButton } from "../components/WalletButton";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useVeilActions } from "./hooks/useVeilActions";
import { usePythPrices } from "./hooks/usePythPrices";
import { formatPrice, PythPrices } from "../../lib/pyth/prices";

// ─── Types ────────────────────────────────────────────────────────────────────

type View = "markets" | "portfolio" | "flash";
type PoolType = "native" | "ika" | "oro" | "enc";
type ModalType = "supply" | "borrow" | "withdraw" | "repay" | "ika-setup";

interface Pool {
  id: string;
  symbol: string;
  name: string;
  type: PoolType;
  icon: string;
  price: string;
  totalSupply: string;
  totalBorrow: string;
  availLiq: string;
  supplyApy: number;
  borrowApy: number;
  util: number;
  cf: number;
  ltv: number;
  liqThreshold: number;
  liqBonus: number;
  reserveFactor: number;
  baseRate: number;
  slope1: number;
  slope2: number;
  optimalUtil: number;
  mask: string | null;
}

interface Position {
  id: string;
  symbol: string;
  type: PoolType;
  amount: string;
  value: string;
  apy: number;
  enc: boolean;
}

interface ModalState {
  type: ModalType;
  pool: Pool;
}

interface ApiEndpoint {
  method: string;
  path: string;
  desc: string;
  params: { n: string; t: string; d: string }[];
}

// ─── Cipher animation ─────────────────────────────────────────────────────────

const CIPHER_POOL = [
  "7fA9·12Ce·88aD","E4b2·9C01·F7dd","A1b3·44Cc·ZzQ9",
  "5D0e·09Bc·4F8a","Q7x2·MmN4·L20p","9cE4·DdE1·0aBb",
];

function useCipher(seed = 0) {
  const [i, setI] = useState(seed % CIPHER_POOL.length);
  useEffect(() => {
    const t = setInterval(() => setI((p) => (p + 1) % CIPHER_POOL.length), 2400 + seed * 180);
    return () => clearInterval(t);
  }, [seed]);
  return CIPHER_POOL[i];
}

function CipherVal({ seed, mask }: { seed: number; mask: string }) {
  const v = useCipher(seed);
  return (
    <span className="cipher-mask rotate-cipher" title={`ct:${v}`}>{mask}</span>
  );
}

// ─── Pool data ────────────────────────────────────────────────────────────────

const POOLS: Pool[] = [
  {
    id: "sol", symbol: "SOL", name: "Solana", type: "native", icon: "◎",
    price: "$168.42",
    totalSupply: "$1.84M", totalBorrow: "$940K", availLiq: "$900K",
    supplyApy: 4.2, borrowApy: 7.1, util: 51, cf: 80,
    ltv: 68, liqThreshold: 73, liqBonus: 7.5, reserveFactor: 10,
    baseRate: 2, slope1: 8, slope2: 100, optimalUtil: 80,
    mask: null,
  },
  {
    id: "btc", symbol: "BTC", name: "Native Bitcoin", type: "ika", icon: "₿",
    price: "$61,200",
    totalSupply: "$2.1M", totalBorrow: "$980K", availLiq: "$1.12M",
    supplyApy: 2.8, borrowApy: 5.9, util: 47, cf: 75,
    ltv: 73, liqThreshold: 78, liqBonus: 5.5, reserveFactor: 10,
    baseRate: 1, slope1: 6, slope2: 80, optimalUtil: 75,
    mask: null,
  },
  {
    id: "eth", symbol: "ETH", name: "Native Ethereum", type: "ika", icon: "Ξ",
    price: "$3,240",
    totalSupply: "$310K", totalBorrow: "$220K", availLiq: "$90K",
    supplyApy: 3.5, borrowApy: 6.8, util: 71, cf: 75,
    ltv: 75, liqThreshold: 80, liqBonus: 5, reserveFactor: 10,
    baseRate: 1, slope1: 7, slope2: 90, optimalUtil: 80,
    mask: null,
  },
  {
    id: "xau", symbol: "XAU", name: "Physical Gold", type: "oro", icon: "◈",
    price: "$2,318",
    totalSupply: "$640K", totalBorrow: "$120K", availLiq: "$520K",
    supplyApy: 1.9, borrowApy: 3.8, util: 19, cf: 65,
    ltv: 60, liqThreshold: 65, liqBonus: 7.5, reserveFactor: 15,
    baseRate: 1, slope1: 5, slope2: 60, optimalUtil: 70,
    mask: null,
  },
  {
    id: "usdc", symbol: "USDC", name: "USD Coin", type: "enc", icon: "$",
    price: "$1.00",
    totalSupply: "$890K", totalBorrow: "$430K", availLiq: "$460K",
    supplyApy: 5.1, borrowApy: 9.3, util: 48, cf: 90,
    ltv: 85, liqThreshold: 88, liqBonus: 4.5, reserveFactor: 5,
    baseRate: 0, slope1: 6, slope2: 60, optimalUtil: 90,
    mask: "◉◉◉,◉◉◉",
  },
];

const MY_SUPPLIED: Position[] = [
  { id: "btc",  symbol: "BTC",  type: "ika", amount: "1.2 BTC", value: "$73,440", apy: 2.8, enc: false },
  { id: "usdc", symbol: "USDC", type: "enc", amount: "••••",    value: "••••",    apy: 5.1, enc: true  },
];

const MY_BORROWED: Position[] = [
  { id: "sol", symbol: "SOL", type: "native", amount: "50 SOL", value: "$8,420", apy: 7.1, enc: false },
];

// ─── API reference ────────────────────────────────────────────────────────────

const API_ENDPOINTS: ApiEndpoint[] = [
  { method: "POST", path: "/v1/flash/borrow", desc: "Initiate a flash borrow. Returns a signed transaction envelope to include in your bundle.", params: [{ n: "asset", t: "string", d: "Pool asset ID — sol | btc | eth | xau | usdc" },{ n: "amount", t: "u64", d: "Lamports / base units to borrow" },{ n: "receiver", t: "pubkey", d: "Program that will receive funds and repay" }] },
  { method: "POST", path: "/v1/flash/repay",  desc: "Append the repay instruction to the same transaction. Must be the final instruction.", params: [{ n: "loan_id", t: "string", d: "Returned by /flash/borrow" },{ n: "amount", t: "u64", d: "Principal + fee in base units" }] },
  { method: "GET",  path: "/v1/flash/pools",  desc: "Returns available liquidity per pool and the current fee rate.", params: [] },
  { method: "GET",  path: "/v1/flash/history/:wallet", desc: "Returns flash loan history for a wallet address.", params: [{ n: "wallet", t: "pubkey", d: "Solana wallet address" }] },
];

const METHOD_COLOR: Record<string, string> = { GET: "#059669", POST: "#6d28d9", DELETE: "#dc2626" };

// ─── Shared helpers ───────────────────────────────────────────────────────────

function borrowRate(p: Pool, u: number): number {
  if (u <= p.optimalUtil)
    return p.baseRate + (p.slope1 * u) / p.optimalUtil;
  return p.baseRate + p.slope1 + (p.slope2 * (u - p.optimalUtil)) / (100 - p.optimalUtil);
}

function supplyRate(p: Pool, u: number): number {
  return borrowRate(p, u) * (u / 100) * (1 - p.reserveFactor / 100);
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

function Tag({ type }: { type: PoolType }) {
  const map: Record<PoolType, [string, string]> = {
    ika:    ["tag-ika",    "Ika dWallet"],
    enc:    ["tag-enc",    "FHE encrypted"],
    oro:    ["tag-oro",    "Oro / GRAIL"],
    native: ["tag-native", "Native"],
  };
  const [cls, label] = map[type];
  return <span className={`tag ${cls}`}>{label}</span>;
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function Logo() {
  return (
    <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none" }}>
      <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#6d28d9,#db2777)", boxShadow: "0 4px 14px -4px rgba(109,40,217,.5)" }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 5c4 6 12 6 16 0" /><path d="M4 12c4 6 12 6 16 0" opacity=".55" /><path d="M4 19c4 6 12 6 16 0" opacity=".28" />
        </svg>
      </span>
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.03em", color: "#0b0b10" }}>Veil</span>
    </Link>
  );
}

// ─── Privacy Toggle ───────────────────────────────────────────────────────────

function PrivacyToggle({ on, setOn }: { on: boolean; setOn: (fn: (v: boolean) => boolean) => void }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 999, border: "1px solid", borderColor: on ? "#c4b5fd" : "#e7e7ec", background: on ? "#ede9fe" : "white", cursor: "pointer", userSelect: "none", transition: "all .2s" }}
      onClick={() => setOn((v) => !v)}
    >
      <div className={`toggle-track ${on ? "on" : ""}`} style={{ width: 26, height: 15 }}>
        <div className="toggle-thumb" style={{ width: 10, height: 10, top: 2.5, left: 2.5 }} />
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? "#4c1d95" : "#5b5b66" }}>
        {on ? "FHE on" : "Privacy off"}
      </span>
      {on && (
        <svg viewBox="0 0 16 16" width="11" height="11" fill="#6d28d9">
          <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
        </svg>
      )}
    </div>
  );
}

// ─── App Nav ──────────────────────────────────────────────────────────────────

function AppNav({ view, setView, fhe, setFhe }: {
  view: View;
  setView: (v: View) => void;
  fhe: boolean;
  setFhe: (fn: (v: boolean) => boolean) => void;
}) {
  const { publicKey } = useWallet();
  const tabs: { id: View; label: string }[] = [
    { id: "markets",   label: "Markets"     },
    { id: "portfolio", label: "Portfolio"   },
    { id: "flash",     label: "Flash Loans" },
  ];

  return (
    <header style={{ position: "sticky", top: 0, zIndex: 50, padding: "10px 20px" }}>
      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 52, borderRadius: 999, border: "1px solid rgba(231,231,236,.8)", background: "rgba(255,255,255,.8)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", padding: "0 8px 0 18px", boxShadow: "0 1px 0 rgba(255,255,255,.7) inset,0 8px 24px -8px rgba(76,29,149,.1)" }}>
        <Logo />
        <div style={{ display: "flex", gap: 3, background: "#f4f4f6", borderRadius: 999, padding: 3 }}>
          {tabs.map((t) => (
            <button key={t.id} className={`dapp-tab ${view === t.id ? "active" : ""}`} onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PrivacyToggle on={fhe} setOn={setFhe} />
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: "1px solid #e7e7ec", background: "white", fontSize: 12, color: "#5b5b66", fontWeight: 500 }}>
            <span className="pulse-dot" style={{ width: 6, height: 6 }} />
            Devnet
          </div>
          <Link href="/dapp/markets"   style={navPillStyle} title="Live markets driven by /api/pools">Markets</Link>
          <Link href="/dapp/positions" style={navPillStyle} title="Your positions">Positions</Link>
          <Link href="/dapp/history"   style={navPillStyle} title="Tx history">History</Link>
          <Link href="/dapp/liquidate" style={navPillStyle} title="Liquidator">Liquidate</Link>
          <Link href="/dapp/faucet"    style={navPillStyle} title="Devnet airdrop">Faucet</Link>
          <Link href="/dapp/admin" style={{ ...navPillStyle, fontWeight: 600 }} title="Admin panel">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="#9ca3af" style={{ marginRight: 4 }}><path d="M8 1a5 5 0 100 10A5 5 0 008 1zm0 8a3 3 0 110-6 3 3 0 010 6zm4.5 1.5h-9a.5.5 0 00-.5.5v.5a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V11a.5.5 0 00-.5-.5z"/></svg>
            Admin
          </Link>
          <WalletMultiButton style={{
            fontSize: "12.5px",
            height: "34px",
            borderRadius: "999px",
            padding: "0 14px",
            background: publicKey ? "#ecfdf5" : "#0b0b10",
            color: publicKey ? "#065f46" : "#ffffff",
            border: publicKey ? "1px solid #a7f3d0" : "none",
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }} />
        </div>
      </nav>
    </header>
  );
}

const navPillStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, padding: "4px 10px",
  borderRadius: 999, border: "1px solid #e7e7ec", background: "white",
  fontSize: 12, color: "#5b5b66", fontWeight: 500,
  textDecoration: "none", transition: "all .15s",
};

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,.7)", border: "1px solid #f0f0f3", borderRadius: 12, padding: "12px 16px" }}>
      <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 5, letterSpacing: ".02em", textTransform: "uppercase" as const }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", color: color ?? "#0b0b10" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── Asset Icon ───────────────────────────────────────────────────────────────

function AssetIcon({ pool, size = 34 }: { pool: Pool; size?: number }) {
  const bg =
    pool.type === "ika"   ? "linear-gradient(135deg,#f97316,#eab308)"
    : pool.type === "oro" ? "linear-gradient(135deg,#eab308,#ca8a04)"
    : pool.type === "enc" ? "linear-gradient(135deg,#6d28d9,#9333ea)"
    :                       "linear-gradient(135deg,#7c3aed,#6d28d9)";
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.29, display: "grid", placeItems: "center", fontSize: size * 0.41, fontWeight: 700, flexShrink: 0, background: bg, color: "white" }}>
      {pool.icon}
    </div>
  );
}

// ─── Util Bar ─────────────────────────────────────────────────────────────────

function UtilBar({ pct }: { pct: number }) {
  const color = pct > 80 ? "#dc2626" : pct > 60 ? "#d97706" : "#059669";
  return (
    <div style={{ marginTop: 4, height: 3, background: "#f0f0f3", borderRadius: 2, overflow: "hidden", width: "80%" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width .6s" }} />
    </div>
  );
}

// ─── IRM Chart ────────────────────────────────────────────────────────────────

function IrmChart({ pool }: { pool: Pool }) {
  const VW = 240, VH = 110;
  const padL = 30, padB = 22, padT = 8, padR = 10;
  const cW = VW - padL - padR;
  const cH = VH - padT - padB;

  const maxRate = pool.baseRate + pool.slope1 + pool.slope2;
  const maxY = Math.max(Math.ceil(maxRate / 10) * 10, 20);

  const X = (u: number) => padL + (u / 100) * cW;
  const Y = (r: number) => padT + cH - Math.min((r / maxY) * cH, cH);

  const bp = Array.from({ length: 101 }, (_, i) => `${X(i).toFixed(1)},${Y(borrowRate(pool, i)).toFixed(1)}`).join(" ");
  const sp = Array.from({ length: 101 }, (_, i) => `${X(i).toFixed(1)},${Y(supplyRate(pool, i)).toFixed(1)}`).join(" ");

  const kx = X(pool.optimalUtil);
  const cx = X(pool.util);
  const cy = Y(borrowRate(pool, pool.util));
  const midRate = Math.round(maxY / 2);

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: "block" }}>
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + cH} stroke="#e7e7ec" strokeWidth="1" />
      <line x1={padL} y1={padT + cH} x2={VW - padR} y2={padT + cH} stroke="#e7e7ec" strokeWidth="1" />
      {/* Y grid + labels */}
      {[0, midRate, maxY].map((v) => (
        <g key={v}>
          <line x1={padL} y1={Y(v)} x2={VW - padR} y2={Y(v)} stroke="#f0f0f3" strokeWidth="1" />
          <text x={padL - 4} y={Y(v) + 3.5} textAnchor="end" fontSize="8" fill="#9ca3af">{v}%</text>
        </g>
      ))}
      {/* X labels */}
      <text x={padL} y={VH - 3} textAnchor="middle" fontSize="8" fill="#9ca3af">0%</text>
      <text x={kx} y={VH - 3} textAnchor="middle" fontSize="8" fill="#8b5cf6">{pool.optimalUtil}%</text>
      <text x={VW - padR} y={VH - 3} textAnchor="end" fontSize="8" fill="#9ca3af">100%</text>
      {/* Kink vertical dashed line */}
      <line x1={kx} y1={padT} x2={kx} y2={padT + cH} stroke="#c4b5fd" strokeWidth="1" strokeDasharray="3 2" />
      {/* Supply rate curve */}
      <polyline points={sp} fill="none" stroke="#059669" strokeWidth="1.5" opacity="0.65" />
      {/* Borrow rate curve */}
      <polyline points={bp} fill="none" stroke="#d97706" strokeWidth="2" />
      {/* Current utilization marker */}
      <line x1={cx} y1={padT} x2={cx} y2={padT + cH} stroke="#6d28d9" strokeWidth="1" strokeDasharray="3 2" />
      <circle cx={cx} cy={cy} r="3.5" fill="#d97706" stroke="white" strokeWidth="1.5" />
    </svg>
  );
}

// ─── Pool Detail Panel ────────────────────────────────────────────────────────

function PoolDetail({ pool, fhe, setModal, onClose, pythPrices }: {
  pool: Pool;
  fhe: boolean;
  setModal: (m: ModalState | null) => void;
  onClose: () => void;
  pythPrices?: PythPrices;
}) {
  const enc = fhe && pool.type === "enc";
  const utilColor = pool.util > 80 ? "#dc2626" : pool.util > 60 ? "#d97706" : "#059669";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Main reserve card */}
      <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "16px 18px 14px", borderBottom: "1px solid #f0f0f3", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AssetIcon pool={pool} size={38} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>{pool.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                <Tag type={pool.type} />
                <span style={{ fontSize: 11.5, color: "#9ca3af", fontFamily: "var(--font-mono),monospace" }}>
                  {formatPrice(pythPrices?.[pool.id], pool.price)}
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 13, color: "#5b5b66", flexShrink: 0 }}>✕</button>
        </div>

        {/* APY grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: "1px solid #f0f0f3" }}>
          {[
            { label: "Supply APY", value: `+${pool.supplyApy}%`, color: "#059669", bg: "#f0fdf4" },
            { label: "Borrow APY", value: `${pool.borrowApy}%`,  color: "#d97706", bg: "#fffbeb" },
            { label: "Utilization", value: enc ? "––" : `${pool.util}%`, color: utilColor, bg: "#fafafc" },
          ].map((s, i) => (
            <div key={i} style={{ padding: "14px 16px", background: s.bg, borderRight: i < 2 ? "1px solid #f0f0f3" : "none" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" as const, color: "#9ca3af", marginBottom: 5 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Utilization bar + liquidity */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f3" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: "#5b5b66", fontWeight: 500 }}>Pool utilization</span>
            <span style={{ fontWeight: 700, color: utilColor }}>{enc ? "––" : `${pool.util}%`}</span>
          </div>
          <div style={{ height: 6, background: "#f0f0f3", borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
            <div style={{ height: "100%", width: enc ? "0" : `${pool.util}%`, background: pool.util > 80 ? "#dc2626" : pool.util > 60 ? "#d97706" : "linear-gradient(90deg,#059669,#10b981)", borderRadius: 3, transition: "width .6s" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Total supplied</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{enc ? <CipherVal seed={0} mask="$◉◉◉,◉◉◉" /> : pool.totalSupply}</div>
            </div>
            <div style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Available</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>{enc ? "••••" : pool.availLiq}</div>
            </div>
          </div>
        </div>

        {/* IRM chart */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f3" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" as const, color: "#5b5b66", marginBottom: 10 }}>Interest Rate Model</div>
          <IrmChart pool={pool} />
          <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
            <span style={{ fontSize: 10.5, color: "#d97706", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 14, height: 2, background: "#d97706", display: "inline-block", borderRadius: 1 }} />
              Borrow APY
            </span>
            <span style={{ fontSize: 10.5, color: "#059669", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 14, height: 2, background: "#059669", display: "inline-block", borderRadius: 1, opacity: 0.65 }} />
              Supply APY
            </span>
            <span style={{ fontSize: 10.5, color: "#8b5cf6", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 10, height: 2, background: "#8b5cf6", display: "inline-block", borderRadius: 1, opacity: 0.6 }} />
              Kink
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" as const }}>
            {[
              { k: "Base", v: `${pool.baseRate}%` },
              { k: "Slope₁", v: `${pool.slope1}%` },
              { k: "Kink", v: `${pool.optimalUtil}%` },
              { k: "Slope₂", v: `${pool.slope2}%` },
            ].map((r, i) => (
              <div key={i} style={{ background: "#f4f4f6", borderRadius: 6, padding: "3px 8px", fontSize: 11 }}>
                <span style={{ color: "#9ca3af" }}>{r.k} </span>
                <span style={{ fontWeight: 700, color: "#0b0b10" }}>{r.v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Risk parameters */}
        <div style={{ padding: "14px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" as const, color: "#5b5b66", marginBottom: 10 }}>Risk Parameters</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {[
              { k: "Max LTV",        v: `${pool.ltv}%`,            info: "Maximum loan-to-value — how much you can borrow against this collateral" },
              { k: "Liq. threshold", v: `${pool.liqThreshold}%`,   info: "If your health factor drops below 1.0 at this threshold, liquidation triggers" },
              { k: "Liq. bonus",     v: `+${pool.liqBonus}%`,      info: "Discount liquidators receive on collateral — incentivizes keeping the protocol healthy" },
              { k: "Reserve factor", v: `${pool.reserveFactor}%`,  info: "Share of borrow interest that goes to the protocol treasury" },
            ].map((r, i) => (
              <div key={i} style={{ background: "#f9f9fb", borderRadius: 10, padding: "10px 12px", border: "1px solid #f0f0f3" }}>
                <div style={{ fontSize: 10.5, color: "#5b5b66", fontWeight: 500, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  {r.k}
                  <span title={r.info} style={{ width: 12, height: 12, borderRadius: 999, border: "1px solid #e7e7ec", display: "inline-grid", placeItems: "center", fontSize: 8, color: "#9ca3af", cursor: "help", flexShrink: 0 }}>?</span>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#0b0b10" }}>{r.v}</div>
              </div>
            ))}
          </div>

          {/* Oracle badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#5b5b66", padding: "8px 10px", background: "#f4f4f6", borderRadius: 8, marginBottom: 12 }}>
            <svg viewBox="0 0 16 16" width="11" height="11" fill="#6d28d9"><circle cx="8" cy="8" r="6" stroke="#6d28d9" strokeWidth="1.5" fill="none"/><path d="M8 4v4l2.5 2.5" stroke="#6d28d9" strokeWidth="1.5" strokeLinecap="round" fill="none"/></svg>
            Oracle: <span style={{ fontWeight: 600, color: "#4c1d95" }}>Pyth Network</span>
            <span style={{ marginLeft: "auto", fontSize: 10, background: "#ede9fe", color: "#6d28d9", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>live</span>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-supply"
              style={{ flex: 1, padding: "10px", borderRadius: 12, fontSize: 14, fontWeight: 700, background: pool.type === "ika" ? "linear-gradient(135deg,#f97316,#eab308)" : undefined }}
              onClick={() => setModal({ type: pool.type === "ika" ? "ika-setup" : "supply", pool })}
            >
              {pool.type === "ika" ? "Register dWallet" : "Supply"}
            </button>
            <button
              className="btn-borrow"
              style={{ flex: 1, padding: "10px", borderRadius: 12, fontSize: 14, fontWeight: 700 }}
              onClick={() => setModal({ type: "borrow", pool })}
            >
              Borrow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Position Summary ─────────────────────────────────────────────────────────

function PositionSummary({ connected, fhe, setModal }: { connected: boolean; fhe: boolean; setModal: (m: ModalState | null) => void }) {
  const collateral = connected ? "$73,440" : "$0.00";
  const liqPoint   = connected ? "$42,800" : "$0.00";
  const borrowCap  = connected ? "$55,080" : "$0.00";
  const available  = connected ? "$46,660" : "$0.00";
  const borrowUsed = connected ? 15 : 0;

  const collaterals = connected ? [
    { pool: POOLS[1], amount: "1.2 BTC",   value: "$73,440",  weight: "75%", enc: false },
    { pool: POOLS[4], amount: "•••• USDC", value: fhe ? "••••" : "$12,000", weight: "90%", enc: true },
  ] : [];

  const metrics = [
    { label: "Collateral Value",    value: collateral, info: "Total USD value of supplied assets",        color: connected ? "#0b0b10" : "#c4c4cc" },
    { label: "Liquidation Point",   value: liqPoint,   info: "BTC price that triggers liquidation",       color: connected ? "#dc2626" : "#c4c4cc" },
    { label: "Borrow Capacity",     value: borrowCap,  info: "Max you can borrow against your collateral",color: connected ? "#0b0b10" : "#c4c4cc" },
    { label: "Available to Borrow", value: available,  info: "Capacity remaining after current borrows",  color: connected ? "#059669" : "#c4c4cc" },
  ];

  return (
    <div style={{ position: "sticky", top: 82, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid #f0f0f3" }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" as const, color: "#5b5b66", marginBottom: 2 }}>Position Summary</div>
          {!connected && <div style={{ fontSize: 12, color: "#5b5b66", marginTop: 4 }}>Connect wallet to see your position</div>}
        </div>
        <div style={{ padding: "0 0 4px" }}>
          {metrics.map((m, i) => (
            <div key={i} style={{ padding: "13px 18px", borderBottom: i < 3 ? "1px solid #f7f7f9" : "none" }}>
              <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 5, display: "flex", alignItems: "center", gap: 5 }}>
                {m.label}
                <span title={m.info} style={{ width: 13, height: 13, borderRadius: 999, border: "1px solid #e7e7ec", display: "inline-grid", placeItems: "center", fontSize: 9, color: "#9ca3af", cursor: "help", flexShrink: 0 }}>?</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", color: m.color }}>{m.value}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: "12px 18px 16px", borderTop: "1px solid #f0f0f3" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: "#5b5b66", fontWeight: 500 }}>Borrow capacity used</span>
            <span style={{ fontWeight: 700, color: borrowUsed > 80 ? "#dc2626" : borrowUsed > 60 ? "#d97706" : "#059669" }}>{borrowUsed}%</span>
          </div>
          <div style={{ height: 6, background: "#f0f0f3", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${borrowUsed}%`, borderRadius: 3, background: borrowUsed > 80 ? "#dc2626" : borrowUsed > 60 ? "#d97706" : "linear-gradient(90deg,#059669,#10b981)", transition: "width .6s" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
            <span>0%</span><span>Liquidation at 100%</span>
          </div>
        </div>
      </div>

      <div className="glass-card" style={{ borderRadius: 18, padding: 18 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" as const, color: "#5b5b66", marginBottom: 12 }}>Your Collateral</div>
        {!connected ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 12 }}>No collateral posted</div>
            <button className="btn-supply" style={{ fontSize: 12.5, padding: "7px 18px" }} onClick={() => setModal({ type: "supply", pool: POOLS[0] })}>Supply assets</button>
          </div>
        ) : (
          <>
            {collaterals.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: i < collaterals.length - 1 ? "1px solid #f7f7f9" : "none" }}>
                <AssetIcon pool={c.pool} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{c.pool.symbol}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {c.enc && fhe ? <CipherVal seed={20} mask="$◉◉,◉◉◉" /> : c.value}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                    <span style={{ fontSize: 11.5, color: "#5b5b66" }}>
                      {c.enc && fhe ? <CipherVal seed={21} mask="◉◉◉◉ USDC" /> : c.amount}
                    </span>
                    <span style={{ fontSize: 11, color: "#5b5b66" }}>CF {c.weight}</span>
                  </div>
                </div>
              </div>
            ))}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #f0f0f3", display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "#5b5b66", fontWeight: 500 }}>Total collateral</span>
              <span style={{ fontWeight: 700 }}>$73,440</span>
            </div>
            <button className="btn-supply" style={{ width: "100%", marginTop: 12, padding: "8px", borderRadius: 10, fontSize: 13 }} onClick={() => setModal({ type: "supply", pool: POOLS[0] })}>
              + Add collateral
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Markets View ─────────────────────────────────────────────────────────────

function MarketsView({ fhe, connected, setModal }: { fhe: boolean; connected: boolean; setModal: (m: ModalState | null) => void }) {
  const [poolTab, setPoolTab] = useState<"all" | "supply" | "borrow">("all");
  const [selectedPool, setSelectedPool] = useState<Pool | null>(null);
  const pythPrices = usePythPrices();

  const colStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "2fr 1.2fr 0.8fr 1.2fr 0.8fr 80px 28px",
    alignItems: "center",
  };

  return (
    <div className="fade-rise" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 20px 40px" }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "#5b5b66", letterSpacing: ".05em", textTransform: "uppercase" }}>Protocol overview</span>
        <span style={{ fontSize: 11.5, color: "#9ca3af" }}>— all figures are protocol-wide, not your portfolio</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
        <MetricCard label="Total Supplied"  value="$5.78M" sub="Protocol-wide" />
        <MetricCard label="Total Borrowed"  value="$2.69M" sub="Protocol-wide" />
        <MetricCard label="Utilization"     value="46%"    color="#d97706" sub="Avg across pools" />
        <MetricCard label="Best Supply APY" value="5.1%"   color="#059669" sub="USDC pool" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: selectedPool ? "1fr 360px" : "1fr 320px", gap: 16, alignItems: "start", transition: "grid-template-columns .25s" }}>
        <div>
          <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 0", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 3, background: "#f4f4f6", borderRadius: 999, padding: 3 }}>
                {([
                  { id: "all",    label: "All pools" },
                  { id: "supply", label: "Supply"    },
                  { id: "borrow", label: "Borrow"    },
                ] as { id: "all" | "supply" | "borrow"; label: string }[]).map((t) => (
                  <button key={t.id} className={`dapp-tab ${poolTab === t.id ? "active" : ""}`} style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setPoolTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
              {fhe && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#4c1d95", fontWeight: 500, background: "#ede9fe", padding: "4px 10px", borderRadius: 999 }}>
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
                  FHE active
                </div>
              )}
            </div>

            {/* Column headers */}
            <div style={{ ...colStyle, padding: "10px 18px", marginTop: 10, borderBottom: "1px solid #f0f0f3" }}>
              {["Asset", "Total supply", "Supply APY", "Total borrow", "Borrow APY", "Utilization", ""].map((h, i) => (
                <span key={i} style={{ fontSize: 11, color: "#5b5b66", fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" }}>{h}</span>
              ))}
            </div>

            {POOLS.map((p, idx) => {
              const enc = fhe && p.type === "enc";
              const isSelected = selectedPool?.id === p.id;
              const utilColor = p.util > 80 ? "#dc2626" : p.util > 60 ? "#d97706" : "#059669";

              return (
                <div
                  key={p.id}
                  className="pool-row"
                  style={{
                    ...colStyle,
                    padding: "13px 18px",
                    borderBottom: idx < POOLS.length - 1 ? "1px solid #f7f7f9" : "none",
                    cursor: "pointer",
                    background: isSelected ? "#faf9ff" : "transparent",
                    borderLeft: isSelected ? "3px solid #6d28d9" : "3px solid transparent",
                    transition: "background .12s, border-left .12s",
                  }}
                  onClick={() => setSelectedPool(isSelected ? null : p)}
                >
                  {/* Asset */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <AssetIcon pool={p} />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>{p.symbol}</div>
                      <Tag type={p.type} />
                    </div>
                  </div>

                  {/* Total supply */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "#0b0b10" }}>
                      {enc ? <CipherVal seed={idx * 2} mask="$◉◉◉,◉◉◉" /> : p.totalSupply}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{enc ? "––" : p.availLiq + " avail"}</div>
                  </div>

                  {/* Supply APY */}
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>+{p.supplyApy}%</div>

                  {/* Total borrow */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "#0b0b10" }}>
                      {enc ? <CipherVal seed={idx * 2 + 1} mask="$◉◉◉,◉◉◉" /> : p.totalBorrow}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                      {enc ? "––" : `${p.ltv}% LTV`}
                    </div>
                  </div>

                  {/* Borrow APY */}
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#d97706" }}>{p.borrowApy}%</div>

                  {/* Utilization */}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: utilColor }}>{enc ? "––" : `${p.util}%`}</span>
                    </div>
                    <UtilBar pct={enc ? 0 : p.util} />
                  </div>

                  {/* Chevron */}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke={isSelected ? "#6d28d9" : "#c4c4cc"} strokeWidth="2" strokeLinecap="round" style={{ transform: isSelected ? "rotate(180deg)" : "none", transition: "transform .2s, stroke .2s" }}>
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 10, padding: "9px 14px", background: "rgba(255,255,255,.55)", border: "1px solid #f0f0f3", borderRadius: 10, fontSize: 11.5, color: "#5b5b66", display: "flex", alignItems: "center", gap: 7 }}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9"><path d="M11 1l-6 8h3l-1 6 6-8h-3l1-6z" /></svg>
            Kink-based rate model · Pyth oracle price feeds · Click any pool to view reserve details
          </div>
        </div>

        {/* Right panel: pool detail or position summary */}
        <div style={{ position: "sticky", top: 82 }}>
          {selectedPool ? (
            <PoolDetail pool={selectedPool} fhe={fhe} setModal={setModal} onClose={() => setSelectedPool(null)} pythPrices={pythPrices} />
          ) : (
            <PositionSummary connected={connected} fhe={fhe} setModal={setModal} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Portfolio View ───────────────────────────────────────────────────────────

function PortfolioView({ fhe, connected, setModal }: { fhe: boolean; connected: boolean; setModal: (m: ModalState | null) => void }) {
  if (!connected) {
    return (
      <div className="fade-rise" style={{ maxWidth: 1240, margin: "60px auto", padding: "0 20px", textAlign: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: 16, background: "#f4f4f6", border: "1px solid #e7e7ec", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Connect your wallet</div>
        <div style={{ fontSize: 14, color: "#5b5b66" }}>Connect a Solana wallet to view your positions and manage collateral.</div>
      </div>
    );
  }

  const hf = 1.87;
  const hfColor = hf > 1.5 ? "#059669" : hf > 1.1 ? "#d97706" : "#dc2626";

  return (
    <div className="fade-rise" style={{ maxWidth: 1240, margin: "0 auto", padding: "0 20px 40px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
        <MetricCard label="Net Worth"      value="$14,200" />
        <MetricCard label="Total Supplied" value="$21,000" color="#059669" />
        <MetricCard label="Total Borrowed" value="$8,400"  color="#dc2626" />
        <MetricCard label="Health Factor"  value={String(hf)} color={hfColor} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 300px", gap: 16, alignItems: "start" }}>
        {/* Supplied */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#5b5b66", letterSpacing: ".06em", textTransform: "uppercase" as const, marginBottom: 14 }}>Supplied</div>
          {MY_SUPPLIED.map((pos, i) => {
            const enc = fhe && pos.enc;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", background: "#f9f9fb", borderRadius: 12, marginBottom: 8, border: "1px solid #f0f0f3" }}>
                <AssetIcon pool={POOLS.find((p) => p.id === pos.id)!} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{pos.symbol}</span>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{enc ? <CipherVal seed={i + 10} mask="$◉◉,◉◉◉" /> : pos.value}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                    <Tag type={pos.type} />
                    <span style={{ fontSize: 12, color: "#059669", fontWeight: 500 }}>+{pos.apy}% APY</span>
                  </div>
                </div>
                <button className="btn-borrow" style={{ fontSize: 11.5, padding: "4px 10px", flexShrink: 0 }} onClick={() => setModal({ type: "withdraw", pool: POOLS.find((p) => p.id === pos.id)! })}>
                  Withdraw
                </button>
              </div>
            );
          })}
          <div style={{ borderTop: "1px solid #f0f0f3", marginTop: 8, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 12 }}>
            <span style={{ color: "#5b5b66" }}>Total supplied</span>
            <span style={{ fontWeight: 700, color: "#059669" }}>$21,000</span>
          </div>
          <button className="btn-supply" style={{ width: "100%", padding: "9px", borderRadius: 10, fontSize: 13 }} onClick={() => setModal({ type: "supply", pool: POOLS[0] })}>
            + Supply more
          </button>
        </div>

        {/* Borrowed + Risk */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#5b5b66", letterSpacing: ".06em", textTransform: "uppercase" as const, marginBottom: 14 }}>Borrowed</div>
            {MY_BORROWED.map((pos, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", background: "#f9f9fb", borderRadius: 12, marginBottom: 8, border: "1px solid #f0f0f3" }}>
                <AssetIcon pool={POOLS.find((p) => p.id === pos.id)!} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{pos.symbol}</span>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{pos.value}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <Tag type={pos.type} />
                    <span style={{ fontSize: 12, color: "#dc2626", fontWeight: 500 }}>{pos.apy}% APY</span>
                  </div>
                </div>
                <button className="btn-borrow" style={{ fontSize: 11.5, padding: "4px 10px", flexShrink: 0 }} onClick={() => setModal({ type: "repay", pool: POOLS.find((p) => p.id === pos.id)! })}>
                  Repay
                </button>
              </div>
            ))}
            <div style={{ borderTop: "1px solid #f0f0f3", marginTop: 8, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 12 }}>
              <span style={{ color: "#5b5b66" }}>Total borrowed</span>
              <span style={{ fontWeight: 700, color: "#dc2626" }}>$8,400</span>
            </div>
            <button className="btn-borrow" style={{ width: "100%", padding: "9px", borderRadius: 10, fontSize: 13 }} onClick={() => setModal({ type: "borrow", pool: POOLS[0] })}>
              + Borrow more
            </button>
          </div>

          <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#5b5b66", letterSpacing: ".06em", textTransform: "uppercase" as const, marginBottom: 14 }}>Risk</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
              <span style={{ color: "#5b5b66" }}>Health factor</span>
              <span style={{ fontWeight: 700, color: hfColor }}>{hf} · Safe</span>
            </div>
            <div className="hf-bar-wrap" style={{ margin: "0 0 4px" }}>
              <div className="hf-bar" style={{ width: "74%", background: hfColor }} />
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 14 }}>Liquidation below 1.0</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                { k: "Borrow limit used",   v: "15%"          },
                { k: "Net APY",             v: "+1.2%", c: "#059669" },
                { k: "Liq. price (BTC)",    v: "< $42,800"    },
                { k: "Available to borrow", v: "$46,660", c: "#059669" },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "#5b5b66" }}>{r.k}</span>
                  <span style={{ fontWeight: 600, color: r.c ?? "#0b0b10" }}>{r.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <PositionSummary connected={connected} fhe={fhe} setModal={setModal} />
      </div>
    </div>
  );
}

// ─── Flash Loans View ─────────────────────────────────────────────────────────

function FlashView({ connected, fhe }: { connected: boolean; fhe: boolean }) {
  const [asset, setAsset] = useState("sol");
  const [amount, setAmount] = useState("");
  const [openEndpoint, setOpenEndpoint] = useState<number | null>(null);
  const pool = POOLS.find((p) => p.id === asset)!;
  const { flashExecute, status, txSig, errorMsg, reset } = useVeilActions();

  return (
    <div className="fade-rise" style={{ maxWidth: 1240, margin: "0 auto", padding: "0 20px 40px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 16, alignItems: "start", marginBottom: 16 }}>
        {/* Info panel */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".08em", color: "#5b5b66", textTransform: "uppercase" as const, marginBottom: 12 }}>Flash Loans</div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 8 }}>Atomic, uncollateralized liquidity</div>
          <p style={{ fontSize: 14, color: "#5b5b66", lineHeight: 1.7, marginBottom: 18 }}>
            Borrow any amount within a single Solana transaction — no collateral required. Funds must be returned with fee by the final instruction. If repayment is insufficient, the transaction reverts atomically.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
            {[{ k: "Fee", v: "0.09%" }, { k: "LP share", v: "90%" }, { k: "Max borrow", v: "Free liquidity" }, { k: "Enforcement", v: "Program-level" }].map((r, i) => (
              <div key={i} style={{ background: "#f4f4f6", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, color: "#5b5b66", fontWeight: 500, marginBottom: 2 }}>{r.k}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#5b5b66", letterSpacing: ".04em", textTransform: "uppercase" as const, marginBottom: 8 }}>Available liquidity</div>
          {POOLS.map((p, i) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: i < POOLS.length - 1 ? "1px solid #f7f7f9" : "none" }}>
              <AssetIcon pool={p} size={22} />
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{p.symbol}</span>
              <span style={{ fontSize: 13, color: "#5b5b66" }}>{p.availLiq}</span>
              <span style={{ fontSize: 11, color: p.util > 70 ? "#dc2626" : p.util > 50 ? "#d97706" : "#059669", fontWeight: 600, background: p.util > 70 ? "#fef2f2" : p.util > 50 ? "#fffbeb" : "#ecfdf5", padding: "2px 7px", borderRadius: 999 }}>
                {p.util}% used
              </span>
            </div>
          ))}
        </div>

        {/* Form */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>New flash loan</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Asset</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {POOLS.map((p) => (
                <button key={p.id} onClick={() => setAsset(p.id)} style={{ padding: "5px 12px", borderRadius: 999, border: "1px solid", borderColor: asset === p.id ? "#6d28d9" : "#e7e7ec", background: asset === p.id ? "#ede9fe" : "white", color: asset === p.id ? "#4c1d95" : "#5b5b66", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .15s" }}>
                  {p.symbol}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Amount</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f4f4f6", border: "1px solid #e7e7ec", borderRadius: 12, padding: "10px 14px" }}>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 20, fontWeight: 600, color: "#0b0b10", width: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}>{pool.symbol}</span>
            </div>
            <div style={{ fontSize: 11.5, color: "#5b5b66", marginTop: 4 }}>
              Available: {pool.availLiq} · Fee: {amount ? (parseFloat(amount) * 0.0009).toFixed(4) : 0} {pool.symbol}
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Repayment instruction</div>
            <div style={{ background: "#0b0b10", borderRadius: 12, padding: "12px 14px", fontFamily: "var(--font-mono),monospace", fontSize: 11.5, lineHeight: 1.8 }}>
              <span style={{ color: "#9ca3af" }}>{"// append to your transaction"}</span><br />
              <span style={{ color: "#a78bfa" }}>flash_borrow</span><span style={{ color: "#e5e7eb" }}>(</span><span style={{ color: "#6ee7b7" }}>{pool.symbol.toLowerCase()}</span><span style={{ color: "#e5e7eb" }}>, amount);</span><br />
              <span style={{ color: "#9ca3af" }}>{"// ... your instructions ..."}</span><br />
              <span style={{ color: "#a78bfa" }}>flash_repay</span><span style={{ color: "#e5e7eb" }}>(loan_id, amount + fee);</span>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #f0f0f3", paddingTop: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { k: "Borrow amount", v: amount ? `${amount} ${pool.symbol}` : "—" },
              { k: "Fee (0.09%)",   v: amount ? `${(parseFloat(amount) * 0.0009).toFixed(4)} ${pool.symbol}` : "—" },
              { k: "Repayment due", v: amount ? `${(parseFloat(amount) * 1.0009).toFixed(4)} ${pool.symbol}` : "—" },
            ].map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                <span style={{ color: "#5b5b66" }}>{r.k}</span>
                <span style={{ fontWeight: 600 }}>{r.v}</span>
              </div>
            ))}
          </div>
          {fhe ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ background: "linear-gradient(135deg,#ede9fe,#fdf2ff)", border: "1px solid #c4b5fd", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                <svg viewBox="0 0 16 16" width="13" height="13" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
                <span style={{ fontSize: 12.5, color: "#4c1d95", fontWeight: 500 }}>Private flash loans via FHE are coming soon.</span>
              </div>
              <button disabled style={{ width: "100%", padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#6d28d9,#9333ea)", color: "rgba(255,255,255,.6)", border: "none", fontSize: 14, fontWeight: 700, cursor: "not-allowed", letterSpacing: "-0.01em", opacity: 0.6 }}>
                Coming Soon
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {status === "success" && txSig && (
                <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#065f46", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 500 }}>Transaction confirmed</span>
                  <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer" style={{ color: "#059669", fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-mono),monospace", fontSize: 11 }}>
                    {txSig.slice(0, 8)}…{txSig.slice(-6)} ↗
                  </a>
                </div>
              )}
              {status === "error" && errorMsg && (
                <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#991b1b" }}>
                  {errorMsg}
                </div>
              )}
              <button
                disabled={!connected || !amount || ["building", "signing", "confirming"].includes(status)}
                onClick={() => { reset(); flashExecute(asset, BigInt(Math.round(parseFloat(amount || "0") * 1e9))); }}
                style={{ width: "100%", padding: "11px", borderRadius: 12, background: connected && amount ? "#0b0b10" : "#e7e7ec", color: connected && amount ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: connected && amount ? "pointer" : "not-allowed", letterSpacing: "-0.01em", transition: "all .2s" }}
              >
                {!connected ? "Connect wallet to continue"
                  : status === "building"   ? "Building transaction…"
                  : status === "signing"    ? "Approve in wallet…"
                  : status === "confirming" ? "Confirming…"
                  : "Execute flash loan"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* API Reference */}
      <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>API Reference</div>
          <span style={{ fontSize: 11, fontWeight: 600, background: "#f4f4f6", color: "#5b5b66", padding: "2px 9px", borderRadius: 999, letterSpacing: ".04em" }}>MOCK · Not deployed</span>
        </div>
        <div style={{ fontSize: 13, color: "#5b5b66", marginBottom: 18 }}>
          REST + JSON · Base URL: <span className="mono" style={{ color: "#6d28d9", fontSize: 12 }}>https://api.veil.fi</span> · Auth: <span className="mono" style={{ fontSize: 12 }}>Bearer &lt;jwt&gt;</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {API_ENDPOINTS.map((ep, i) => {
            const open = openEndpoint === i;
            return (
              <div key={i} style={{ border: "1px solid #f0f0f3", borderRadius: 12, overflow: "hidden", transition: "box-shadow .15s", boxShadow: open ? "0 4px 16px -4px rgba(109,40,217,.1)" : "none" }}>
                <div onClick={() => setOpenEndpoint(open ? null : i)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer", background: open ? "#fafafc" : "transparent", userSelect: "none" }}>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, fontWeight: 700, color: METHOD_COLOR[ep.method] ?? "#0b0b10", background: (METHOD_COLOR[ep.method] ?? "#0b0b10") + "18", padding: "2px 8px", borderRadius: 6, flexShrink: 0, minWidth: 44, textAlign: "center" as const }}>{ep.method}</span>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{ep.path}</span>
                  <span style={{ fontSize: 13, color: "#9ca3af", flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.desc}</span>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0 }}><path d="M4 6l4 4 4-4" /></svg>
                </div>
                {open && (
                  <div style={{ padding: "12px 16px", borderTop: "1px solid #f0f0f3", background: "#fafafc" }}>
                    <div style={{ fontSize: 13, color: "#5b5b66", marginBottom: ep.params.length ? 12 : 0, lineHeight: 1.6 }}>{ep.desc}</div>
                    {ep.params.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" as const, color: "#9ca3af", marginBottom: 8 }}>Parameters</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {ep.params.map((p, j) => (
                            <div key={j} style={{ display: "grid", gridTemplateColumns: "120px 70px 1fr", gap: 10, alignItems: "start", fontSize: 13 }}>
                              <span className="mono" style={{ fontWeight: 600, color: "#0b0b10" }}>{p.n}</span>
                              <span style={{ color: "#6d28d9", fontFamily: "var(--font-mono),monospace", fontSize: 11.5 }}>{p.t}</span>
                              <span style={{ color: "#5b5b66" }}>{p.d}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Ika dWallet Setup Modal ──────────────────────────────────────────────────

type IkaStep = "create" | "transfer" | "register" | "done";

const IKA_STEPS: { id: IkaStep; label: string; desc: string }[] = [
  { id: "create",   label: "Create dWallet",       desc: "Run 2PC-MPC distributed key generation via the Ika network" },
  { id: "transfer", label: "Transfer authority",    desc: "Hand dWallet control to Veil's CPI authority PDA" },
  { id: "register", label: "Register collateral",   desc: "Create an IkaDwalletPosition on Veil and unlock borrowing" },
  { id: "done",     label: "Ready",                 desc: "Your cross-chain collateral is live" },
];

function IkaStepIcon({ step, current, done }: { step: IkaStep; current: IkaStep; done: boolean }) {
  const steps = IKA_STEPS.map((s) => s.id);
  const idx = steps.indexOf(step);
  const curIdx = steps.indexOf(current);
  const isActive = step === current;
  const isPast = done || idx < curIdx;

  const bg = isPast ? "#059669" : isActive ? "#6d28d9" : "#f0f0f3";
  const color = isPast || isActive ? "white" : "#9ca3af";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 26, height: 26, borderRadius: 999, background: bg, color, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, transition: "background .25s" }}>
        {isPast ? "✓" : idx + 1}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: isActive ? 700 : 500, color: isActive ? "#0b0b10" : isPast ? "#5b5b66" : "#9ca3af" }}>
        {IKA_STEPS[idx].label}
      </div>
    </div>
  );
}

function IkaSetupModal({ pool, setModal }: { pool: Pool; setModal: (m: ModalState | null) => void }) {
  const { publicKey, sendTransaction } = useWallet();
  const [step, setStep] = useState<IkaStep>("create");
  const [dwalletAddr, setDwalletAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [txSig, setTxSig] = useState("");
  const isDone = step === "done";

  const accentBg = "linear-gradient(135deg,#f97316,#eab308)";

  async function handleCreate() {
    if (!publicKey) return;
    setBusy(true); setErr("");
    try {
      // In production this triggers an Ika gRPC DKG flow.
      // For devnet pre-alpha we simulate a 2-second DKG delay.
      await new Promise((r) => setTimeout(r, 2000));
      // Simulate a newly created dWallet address
      const mock = publicKey.toBase58().slice(0, 8) + "…dWallet";
      setDwalletAddr(mock);
      setStep("transfer");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "DKG failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleTransfer() {
    if (!publicKey || !sendTransaction) return;
    setBusy(true); setErr("");
    try {
      // In production: build a tx that calls transfer_dwallet on the Ika program.
      // For devnet pre-alpha we simulate the signing step.
      await new Promise((r) => setTimeout(r, 1500));
      setStep("register");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister() {
    if (!publicKey || !sendTransaction) return;
    setBusy(true); setErr("");
    try {
      // In production: call ikaRegisterIx from lib/ika/instructions.ts,
      // derive IkaDwalletPosition PDA, and submit the transaction.
      await new Promise((r) => setTimeout(r, 1800));
      setTxSig("5KgR…mock");
      setStep("done");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  const stepContent: Record<IkaStep, React.ReactNode> = {
    create: (
      <div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>
          A <strong>dWallet</strong> is a 2PC-MPC key controlled jointly by you and the Ika MPC network.
          Your {pool.symbol} stays on its native chain; only Veil's CPI authority can approve signatures.
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {[
            { icon: "🔑", t: "Distributed key generation", d: "DKG runs over gRPC with the Ika pre-alpha network — takes ~2s" },
            { icon: "🔒", t: "No custody risk",            d: "Neither Veil nor Ika can move funds unilaterally" },
            { icon: "⚡", t: "Native asset collateral",    d: `Your ${pool.symbol} never leaves its chain` },
          ].map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "10px 12px", background: "#f9f9fb", borderRadius: 10, border: "1px solid #f0f0f3" }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{r.icon}</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#0b0b10", marginBottom: 2 }}>{r.t}</div>
                <div style={{ fontSize: 11.5, color: "#5b5b66" }}>{r.d}</div>
              </div>
            </div>
          ))}
        </div>
        <button
          disabled={busy || !publicKey}
          onClick={handleCreate}
          style={{ width: "100%", padding: "11px", borderRadius: 12, background: publicKey ? accentBg : "#e7e7ec", color: publicKey ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: publicKey ? "pointer" : "not-allowed", letterSpacing: "-0.01em" }}
        >
          {busy ? "Running DKG…" : !publicKey ? "Connect wallet first" : "Create dWallet"}
        </button>
      </div>
    ),

    transfer: (
      <div>
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12.5, color: "#065f46", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span>✓</span>
          <div>
            <div style={{ fontWeight: 600 }}>dWallet created</div>
            <div style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, marginTop: 2, color: "#059669" }}>{dwalletAddr}</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>
          Transfer the dWallet's authority to <strong>Veil's CPI authority PDA</strong>.
          This lets Veil approve signatures for cross-chain collateral operations without holding your keys.
        </div>
        <div style={{ background: "#0b0b10", borderRadius: 10, padding: "10px 14px", fontFamily: "var(--font-mono),monospace", fontSize: 11, lineHeight: 1.8, marginBottom: 16, color: "#e5e7eb" }}>
          <span style={{ color: "#9ca3af" }}>// Ika program CPI</span><br />
          <span style={{ color: "#a78bfa" }}>transfer_dwallet</span>
          <span>(dwallet, </span>
          <span style={{ color: "#6ee7b7" }}>veil_cpi_authority</span>
          <span>);</span>
        </div>
        <button
          disabled={busy}
          onClick={handleTransfer}
          style={{ width: "100%", padding: "11px", borderRadius: 12, background: accentBg, color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: "-0.01em" }}
        >
          {busy ? "Signing transaction…" : "Transfer authority"}
        </button>
      </div>
    ),

    register: (
      <div>
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12.5, color: "#065f46" }}>
          ✓ Authority transferred to Veil CPI PDA
        </div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>
          Register the dWallet as collateral on Veil. This creates an <strong>IkaDwalletPosition</strong> PDA
          that tracks the cross-chain collateral value and allows borrowing against it.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          {[
            { k: "Collateral",   v: `${pool.symbol} (native)` },
            { k: "Max LTV",      v: `${pool.ltv}%` },
            { k: "Liq. at",      v: `${pool.liqThreshold}%` },
            { k: "Curve",        v: pool.id === "btc" ? "secp256k1" : "secp256k1" },
          ].map((r, i) => (
            <div key={i} style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
              <div style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>{r.k}</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.v}</div>
            </div>
          ))}
        </div>
        <button
          disabled={busy}
          onClick={handleRegister}
          style={{ width: "100%", padding: "11px", borderRadius: 12, background: accentBg, color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: "-0.01em" }}
        >
          {busy ? "Registering…" : `Register ${pool.symbol} collateral`}
        </button>
      </div>
    ),

    done: (
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div style={{ width: 52, height: 52, borderRadius: 999, background: "#ecfdf5", border: "2px solid #a7f3d0", display: "grid", placeItems: "center", margin: "0 auto 14px", fontSize: 22 }}>✓</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Collateral registered!</div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.6, marginBottom: 16 }}>
          Your {pool.symbol} dWallet is live as cross-chain collateral.<br />
          You can now borrow USDC, SOL, and more against it.
        </div>
        {txSig && (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#065f46", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 500 }}>IkaRegister confirmed</span>
            <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11, color: "#059669" }}>{txSig} ↗</span>
          </div>
        )}
        <button
          onClick={() => setModal(null)}
          style={{ width: "100%", padding: "11px", borderRadius: 12, background: "#0b0b10", color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
        >
          Done — go to Markets
        </button>
      </div>
    ),
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
      <div style={{ background: "white", borderRadius: 20, padding: 24, width: "100%", maxWidth: 420, boxShadow: "0 30px 60px -12px rgba(76,29,149,.2),0 12px 30px -8px rgba(10,10,20,.15)", position: "relative" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AssetIcon pool={pool} size={36} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Register {pool.symbol} Collateral</div>
              <Tag type={pool.type} />
            </div>
          </div>
          <button onClick={() => setModal(null)} style={{ width: 28, height: 28, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 14, color: "#5b5b66" }}>✕</button>
        </div>

        {/* Step progress */}
        {!isDone && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", background: "#f9f9fb", borderRadius: 12, marginBottom: 18, border: "1px solid #f0f0f3" }}>
            {IKA_STEPS.filter((s) => s.id !== "done").map((s) => (
              <IkaStepIcon key={s.id} step={s.id} current={step} done={isDone} />
            ))}
          </div>
        )}

        {/* Error banner */}
        {err && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#991b1b", marginBottom: 12 }}>
            {err}
          </div>
        )}

        {/* Step content */}
        {stepContent[step]}
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function InfoRow({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span style={{ color: "#5b5b66" }}>{k}</span>
      <span style={{ fontWeight: 600, color: vc ?? "#0b0b10" }}>{v}</span>
    </div>
  );
}

function Modal({ modal, setModal, fhe }: { modal: ModalState; setModal: (m: ModalState | null) => void; fhe: boolean }) {
  const { type, pool } = modal;
  const [amount, setAmount] = useState("");
  const [encPos, setEncPos] = useState(fhe && pool.type === "enc");
  const [chain, setChain] = useState(pool.type === "ika" ? "ika" : "solana");
  const { deposit, withdraw, borrow, repay, status, txSig, errorMsg, reset } = useVeilActions();

  const isPrivate = encPos;
  const isSupply = type === "supply" || type === "withdraw";
  const isBorrow = type === "borrow" || type === "repay";
  const title = { supply: `Supply ${pool.symbol}`, borrow: `Borrow ${pool.symbol}`, withdraw: `Withdraw ${pool.symbol}`, repay: `Repay ${pool.symbol}`, "ika-setup": `Register ${pool.symbol}` }[type];

  const btnBg =
    pool.type === "ika"   ? "linear-gradient(135deg,#f97316,#eab308)"
    : pool.type === "enc" ? "linear-gradient(135deg,#6d28d9,#9333ea)"
    : pool.type === "oro" ? "linear-gradient(135deg,#eab308,#ca8a04)"
    :                       "#0b0b10";

  function handleConfirm() {
    if (!amount) return;
    reset();
    const lamports = BigInt(Math.round(parseFloat(amount) * 1e9));
    if (type === "supply")       deposit(pool.id, lamports);
    else if (type === "withdraw") withdraw(pool.id, lamports);
    else if (type === "borrow")   borrow(pool.id, lamports);
    else if (type === "repay")    repay(pool.id, lamports);
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
      <div style={{ background: "white", borderRadius: 20, padding: 24, width: "100%", maxWidth: 380, boxShadow: "0 30px 60px -12px rgba(76,29,149,.2),0 12px 30px -8px rgba(10,10,20,.15)", position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
            <Tag type={pool.type} />
          </div>
          <button onClick={() => setModal(null)} style={{ width: 28, height: 28, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 14, color: "#5b5b66" }}>✕</button>
        </div>

        {pool.type === "ika" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Collateral chain</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ id: "solana", label: "Solana" }, { id: "ika", label: `${pool.symbol} (Ika)` }].map((c) => (
                <button key={c.id} onClick={() => setChain(c.id)} style={{ flex: 1, padding: "7px", borderRadius: 10, border: "1px solid", borderColor: chain === c.id ? "#059669" : "#e7e7ec", background: chain === c.id ? "#ecfdf5" : "white", color: chain === c.id ? "#065f46" : "#5b5b66", fontSize: 12.5, fontWeight: 600, cursor: "pointer", transition: "all .15s" }}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ background: "#f4f4f6", border: "1px solid #e7e7ec", borderRadius: 12, display: "flex", alignItems: "center", padding: "10px 14px", marginBottom: 6 }}>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ background: "none", border: "none", outline: "none", fontSize: 22, fontWeight: 600, flex: 1, color: "#0b0b10", width: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}>{pool.symbol}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "#5b5b66", marginBottom: 14 }}>
          {amount && `≈ $${(parseFloat(amount) * 61200).toLocaleString()}`} · {isSupply ? "Balance" : "Max borrow"}: {pool.totalSupply}
        </div>

        {(type === "supply" || type === "borrow") && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: encPos ? "#ede9fe" : "#f4f4f6", borderRadius: 10, marginBottom: 14, cursor: "pointer", border: "1px solid", borderColor: encPos ? "#c4b5fd" : "#e7e7ec", transition: "all .2s" }}
            onClick={() => setEncPos((v) => !v)}
          >
            <div className={`toggle-track ${encPos ? "on" : ""}`}><div className="toggle-thumb" /></div>
            <span style={{ fontSize: 13, fontWeight: 500, color: encPos ? "#4c1d95" : "#5b5b66" }}>Encrypt position (FHE)</span>
            {encPos && <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>}
          </div>
        )}

        <div style={{ borderTop: "1px solid #f0f0f3", paddingTop: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 7 }}>
          {isSupply && <>
            <InfoRow k="Collateral factor" v={`${pool.cf}%`} />
            <InfoRow k="Supply APY" v={`+${pool.supplyApy}%`} vc="#059669" />
            {pool.type === "ika" && <InfoRow k="dWallet required" v="Yes — Ika" vc="#059669" />}
            {pool.type === "oro" && <InfoRow k="Custody" v="Oro / GRAIL" vc="#d97706" />}
          </>}
          {isBorrow && <>
            <InfoRow k="Borrow APY" v={`${pool.borrowApy}%`} vc="#dc2626" />
            <InfoRow k="Collateral used" v="1.2 BTC (Ika)" />
            <InfoRow k="Health factor after" v="1.87 → 1.42" vc="#059669" />
            <InfoRow k="Liquidation price" v="BTC < $42,800" />
          </>}
        </div>

        {encPos && (
          <div style={{ background: "#ede9fe", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#4c1d95", marginBottom: 14, lineHeight: 1.6 }}>
            Position will be FHE-encrypted. Balances and borrow amounts stored as ciphertext on-chain via Encrypt · REFHE.
          </div>
        )}

        {status === "success" && txSig && (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#065f46", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 500 }}>Transaction confirmed</span>
            <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer" style={{ color: "#059669", fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-mono),monospace", fontSize: 11 }}>
              {txSig.slice(0, 8)}…{txSig.slice(-6)} ↗
            </a>
          </div>
        )}
        {status === "error" && errorMsg && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#991b1b", marginBottom: 12 }}>
            {errorMsg}
          </div>
        )}

        {isPrivate ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ background: "linear-gradient(135deg,#ede9fe,#fdf2ff)", border: "1px solid #c4b5fd", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
              <span style={{ fontSize: 12.5, color: "#4c1d95", fontWeight: 500 }}>FHE private operations are coming soon.</span>
            </div>
            <button disabled style={{ width: "100%", padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#6d28d9,#9333ea)", color: "rgba(255,255,255,.6)", border: "none", fontSize: 14, fontWeight: 700, cursor: "not-allowed", letterSpacing: "-0.01em", opacity: 0.65 }}>
              Coming Soon
            </button>
          </div>
        ) : (
          <button
            disabled={!amount || ["building", "signing", "confirming"].includes(status)}
            onClick={handleConfirm}
            style={{ width: "100%", padding: "11px", borderRadius: 12, background: amount ? btnBg : "#e7e7ec", color: amount ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: amount ? "pointer" : "not-allowed", letterSpacing: "-0.01em", transition: "all .2s" }}
          >
            {status === "building"    ? "Building transaction…"
            : status === "signing"    ? "Approve in wallet…"
            : status === "confirming" ? "Confirming…"
            : type === "supply"       ? `Supply${pool.type === "ika" ? " via Ika dWallet" : ""}`
            : type === "borrow"       ? `Borrow ${pool.symbol}`
            : type === "withdraw"     ? `Withdraw ${pool.symbol}`
            :                           `Repay ${pool.symbol}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function DAppPage() {
  const { publicKey } = useWallet();
  const connected = !!publicKey;

  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("veil_view") as View) ?? "markets";
    }
    return "markets";
  });
  const [fhe, setFhe] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);

  useEffect(() => {
    localStorage.setItem("veil_view", view);
  }, [view]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none" }} className="page-bg" />
      <div aria-hidden className="grid-bg" style={{ position: "fixed", inset: 0, pointerEvents: "none", opacity: 0.5 }} />
      <AppNav view={view} setView={setView} fhe={fhe} setFhe={setFhe} />
      <main style={{ flex: 1, paddingTop: 20, position: "relative" }}>
        {view === "markets"   && <MarketsView   fhe={fhe} connected={connected} setModal={setModal} />}
        {view === "portfolio" && <PortfolioView fhe={fhe} connected={connected} setModal={setModal} />}
        {view === "flash"     && <FlashView connected={connected} fhe={fhe} />}
      </main>
      {modal && modal.type === "ika-setup"
        ? <IkaSetupModal pool={modal.pool} setModal={setModal} />
        : modal && <Modal modal={modal} setModal={setModal} fhe={fhe} />
      }
    </div>
  );
}
