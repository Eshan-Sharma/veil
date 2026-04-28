"use client";

import React, { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import Link from "next/link";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKEN_PROGRAM_ID } from "@/lib/veil";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import { buildExplorerTxUrl } from "@/lib/solana/rpc";
import { formatPrice, formatUsd, tokenToUsd, type PythPrices } from "@/lib/pyth/prices";
import { usePools, type PoolView } from "@/lib/veil/usePools";
import { WAD } from "@/lib/veil/constants";
import { WalletButton as WalletMultiButton } from "../components/WalletButton";
import { RpcSwitcher } from "./components/RpcSwitcher";
import { useVeilActions } from "./hooks/useVeilActions";
import { usePythPrices } from "./hooks/usePythPrices";
import { useChainPolling, type ChainPositionUpdate } from "./hooks/useChainPolling";
import {
  wadToPctNum,
  wadToPctStr,
  formatBigAmount,
  numberWithCommas,
  shortAddr,
  estimateHF,
  formatHF,
} from "./lib/format";
import { getPoolType, getPoolIcon, getPoolColor, type PoolType } from "./lib/tokens";

// ─── Types ──────────────────────���─────────────────────────────────────────────

type View = "markets" | "portfolio" | "flash" | "liquidate" | "history";
type ModalType = "supply" | "borrow" | "withdraw" | "repay" | "ika-setup";

type TxEntry = {
  signature: string;
  action: string;
  amount: string | null;
  created_at: string;
};

type DetailPosition = {
  position_address: string;
  pool_address: string;
  owner: string;
  symbol: string | null;
  decimals: number;
  health_factor_wad: string | null;
  account_health_factor_wad?: string;
  last_synced_at: string;
  deposit_shares: string;
  borrow_principal: string;
  deposit_tokens: string;
  original_deposit: string;
  interest_earned: string;
  borrow_debt: string;
  interest_owed: string;
  pool_ltv_pct: number;
  pool_liq_threshold_pct: number;
  supply_apy: number;
  borrow_apy: number;
  utilization_pct: number;
  supply_txs: TxEntry[];
  borrow_txs: TxEntry[];
  /** True when on-chain polling has confirmed this position account exists. */
  on_chain?: boolean;
};

type PortfolioSide = "supply" | "borrow";
type PortfolioFilter = "all" | "supply" | "borrow";

/** A virtual row — one per side (supply/borrow) per position. */
type VirtualRow = {
  key: string;
  pos: DetailPosition;
  pool: PoolView;
  side: PortfolioSide;
  amount: string;
  interest: string;
  apy: number;
  txs: TxEntry[];
};

type ModalState = {
  type: ModalType;
  pool: PoolView;
  /** Max amount in base units string. */
  maxAmount?: string;
  /** Raw deposit_shares for withdraw — avoids lossy token→shares round-trip. */
  maxShares?: string;
  /** Principal in base units (deposit principal for withdraw, borrow principal for repay). */
  principal?: string;
  /** Interest in base units (earned for withdraw, owed for repay). */
  interest?: string;
  /** User's wallet token balance in base units. */
  walletBalance?: string;
};

type ApiEndpoint = {
  method: string;
  path: string;
  desc: string;
  params: { n: string; t: string; d: string }[];
};

type TxLogEntry = {
  id: number;
  signature: string;
  wallet: string;
  action: string;
  pool_address: string | null;
  amount: string | null;
  status: string;
  error_msg: string | null;
  created_at: string;
};

type UnhealthyPosition = {
  position_address: string;
  pool_address: string;
  owner: string;
  deposit_shares: string;
  borrow_principal: string;
  health_factor_wad: string | null;
};

// ─── Pool helpers ────────────────────────────────────────────────────────────

const poolUtil = (p: PoolView): number => {
  if (p.totalDeposits === 0n) return 0;

  return Number((p.totalBorrows * 10000n) / p.totalDeposits) / 100;
};

const borrowRate = (baseRate: number, slope1: number, slope2: number, optimalUtil: number, u: number): number => {
  if (u <= optimalUtil) return baseRate + (slope1 * u) / optimalUtil;

  return baseRate + slope1 + (slope2 * (u - optimalUtil)) / (100 - optimalUtil);
};

const supplyRate = (baseRate: number, slope1: number, slope2: number, optimalUtil: number, reserveFactor: number, u: number): number => {
  return borrowRate(baseRate, slope1, slope2, optimalUtil, u) * (u / 100) * (1 - reserveFactor / 100);
};

const poolBorrowApy = (p: PoolView): number => {
  const u = poolUtil(p);

  return borrowRate(wadToPctNum(p.baseRateWad), wadToPctNum(p.slope1Wad), wadToPctNum(p.slope2Wad), wadToPctNum(p.optimalUtilWad) || 80, u);
};

const poolSupplyApy = (p: PoolView): number => {
  const u = poolUtil(p);

  return supplyRate(wadToPctNum(p.baseRateWad), wadToPctNum(p.slope1Wad), wadToPctNum(p.slope2Wad), wadToPctNum(p.optimalUtilWad) || 80, wadToPctNum(p.reserveFactorWad), u);
};

// ─── Cipher animation (FHE) ──────────────────────────────────────────────────

const CIPHER_POOL = ["7fA9·12Ce·88aD", "E4b2·9C01·F7dd", "A1b3·44Cc·ZzQ9", "5D0e·09Bc·4F8a", "Q7x2·MmN4·L20p", "9cE4·DdE1·0aBb"];

const useCipher = (seed = 0) => {
  const [i, setI] = useState(seed % CIPHER_POOL.length);
  useEffect(() => {
    const t = setInterval(() => setI((p) => (p + 1) % CIPHER_POOL.length), 2400 + seed * 180);
    return () => clearInterval(t);
  }, [seed]);

  return CIPHER_POOL[i];
};

const CipherVal = ({ seed, mask }: { seed: number; mask: string }) => {
  const v = useCipher(seed);
  return <span className="cipher-mask rotate-cipher" title={`ct:${v}`}>{mask}</span>;
};

// ─── API reference ───────────────────────���────────────────────────────────────

const API_ENDPOINTS: ApiEndpoint[] = [
  { method: "POST", path: "/v1/flash/borrow", desc: "Initiate a flash borrow. Returns a signed transaction envelope.", params: [{ n: "asset", t: "string", d: "Pool asset ID — sol | btc | eth | xau | usdc" }, { n: "amount", t: "u64", d: "Lamports / base units to borrow" }, { n: "receiver", t: "pubkey", d: "Program that will receive funds and repay" }] },
  { method: "POST", path: "/v1/flash/repay", desc: "Append the repay instruction to the same transaction.", params: [{ n: "loan_id", t: "string", d: "Returned by /flash/borrow" }, { n: "amount", t: "u64", d: "Principal + fee in base units" }] },
  { method: "GET", path: "/v1/flash/pools", desc: "Returns available liquidity per pool and the current fee rate.", params: [] },
  { method: "GET", path: "/v1/flash/history/:wallet", desc: "Returns flash loan history for a wallet address.", params: [{ n: "wallet", t: "pubkey", d: "Solana wallet address" }] },
];

const METHOD_COLOR: Record<string, string> = { GET: "#059669", POST: "#6d28d9", DELETE: "#dc2626" };

// ─── Shared Components ───────────���───────────────────────────────────────────

const Tag = ({ type }: { type: PoolType }) => {
  const map: Record<PoolType, [string, string]> = {
    ika: ["tag-ika", "Ika dWallet"],
    enc: ["tag-enc", "FHE encrypted"],
    oro: ["tag-oro", "Oro / GRAIL"],
    native: ["tag-native", "Native"],
  };
  const [cls, label] = map[type];

  return <span className={`tag ${cls}`}>{label}</span>;
};

const AssetIcon = ({ pool, size = 34 }: { pool: PoolView; size?: number }) => {
  const type = getPoolType(pool.symbol);
  const bg = type === "ika" ? "linear-gradient(135deg,#f97316,#eab308)"
    : type === "oro" ? "linear-gradient(135deg,#eab308,#ca8a04)"
    : type === "enc" ? "linear-gradient(135deg,#6d28d9,#9333ea)"
    : `linear-gradient(135deg,${getPoolColor(pool.symbol)},${getPoolColor(pool.symbol)}dd)`;

  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.29, display: "grid", placeItems: "center", fontSize: size * 0.41, fontWeight: 700, flexShrink: 0, background: bg, color: "white" }}>
      {getPoolIcon(pool.symbol)}
    </div>
  );
};

const UtilBar = ({ pct }: { pct: number }) => {
  const color = pct > 80 ? "#dc2626" : pct > 60 ? "#d97706" : "#059669";
  return (
    <div style={{ height: 4, background: "#f0f0f3", borderRadius: 2, overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 2, transition: "width .6s" }} />
    </div>
  );
};

const HFBadge = ({ hf }: { hf: number | null }) => {
  if (hf === null) return <span style={{ fontSize: 12, color: "#9ca3af" }}>N/A</span>;
  const color = hf > 1.5 ? "#059669" : hf > 1.1 ? "#d97706" : "#dc2626";
  const label = hf > 1.5 ? "Safe" : hf > 1.1 ? "Watch" : "Danger";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ fontWeight: 700, fontSize: 14, color }}>{hf.toFixed(2)}</span>
      <div style={{ width: 40, height: 3, background: "#f0f0f3", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min((hf / 3) * 100, 100)}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, color, fontWeight: 500 }}>{label}</span>
    </div>
  );
};

const MetricCard = ({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) => {
  return (
    <div className="metric-card">
      <div className="metric-card-label">{label}</div>
      <div className="metric-card-value" style={{ color: color ?? "#0b0b10" }}>{value}</div>
      {sub && <div className="metric-card-sub">{sub}</div>}
    </div>
  );
};

const InfoRow = ({ k, v, vc }: { k: string; v: string; vc?: string }) => {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span style={{ color: "#5b5b66" }}>{k}</span>
      <span style={{ fontWeight: 600, color: vc ?? "#0b0b10" }}>{v}</span>
    </div>
  );
};

const ParamCard = ({ label, value, hint }: { label: string; value: string; hint: string }) => {
  const [show, setShow] = useState(false);
  return (
    <div
      style={{ background: "#f9f9fb", borderRadius: 10, padding: "10px 12px", border: "1px solid #f0f0f3", position: "relative", cursor: "default" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <div style={{ fontSize: 10.5, color: "#5b5b66", fontWeight: 500, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        <span style={{ fontSize: 10, color: "#c4c4cc", cursor: "help" }}>ⓘ</span>
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#0b0b10" }}>{value}</div>
      {show && (
        <div style={{
          position: "absolute", left: 0, bottom: "calc(100% + 6px)", zIndex: 20,
          background: "#1f2937", color: "#f9fafb", fontSize: 11, lineHeight: 1.5,
          padding: "8px 12px", borderRadius: 8, maxWidth: 260, width: "max-content",
          boxShadow: "0 4px 12px rgba(0,0,0,.18)", pointerEvents: "none",
        }}>
          {hint}
        </div>
      )}
    </div>
  );
};

const IrmParam = ({ k, v, hint }: { k: string; v: string; hint: string }) => {
  const [show, setShow] = useState(false);
  return (
    <div
      style={{ background: "#f4f4f6", borderRadius: 6, padding: "3px 8px", fontSize: 11, position: "relative", cursor: "default" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{ color: "#9ca3af" }}>{k} </span>
      <span style={{ fontWeight: 700, color: "#0b0b10" }}>{v}</span>
      {show && (
        <div style={{
          position: "absolute", left: 0, bottom: "calc(100% + 6px)", zIndex: 20,
          background: "#1f2937", color: "#f9fafb", fontSize: 11, lineHeight: 1.45,
          padding: "6px 10px", borderRadius: 6, maxWidth: 220, width: "max-content",
          boxShadow: "0 4px 12px rgba(0,0,0,.18)", pointerEvents: "none",
        }}>
          {hint}
        </div>
      )}
    </div>
  );
};

// ─── IRM Chart ───────────────────���───────────────────────��────────────────────

const IrmChart = ({ pool }: { pool: PoolView }) => {
  const VW = 280, VH = 150;
  const padL = 32, padB = 22, padT = 10, padR = 8;
  const cW = VW - padL - padR;
  const cH = VH - padT - padB;

  const base = wadToPctNum(pool.baseRateWad);
  const s1 = wadToPctNum(pool.slope1Wad);
  const s2 = wadToPctNum(pool.slope2Wad);
  const optUtil = wadToPctNum(pool.optimalUtilWad) || 80;
  const rf = wadToPctNum(pool.reserveFactorWad);
  const currentUtil = poolUtil(pool);

  const maxRate = base + s1 + s2;
  const maxY = Math.max(Math.ceil(maxRate / 10) * 10, 20);

  const X = (u: number) => padL + (u / 100) * cW;
  const Y = (r: number) => padT + cH - Math.min((r / maxY) * cH, cH);

  const bp = Array.from({ length: 101 }, (_, i) => `${X(i).toFixed(1)},${Y(borrowRate(base, s1, s2, optUtil, i)).toFixed(1)}`).join(" ");
  const sp = Array.from({ length: 101 }, (_, i) => `${X(i).toFixed(1)},${Y(supplyRate(base, s1, s2, optUtil, rf, i)).toFixed(1)}`).join(" ");

  const kx = X(optUtil);
  const cx = X(currentUtil);
  const cy = Y(borrowRate(base, s1, s2, optUtil, currentUtil));
  const midRate = Math.round(maxY / 2);

  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ u: number; x: number } | null>(null);

  const onMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * VW;
    const u = Math.max(0, Math.min(100, ((svgX - padL) / cW) * 100));
    setHover({ u, x: svgX });
  }, [cW]);

  const hoverBorrow = hover ? borrowRate(base, s1, s2, optUtil, hover.u) : 0;
  const hoverSupply = hover ? supplyRate(base, s1, s2, optUtil, rf, hover.u) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VW} ${VH}`}
      width="100%"
      style={{ display: "block", cursor: "crosshair" }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + cH} stroke="#e7e7ec" strokeWidth="1" />
      <line x1={padL} y1={padT + cH} x2={VW - padR} y2={padT + cH} stroke="#e7e7ec" strokeWidth="1" />
      {[0, midRate, maxY].map((v) => (
        <g key={v}>
          <line x1={padL} y1={Y(v)} x2={VW - padR} y2={Y(v)} stroke="#f0f0f3" strokeWidth="1" />
          <text x={padL - 4} y={Y(v) + 3.5} textAnchor="end" fontSize="8" fill="#9ca3af">{v}%</text>
        </g>
      ))}
      <text x={padL} y={VH - 3} textAnchor="middle" fontSize="8" fill="#9ca3af">0%</text>
      <text x={kx} y={VH - 3} textAnchor="middle" fontSize="8" fill="#8b5cf6">{optUtil}%</text>
      <text x={VW - padR} y={VH - 3} textAnchor="end" fontSize="8" fill="#9ca3af">100%</text>

      {/* Kink line */}
      <line x1={kx} y1={padT} x2={kx} y2={padT + cH} stroke="#c4b5fd" strokeWidth="1" strokeDasharray="3 2" />

      {/* Curves */}
      <polyline points={sp} fill="none" stroke="#059669" strokeWidth="1.5" opacity="0.65" />
      <polyline points={bp} fill="none" stroke="#d97706" strokeWidth="2" />

      {/* Current utilization */}
      <line x1={cx} y1={padT} x2={cx} y2={padT + cH} stroke="#6d28d9" strokeWidth="1" strokeDasharray="3 2" />
      <circle cx={cx} cy={cy} r="3.5" fill="#d97706" stroke="white" strokeWidth="1.5" />

      {/* Hover crosshair + tooltip */}
      {hover && hover.x >= padL && hover.x <= VW - padR && (
        <g>
          {/* Vertical line */}
          <line x1={hover.x} y1={padT} x2={hover.x} y2={padT + cH} stroke="#9ca3af" strokeWidth="0.5" strokeDasharray="2 2" />
          {/* Dots on curves */}
          <circle cx={hover.x} cy={Y(hoverBorrow)} r="3" fill="#d97706" stroke="white" strokeWidth="1" />
          <circle cx={hover.x} cy={Y(hoverSupply)} r="3" fill="#059669" stroke="white" strokeWidth="1" />
          {/* Tooltip box */}
          {(() => {
            const tipW = 86, tipH = 42;
            let tx = hover.x + 8;
            if (tx + tipW > VW - 4) tx = hover.x - tipW - 8;
            let ty = Math.max(padT, Y(hoverBorrow) - tipH / 2);
            if (ty + tipH > padT + cH) ty = padT + cH - tipH;
            return (
              <g>
                <rect x={tx} y={ty} width={tipW} height={tipH} rx="4" fill="#1f2937" fillOpacity="0.92" />
                <text x={tx + 6} y={ty + 11} fontSize="7.5" fill="#9ca3af" fontFamily="var(--font-mono),monospace">
                  Util: {hover.u.toFixed(0)}%
                </text>
                <text x={tx + 6} y={ty + 22} fontSize="7.5" fill="#d97706" fontWeight="600" fontFamily="var(--font-mono),monospace">
                  Borrow: {hoverBorrow.toFixed(2)}%
                </text>
                <text x={tx + 6} y={ty + 33} fontSize="7.5" fill="#059669" fontWeight="600" fontFamily="var(--font-mono),monospace">
                  Supply: {hoverSupply.toFixed(2)}%
                </text>
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
};

// ─── Pool Detail Panel ─────────���────────────────────────��─────────────────────

const PoolDetail = ({ pool, fhe, setModal, onClose, pythPrices }: { pool: PoolView; fhe: boolean; setModal: (m: ModalState | null) => void; onClose: () => void; pythPrices?: PythPrices }) => {
  const type = getPoolType(pool.symbol);
  const enc = fhe && type === "enc";
  const util = poolUtil(pool);
  const utilColor = util > 80 ? "#dc2626" : util > 60 ? "#d97706" : "#059669";
  const sApy = poolSupplyApy(pool);
  const bApy = poolBorrowApy(pool);
  const ltv = wadToPctNum(pool.ltvWad);
  const liqTh = wadToPctNum(pool.liquidationThresholdWad);
  const liqBonus = wadToPctNum(pool.liquidationBonusWad);
  const rf = wadToPctNum(pool.reserveFactorWad);
  const base = wadToPctNum(pool.baseRateWad);
  const s1 = wadToPctNum(pool.slope1Wad);
  const optUtil = wadToPctNum(pool.optimalUtilWad) || 80;
  const s2 = wadToPctNum(pool.slope2Wad);
  const availLiq = pool.totalDeposits - pool.totalBorrows;

  return (
    <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 18px 14px", borderBottom: "1px solid #f0f0f3", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <AssetIcon pool={pool} size={38} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>{pool.symbol}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
              <Tag type={type} />
              <span style={{ fontSize: 11.5, color: "#9ca3af", fontFamily: "var(--font-mono),monospace" }}>{formatPrice(pythPrices?.[pool.id], "—")}</span>
            </div>
          </div>
        </div>
        <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 13, color: "#5b5b66", flexShrink: 0 }}>✕</button>
      </div>

      {/* Two-column: Graph left, All data right */}
      <div className="detail-split">
        {/* Left — IRM chart */}
        <div className="detail-split-chart">
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#5b5b66", marginBottom: 6 }}>Interest Rate Model</div>
          <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.5, marginBottom: 10 }}>
            Two-slope kinked model. Rates rise gradually up to <strong style={{ color: "#5b5b66" }}>{optUtil}%</strong> utilization,
            then spike steeply to discourage over-borrowing.
          </div>
          <IrmChart pool={pool} />
          <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, color: "#d97706", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 2, background: "#d97706", display: "inline-block", borderRadius: 1 }} /> Borrow</span>
            <span style={{ fontSize: 10.5, color: "#059669", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 2, background: "#059669", display: "inline-block", borderRadius: 1, opacity: 0.65 }} /> Supply</span>
            <span style={{ fontSize: 10.5, color: "#8b5cf6", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 2, background: "#8b5cf6", display: "inline-block", borderRadius: 1, opacity: 0.6 }} /> Kink</span>
            <span style={{ fontSize: 10.5, color: "#6d28d9", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 5, height: 5, background: "#d97706", display: "inline-block", borderRadius: 99 }} /> Current</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {[
              { k: "Base", v: `${base}%`, hint: "Minimum borrow rate at 0% utilization" },
              { k: "Slope₁", v: `${s1}%`, hint: "Rate increase per 1% util below kink" },
              { k: "Kink", v: `${optUtil}%`, hint: "Optimal utilization — Slope₂ kicks in above this" },
              { k: "Slope₂", v: `${s2}%`, hint: "Steep rate above kink to discourage over-borrowing" },
            ].map((r, i) => (
              <IrmParam key={i} k={r.k} v={r.v} hint={r.hint} />
            ))}
          </div>
        </div>

        {/* Right — All numeric data */}
        <div className="detail-split-data">
          {/* Rate summary */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            {[
              { label: "Supply APY", value: `+${sApy.toFixed(1)}%`, color: "#059669", bg: "#f0fdf4" },
              { label: "Borrow APY", value: `${bApy.toFixed(1)}%`, color: "#d97706", bg: "#fffbeb" },
              { label: "Utilization", value: enc ? "––" : `${util.toFixed(0)}%`, color: utilColor, bg: "#fafafc" },
            ].map((s, i) => (
              <div key={i} style={{ padding: "10px 12px", background: s.bg, borderRadius: 10, border: "1px solid #f0f0f3" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#9ca3af", marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Utilization bar + liquidity */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: "#5b5b66", fontWeight: 500 }}>Pool utilization</span>
              <span style={{ fontWeight: 700, color: utilColor }}>{enc ? "––" : `${util.toFixed(0)}%`}</span>
            </div>
            <UtilBar pct={enc ? 0 : util} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <div style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Total supplied</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{enc ? <CipherVal seed={0} mask="$◉◉◉,◉◉◉" /> : formatBigAmount(pool.totalDeposits, pool.decimals)}</div>
                {!enc && (() => { const usd = tokenToUsd(pool.totalDeposits, pool.decimals, pythPrices?.[pool.id]); return usd != null ? <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{formatUsd(usd)}</div> : null; })()}
              </div>
              <div style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Available</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>{enc ? "••••" : formatBigAmount(availLiq > 0n ? availLiq : 0n, pool.decimals)}</div>
                {!enc && (() => { const usd = tokenToUsd(availLiq > 0n ? availLiq : 0n, pool.decimals, pythPrices?.[pool.id]); return usd != null ? <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{formatUsd(usd)}</div> : null; })()}
              </div>
            </div>
          </div>

          {/* Risk params */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#5b5b66", marginBottom: 8 }}>Risk Parameters</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            <ParamCard label="Max LTV" value={`${ltv}%`} hint="Maximum Loan-to-Value ratio. You can borrow up to this % of your collateral value. Borrowing near max LTV puts you close to liquidation." />
            <ParamCard label="Liq. threshold" value={`${liqTh}%`} hint="When your borrow value reaches this % of your collateral, your position becomes liquidatable. Always higher than LTV to give a safety buffer." />
            <ParamCard label="Liq. bonus" value={`+${liqBonus}%`} hint="Discount liquidators receive on your collateral when liquidating. Incentivizes keeping the protocol solvent." />
            <ParamCard label="Reserve factor" value={`${rf}%`} hint="% of borrow interest that goes to the protocol treasury. The rest goes to suppliers." />
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-supply" style={{ flex: 1, padding: "10px", borderRadius: 12, fontSize: 14, fontWeight: 700, background: type === "ika" ? "linear-gradient(135deg,#f97316,#eab308)" : undefined }} onClick={() => setModal({ type: type === "ika" ? "ika-setup" : "supply", pool })}>
              {type === "ika" ? "Register dWallet" : "Supply"}
            </button>
            <button className="btn-borrow" style={{ flex: 1, padding: "10px", borderRadius: 12, fontSize: 14, fontWeight: 700 }} onClick={() => setModal({ type: "borrow", pool })}>
              Borrow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Navigation ────────────────────���──────────────────────────��──────────────

const AppNav = ({ view, setView, fhe, setFhe, onOpenRpc }: { view: View; setView: (v: View) => void; fhe: boolean; setFhe: (fn: (v: boolean) => boolean) => void; onOpenRpc: () => void }) => {
  const { publicKey } = useWallet();
  const { preset } = useSolanaRpc();
  const tabs: { id: View; label: string; icon: string }[] = [
    { id: "markets", label: "Markets", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
    { id: "portfolio", label: "Portfolio", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
    { id: "flash", label: "Flash", icon: "M13 2L3 14h9l-1 8 10-12h-9l1-8z" },
    { id: "liquidate", label: "Liquidate", icon: "M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.96L13.76 4a2 2 0 00-3.5 0L3.3 16.04A2 2 0 005.07 19z" },
    { id: "history", label: "History", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
  ];

  return (
    <>
      <header className="dapp-nav">
        <nav className="dapp-nav-inner">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flexShrink: 0 }}>
            <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#6d28d9,#db2777)", boxShadow: "0 4px 14px -4px rgba(109,40,217,.5)" }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
                <path d="M4 5c4 6 12 6 16 0" /><path d="M4 12c4 6 12 6 16 0" opacity=".55" /><path d="M4 19c4 6 12 6 16 0" opacity=".28" />
              </svg>
            </span>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.03em", color: "#0b0b10" }}>Veil</span>
          </Link>

          {/* Desktop tabs */}
          <div className="dapp-tabs">
            {tabs.map((t) => (
              <button key={t.id} className={`dapp-tab ${view === t.id ? "active" : ""}`} onClick={() => setView(t.id)}>{t.label}</button>
            ))}
          </div>

          <div className="dapp-nav-actions">
            {/* Privacy toggle - desktop only */}
            <div className="privacy-toggle-desktop" style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 999, border: `1px solid ${fhe ? "#c4b5fd" : "#e7e7ec"}`, background: fhe ? "#ede9fe" : "white", cursor: "pointer", userSelect: "none", transition: "all .2s" }} onClick={() => setFhe((v) => !v)}>
              <div className={`toggle-track ${fhe ? "on" : ""}`} style={{ width: 26, height: 15 }}>
                <div className="toggle-thumb" style={{ width: 10, height: 10, top: 2.5, left: 2.5 }} />
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: fhe ? "#4c1d95" : "#5b5b66" }}>{fhe ? "FHE" : "Privacy"}</span>
            </div>

            {/* RPC */}
            <button onClick={onOpenRpc} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: "1px solid #e7e7ec", background: "white", fontSize: 12, color: "#5b5b66", fontWeight: 500, cursor: "pointer" }}>
              <span className="pulse-dot" style={{ width: 6, height: 6 }} />
              <span className="rpc-btn-text">{preset === "mainnet" ? "Mainnet" : preset === "localnet" ? "Local" : preset === "custom" ? "Custom" : "Devnet"}</span>
            </button>

            {/* Admin link - desktop */}
            <Link href="/dapp/admin" className="nav-pill" style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 999, border: "1px solid #e7e7ec", background: "white", fontSize: 12, color: "#5b5b66", fontWeight: 600, textDecoration: "none" }}>
              Admin
            </Link>

            <WalletMultiButton style={{ fontSize: "12.5px", height: "34px", borderRadius: "999px", padding: "0 14px", background: publicKey ? "#ecfdf5" : "#0b0b10", color: publicKey ? "#065f46" : "#ffffff", border: publicKey ? "1px solid #a7f3d0" : "none", fontWeight: 600, letterSpacing: "-0.01em" }} />
          </div>
        </nav>
      </header>

    </>
  );
};

const MOBILE_TABS: { id: View; label: string; icon: string }[] = [
  { id: "markets", label: "Markets", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
  { id: "portfolio", label: "Portfolio", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
  { id: "flash", label: "Flash", icon: "M13 2L3 14h9l-1 8 10-12h-9l1-8z" },
  { id: "liquidate", label: "Liquidate", icon: "M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.96L13.76 4a2 2 0 00-3.5 0L3.3 16.04A2 2 0 005.07 19z" },
  { id: "history", label: "History", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
];

const MobileTabBar = ({ view, setView }: { view: View; setView: (v: View) => void }) => (
  <div className="dapp-mobile-tabs">
    {MOBILE_TABS.map((t) => (
      <button key={t.id} className={`dapp-tab ${view === t.id ? "active" : ""}`} onClick={() => setView(t.id)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
        {t.label}
      </button>
    ))}
  </div>
);

// ─── Markets View ───────────���─────────────────────────────────────────────────

const MarketsView = ({ fhe, setModal, pools, poolsLoading, poolsError, refreshPools }: { fhe: boolean; setModal: (m: ModalState | null) => void; pools: PoolView[]; poolsLoading: boolean; poolsError: string | null; refreshPools: () => void }) => {
  const [selectedPool, setSelectedPool] = useState<PoolView | null>(null);
  const pythPrices = usePythPrices();

  const avgUtil = pools.length > 0 ? pools.reduce((s, p) => s + poolUtil(p), 0) / pools.length : 0;
  const bestSupply = pools.length > 0 ? Math.max(...pools.map(poolSupplyApy)) : 0;
  const bestPool = pools.find((p) => poolSupplyApy(p) === bestSupply);

  const totalSupplyUsd = pools.reduce((s, p) => s + (tokenToUsd(p.totalDeposits, p.decimals, pythPrices[p.id]) ?? 0), 0);
  const totalBorrowUsd = pools.reduce((s, p) => s + (tokenToUsd(p.totalBorrows, p.decimals, pythPrices[p.id]) ?? 0), 0);
  const hasUsdPrices = Object.keys(pythPrices).length > 1;

  return (
    <div className="fade-rise">
      {/* Protocol Overview */}
      <div style={{ marginBottom: 6, fontSize: 11.5, fontWeight: 600, color: "#5b5b66", letterSpacing: ".05em", textTransform: "uppercase" }}>Protocol Overview</div>
      <div className="metrics-row">
        <MetricCard label="Total Supplied" value={hasUsdPrices ? formatUsd(totalSupplyUsd) : "—"} sub={hasUsdPrices ? "USD · Pyth live" : "Awaiting prices"} />
        <MetricCard label="Total Borrowed" value={hasUsdPrices ? formatUsd(totalBorrowUsd) : "—"} sub={hasUsdPrices ? "USD · Pyth live" : "Awaiting prices"} />
        <MetricCard label="Avg Utilization" value={`${avgUtil.toFixed(0)}%`} color="#d97706" sub="Across pools" />
        <MetricCard label="Best Supply APY" value={`${bestSupply.toFixed(1)}%`} color="#059669" sub={bestPool ? `${bestPool.symbol} pool` : ""} />
      </div>

      {/* Pool list + detail */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Lending Pools</div>
            {fhe && <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#4c1d95", fontWeight: 500, background: "#ede9fe", padding: "4px 10px", borderRadius: 999 }}>
              <svg viewBox="0 0 16 16" width="11" height="11" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
              FHE active
            </div>}
          </div>

          {poolsLoading ? (
            <div style={{ padding: "48px 18px", textAlign: "center", color: "#6b7280", fontSize: 14 }}>Loading pools…</div>
          ) : poolsError ? (
            <div style={{ padding: "24px 18px", textAlign: "center" }}>
              <div style={{ color: "#dc2626", marginBottom: 8, fontSize: 13 }}>API error: {poolsError}</div>
              <button onClick={refreshPools} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "1px solid #e5e7eb", background: "white", cursor: "pointer" }}>retry</button>
            </div>
          ) : pools.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">No pools initialized</div>
              <div className="empty-state-desc">An admin must create pools via <Link href="/dapp/admin" style={{ color: "#2563eb" }}>/dapp/admin</Link>.</div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="pool-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Price</th>
                    <th>Total Supply</th>
                    <th>Supply APY</th>
                    <th>Total Borrow</th>
                    <th>Borrow APY</th>
                    <th>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((p) => {
                    const type = getPoolType(p.symbol);
                    const enc = fhe && type === "enc";
                    const isSelected = selectedPool?.poolAddress.toBase58() === p.poolAddress.toBase58();
                    const util = poolUtil(p);
                    const utilColor = util > 80 ? "#dc2626" : util > 60 ? "#d97706" : "#059669";
                    const sApy = poolSupplyApy(p);
                    const bApy = poolBorrowApy(p);
                    const availLiq = p.totalDeposits - p.totalBorrows;
                    const price = pythPrices[p.id];
                    const supplyUsd = tokenToUsd(p.totalDeposits, p.decimals, price);
                    const borrowUsd = tokenToUsd(p.totalBorrows, p.decimals, price);

                    return (
                      <tr key={p.poolAddress.toBase58()} className={isSelected ? "selected" : ""} onClick={() => setSelectedPool(isSelected ? null : p)}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <AssetIcon pool={p} />
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 700 }}>{p.symbol}</div>
                              <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "var(--font-mono),monospace" }}>{shortAddr(p.poolAddress.toBase58())}</div>
                              <Tag type={type} />
                            </div>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, fontFamily: "var(--font-mono),monospace" }}>{formatPrice(price, "—")}</div>
                          {p.pythPriceFeed && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>Pyth live</div>}
                        </td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{enc ? <CipherVal seed={0} mask="$◉◉◉" /> : formatBigAmount(p.totalDeposits, p.decimals)}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{enc ? "––" : supplyUsd != null ? formatUsd(supplyUsd) : `${formatBigAmount(availLiq > 0n ? availLiq : 0n, p.decimals)} avail`}</div>
                        </td>
                        <td><span style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>+{sApy.toFixed(1)}%</span></td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{enc ? <CipherVal seed={1} mask="$◉◉◉" /> : formatBigAmount(p.totalBorrows, p.decimals)}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{enc ? "––" : borrowUsd != null ? formatUsd(borrowUsd) : `${wadToPctNum(p.ltvWad)}% LTV`}</div>
                        </td>
                        <td><span style={{ fontSize: 14, fontWeight: 700, color: "#d97706" }}>{bApy.toFixed(1)}%</span></td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: utilColor }}>{enc ? "––" : `${util.toFixed(0)}%`}</span>
                          </div>
                          <div style={{ marginTop: 4, width: 60 }}><UtilBar pct={enc ? 0 : util} /></div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ margin: "0 18px 14px", padding: "9px 14px", background: "rgba(255,255,255,.55)", border: "1px solid #f0f0f3", borderRadius: 10, fontSize: 11.5, color: "#5b5b66", display: "flex", alignItems: "center", gap: 7 }}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9"><path d="M11 1l-6 8h3l-1 6 6-8h-3l1-6z" /></svg>
            Kink-based rate model · Pyth oracle feeds · Click any pool for details
          </div>
        </div>

        {/* Right panel */}
        {selectedPool && (
          <PoolDetail pool={selectedPool} fhe={fhe} setModal={setModal} onClose={() => setSelectedPool(null)} pythPrices={pythPrices} />
        )}
      </div>
    </div>
  );
};

// ─── Pool Picker Button ──────────────────────────────────────────────────────

interface PoolPickerProps {
  pools: PoolView[];
  modalType: ModalType;
  setModal: (m: ModalState | null) => void;
  label: string;
  className: string;
  style?: CSSProperties;
}

const PoolPickerButton = ({ pools, modalType, setModal, label, className, style }: PoolPickerProps) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);

    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flex: 1 }}>
      <button className={className} style={{ width: "100%", ...style }} onClick={() => setOpen((v) => !v)}>
        {label}
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginLeft: 4, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, background: "white", border: "1px solid #e7e7ec", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,.12)", overflow: "hidden", zIndex: 20, animation: "fadeRise .15s ease-out" }}>
          {pools.map((pool) => (
            <button
              key={pool.poolAddress.toBase58()}
              onClick={() => { setModal({ type: modalType, pool }); setOpen(false); }}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", border: "none", background: "transparent", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#0b0b10", borderBottom: "1px solid #f7f7f9", transition: "background .1s" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f9f9fb"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <AssetIcon pool={pool} size={24} />
              <span style={{ fontWeight: 600 }}>{pool.symbol}</span>
              <Tag type={getPoolType(pool.symbol)} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Portfolio View ───────────────────────────────────────────────────────────

// Position grids use CSS classes for responsive column hiding

const timeAgo = (dateStr: string): string => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);

  return `${mins}m ago`;
};

/** Split detail positions into supply/borrow virtual rows, resolving pools. */
const toVirtualRows = (positions: DetailPosition[], poolMap: Map<string, PoolView>): VirtualRow[] => {
  const rows: VirtualRow[] = [];
  for (const pos of positions) {
    const pool = poolMap.get(pos.pool_address);
    if (!pool) continue;
    if (pos.deposit_tokens !== "0") {
      rows.push({ key: `${pos.position_address}-supply`, pos, pool, side: "supply", amount: pos.deposit_tokens, interest: pos.interest_earned, apy: pos.supply_apy, txs: pos.supply_txs });
    }
    if (pos.borrow_debt !== "0") {
      rows.push({ key: `${pos.position_address}-borrow`, pos, pool, side: "borrow", amount: pos.borrow_debt, interest: pos.interest_owed, apy: pos.borrow_apy, txs: pos.borrow_txs });
    }
  }

  return rows;
};

const PortfolioFilterTabs = ({ filter, setFilter }: { filter: PortfolioFilter; setFilter: (f: PortfolioFilter) => void }) => {
  const tabs: { id: PortfolioFilter; label: string }[] = [
    { id: "all", label: "All positions" },
    { id: "supply", label: "Supplied" },
    { id: "borrow", label: "Borrowed" },
  ];

  return (
    <div style={{ display: "flex", gap: 3, background: "#f4f4f6", borderRadius: 999, padding: 3 }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setFilter(t.id)}
          style={{
            padding: "5px 12px", borderRadius: 999, fontSize: 13, cursor: "pointer",
            color: filter === t.id ? "#0b0b10" : "#5b5b66", fontWeight: filter === t.id ? 600 : 500,
            background: filter === t.id ? "white" : "transparent",
            border: filter === t.id ? "1px solid #e7e7ec" : "1px solid transparent",
            boxShadow: filter === t.id ? "0 1px 3px rgba(0,0,0,.06)" : "none",
            transition: "all .15s", whiteSpace: "nowrap",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
};

interface PortfolioRowProps {
  row: VirtualRow;
  fhe: boolean;
  isOpen: boolean;
  onToggle: () => void;
  explorerUrl: (sig: string) => string;
  setModal: (m: ModalState | null) => void;
  isLast: boolean;
  pythPrices: PythPrices;
}

const PortfolioPoolRow = ({ row, fhe, isOpen, onToggle, explorerUrl, setModal, isLast, pythPrices }: PortfolioRowProps) => {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { pos, pool, side, amount, interest, apy, txs } = row;
  const sym = pool.symbol;
  const dec = pos.decimals;
  const type = getPoolType(sym);
  const isSupply = side === "supply";
  const apyColor = isSupply ? "#059669" : "#dc2626";
  const enc = fhe && type === "enc";
  const price = pythPrices[pool.id];
  const amountUsd = tokenToUsd(BigInt(amount), dec, price);
  const interestUsd = tokenToUsd(BigInt(interest), dec, price);

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid #f7f7f9" }}>
      {/* Summary row */}
      <div
        onClick={onToggle}
        className="pos-row-grid"
        style={{ padding: "12px 18px", cursor: "pointer", transition: "background .1s" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(109,40,217,.03)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <AssetIcon pool={pool} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#0b0b10" }}>{sym}</div>
            <Tag type={type} />
          </div>
        </div>

        <div>
          {enc ? <CipherVal seed={0} mask="◉◉◉◉" /> : (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono),monospace" }}>{formatBigAmount(BigInt(amount), dec)} {sym}</div>
              <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 2 }}>{amountUsd != null ? formatUsd(amountUsd) : (isSupply ? "Supplied" : "Borrowed")}</div>
            </>
          )}
        </div>

        <div style={{ fontSize: 14, fontWeight: 600, color: apyColor }}>
          {isSupply ? "+" : ""}{apy}%
        </div>

        <div>
          {enc ? <CipherVal seed={3} mask="◉◉◉◉" /> : (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: apyColor, fontFamily: "var(--font-mono),monospace" }}>
                {isSupply ? "+" : "−"}{formatBigAmount(BigInt(interest), dec)} {sym}
              </div>
              <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 2 }}>{interestUsd != null ? formatUsd(interestUsd) : `${txs.length} tx`}</div>
            </>
          )}
        </div>

        <div style={{ fontSize: 13, color: "#5b5b66" }}>
          {isSupply ? `${pos.pool_ltv_pct}%` : "—"}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div onClick={(e) => e.stopPropagation()}>
            <button
              className={isSupply ? "btn-borrow" : "btn-supply"}
              disabled={!pos.on_chain}
              title={pos.on_chain ? undefined : "Position not found on-chain"}
              style={{ fontSize: 11, padding: "4px 10px", opacity: pos.on_chain ? 1 : 0.4, cursor: pos.on_chain ? "pointer" : "not-allowed" }}
              onClick={async () => {
                if (!pos.on_chain) return;
                if (isSupply) {
                  // ── WITHDRAW ──
                  const depositTokens = BigInt(amount); // current value (principal + interest)
                  const available = pool.totalDeposits - pool.totalBorrows - pool.accumulatedFees;
                  let maxTokens = depositTokens < available ? depositTokens : available;

                  const debt = BigInt(pos.borrow_debt || "0");
                  if (debt > 0n) {
                    const liqThreshold = pool.liquidationThresholdWad ?? (WAD * 80n / 100n);
                    const minCollateral = (debt * WAD * 101n) / (liqThreshold * 100n);
                    const withdrawable = depositTokens > minCollateral ? depositTokens - minCollateral : 0n;
                    if (withdrawable < maxTokens) maxTokens = withdrawable;
                  }

                  const totalShares = BigInt(pos.deposit_shares || "0");
                  const maxSharesVal = depositTokens > 0n
                    ? (totalShares * maxTokens) / depositTokens
                    : 0n;

                  setModal({
                    type: "withdraw", pool,
                    maxAmount: maxTokens.toString(),
                    maxShares: maxSharesVal.toString(),
                    principal: pos.original_deposit || "0",
                    interest: pos.interest_earned || "0",
                  });
                } else {
                  // ── REPAY ──
                  const debt = BigInt(amount);
                  let walletBalance = debt;
                  if (publicKey) {
                    try {
                      const ata = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
                      const bal = await connection.getTokenAccountBalance(ata);
                      walletBalance = BigInt(bal.value.amount);
                    } catch {
                      try {
                        const lamports = await connection.getBalance(publicKey);
                        walletBalance = BigInt(lamports);
                      } catch { /* ignore */ }
                    }
                  }
                  const repayMax = debt < walletBalance ? debt : walletBalance;
                  setModal({
                    type: "repay", pool,
                    maxAmount: repayMax.toString(),
                    principal: pos.borrow_principal,
                    interest: pos.interest_owed,
                    walletBalance: walletBalance.toString(),
                  });
                }
              }}
            >
              {isSupply ? "Withdraw" : "Repay"}
            </button>
          </div>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#b0b0b8" strokeWidth="2" strokeLinecap="round" style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0, cursor: "pointer" }}>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </div>
      </div>

      {/* Expanded chunk detail */}
      {isOpen && (
        <div style={{ padding: "4px 18px 18px", background: "#fafafc", animation: "fadeRise .2s ease-out" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0 12px", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "#5b5b66" }}>
                {isSupply ? "Deposit" : "Borrow"} history · {sym}
              </div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>
                {isSupply ? "Each deposit earns interest from the moment it lands on-chain" : "Interest accrues on each borrow from the moment of execution"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: 12 }}>
              <div>
                <span style={{ color: "#5b5b66" }}>Total {isSupply ? "earned" : "owed"}: </span>
                <span style={{ fontWeight: 700, color: apyColor, fontFamily: "var(--font-mono),monospace" }}>
                  {isSupply ? "+" : "−"}{formatBigAmount(BigInt(interest), dec)} {sym}
                </span>
              </div>
              <div>
                <span style={{ color: "#5b5b66" }}>Current APY: </span>
                <span style={{ fontWeight: 700, fontFamily: "var(--font-mono),monospace" }}>{apy}%</span>
              </div>
            </div>
          </div>

          {txs.length === 0 ? (
            <div style={{ background: "white", border: "1px solid #f0f0f3", borderRadius: 12, padding: "24px", textAlign: "center", fontSize: 13, color: "#9ca3af" }}>
              No transaction history recorded yet
            </div>
          ) : (
            <div style={{ background: "white", border: "1px solid #f0f0f3", borderRadius: 12, overflow: "hidden" }}>
              <div className="pos-chunk-grid" style={{ padding: "10px 14px", borderBottom: "1px solid #f0f0f3", background: "#fafafc" }}>
                {["Transaction", "Action", "Amount", "Timestamp", ""].map((h, i) => (
                  <span key={i} style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase" }}>{h}</span>
                ))}
              </div>
              {txs.map((tx, i) => {
                const txAmount = tx.amount && tx.amount !== "0" ? formatBigAmount(BigInt(tx.amount), dec) : null;
                const actionColor: Record<string, string> = { deposit: "#059669", withdraw: "#7c3aed", borrow: "#0284c7", repay: "#16a34a" };

                return (
                  <div key={tx.signature} className="pos-chunk-grid" style={{ padding: "11px 14px", alignItems: "center", borderBottom: i < txs.length - 1 ? "1px solid #f7f7f9" : "none", fontSize: 13 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <a href={explorerUrl(tx.signature)} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--font-mono),monospace", fontSize: 12, color: "#6d28d9", fontWeight: 500, textDecoration: "none" }}>
                        {tx.signature.slice(0, 6)}…{tx.signature.slice(-5)}
                      </a>
                    </div>
                    <div style={{ fontWeight: 600, color: actionColor[tx.action] ?? "#5b5b66", textTransform: "capitalize", fontSize: 12.5 }}>{tx.action}</div>
                    <div style={{ fontWeight: 600, fontFamily: "var(--font-mono),monospace" }}>{txAmount ? `${txAmount} ${sym}` : "—"}</div>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{new Date(tx.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{timeAgo(tx.created_at)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <a href={explorerUrl(tx.signature)} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, padding: "3px 9px", borderRadius: 999, border: "1px solid #e7e7ec", background: "white", color: "#5b5b66", textDecoration: "none", fontWeight: 500 }}>
                        View ↗
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const PortfolioSummary = ({ positions, pools, setModal, pythPrices }: { positions: DetailPosition[]; pools: PoolView[]; setModal: (m: ModalState | null) => void; pythPrices: PythPrices }) => {
  const poolMap = new Map(pools.map((p) => [p.poolAddress.toBase58(), p]));
  const collaterals = positions
    .filter((p) => p.deposit_tokens !== "0")
    .map((p) => {
      const pool = poolMap.get(p.pool_address);
      const usd = pool ? tokenToUsd(BigInt(p.deposit_tokens), p.decimals, pythPrices[pool.id]) : null;

      return { symbol: p.symbol ?? "???", decimals: p.decimals, amount: p.deposit_tokens, ltvPct: p.pool_ltv_pct, pool, usd };
    });
  const totalCollateralUsd = collaterals.reduce((s, c) => s + (c.usd ?? 0), 0);

  return (
    <div className="portfolio-sidebar">
      <div className="glass-card" style={{ borderRadius: 18, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "#5b5b66" }}>Your Collateral</div>
          {totalCollateralUsd > 0 && <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", fontFamily: "var(--font-mono),monospace" }}>{formatUsd(totalCollateralUsd)}</div>}
        </div>
        {collaterals.length === 0 ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 12 }}>No collateral posted</div>
          </div>
        ) : (
          <>
            {collaterals.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: i < collaterals.length - 1 ? "1px solid #f7f7f9" : "none" }}>
                {c.pool && <AssetIcon pool={c.pool} size={30} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{c.symbol}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono),monospace" }}>{formatBigAmount(BigInt(c.amount), c.decimals)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                    <span style={{ fontSize: 11.5, color: "#5b5b66" }}>{c.usd != null ? formatUsd(c.usd) : `${formatBigAmount(BigInt(c.amount), c.decimals)} ${c.symbol}`}</span>
                    <span style={{ fontSize: 11, color: "#5b5b66" }}>LTV {c.ltvPct}%</span>
                  </div>
                </div>
              </div>
            ))}
            {pools.length > 0 && (
              <PoolPickerButton pools={pools} modalType="supply" setModal={setModal} label="+ Add collateral" className="btn-supply" style={{ padding: "8px", borderRadius: 10, fontSize: 13 }} />
            )}
          </>
        )}
      </div>
    </div>
  );
};

const PortfolioView = ({ fhe, connected, setModal, pools, refreshKey }: { fhe: boolean; connected: boolean; setModal: (m: ModalState | null) => void; pools: PoolView[]; refreshKey: number }) => {
  const { publicKey } = useWallet();
  const rpc = useSolanaRpc();
  const pythPrices = usePythPrices();
  const [detailPositions, setDetailPositions] = useState<DetailPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<PortfolioFilter>("all");

  // Initial load from DB (has tx history, APYs, etc.)
  useEffect(() => {
    if (!publicKey) { setDetailPositions([]); return; }
    setLoading(true);
    setErr(null);
    fetch(`/api/positions/${encodeURIComponent(publicKey.toBase58())}/detail`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { positions: DetailPosition[] }) => setDetailPositions(d.positions ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [publicKey, refreshKey]);

  // Poll on-chain accounts every 10s for fresh balances & HF (chain is source of truth)
  const chainPoolAddrs = React.useMemo(
    () => detailPositions.map((p) => p.pool_address),
    [detailPositions],
  );
  const chainUpdates = useChainPolling(rpc.endpoint, publicKey ?? null, chainPoolAddrs);

  // Merge on-chain data into DB positions — chain wins for financial fields
  const livePositions = React.useMemo(() => {
    if (chainUpdates.length === 0) return detailPositions;
    const chainMap = new Map(chainUpdates.map((u) => [u.pool_address, u]));
    return detailPositions.map((pos) => {
      const fresh = chainMap.get(pos.pool_address);
      if (!fresh) return pos;
      const origDeposit = BigInt(pos.original_deposit || "0");
      const freshDepTokens = BigInt(fresh.deposit_tokens);
      const interestEarned = freshDepTokens > origDeposit ? (freshDepTokens - origDeposit).toString() : "0";
      const freshDebt = BigInt(fresh.borrow_debt);
      const freshPrincipal = BigInt(fresh.borrow_principal);
      const interestOwed = freshDebt > freshPrincipal ? (freshDebt - freshPrincipal).toString() : "0";
      return {
        ...pos,
        deposit_shares: fresh.deposit_shares,
        deposit_tokens: fresh.deposit_tokens,
        borrow_principal: fresh.borrow_principal,
        borrow_debt: fresh.borrow_debt,
        health_factor_wad: fresh.health_factor_wad,
        account_health_factor_wad: fresh.account_health_factor_wad,
        interest_earned: interestEarned,
        interest_owed: interestOwed,
        on_chain: true,
      };
    });
  }, [detailPositions, chainUpdates]);

  if (!connected) {
    return (
      <div className="fade-rise empty-state" style={{ marginTop: 60 }}>
        <div style={{ width: 52, height: 52, borderRadius: 16, background: "#f4f4f6", border: "1px solid #e7e7ec", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
        </div>
        <div className="empty-state-title">Connect your wallet</div>
        <div className="empty-state-desc">Connect a Solana wallet to view your positions and manage collateral.</div>
      </div>
    );
  }

  const explorerUrl = (sig: string) => buildExplorerTxUrl(sig, rpc);
  const poolMap = new Map(pools.map((p) => [p.poolAddress.toBase58(), p]));
  const rows = toVirtualRows(livePositions, poolMap);
  const visible = rows.filter((r) => filter === "all" || r.side === filter);

  const supplyRows = rows.filter((r) => r.side === "supply");
  const borrowRows = rows.filter((r) => r.side === "borrow");
  const totalSupplyCount = supplyRows.length;
  const totalBorrowCount = borrowRows.length;

  // Compute total USD values for supply & borrow
  const totalSupplyUsd = supplyRows.reduce((sum, r) => {
    const usd = tokenToUsd(BigInt(r.amount), r.pos.decimals, pythPrices[r.pool.id]);
    return sum + (usd ?? 0);
  }, 0);
  const totalBorrowUsd = borrowRows.reduce((sum, r) => {
    const usd = tokenToUsd(BigInt(r.amount), r.pos.decimals, pythPrices[r.pool.id]);
    return sum + (usd ?? 0);
  }, 0);

  // Use account-level (cross-collateral) HF if available, otherwise fall back to min per-pool HF
  const acctHfEntry = livePositions.find((p) => p.account_health_factor_wad);
  const overallHf = acctHfEntry
    ? (() => { const hf = formatHF(acctHfEntry.account_health_factor_wad!); return parseFloat(hf.label) || 999; })()
    : livePositions.reduce((min, p) => {
        if (!p.health_factor_wad || p.borrow_debt === "0") return min;
        const hf = formatHF(p.health_factor_wad);
        const val = parseFloat(hf.label);
        return isNaN(val) ? min : Math.min(min, val);
      }, 999);
  const hfColor = overallHf > 1.5 ? "#059669" : overallHf > 1.1 ? "#d97706" : "#dc2626";

  if (loading) {
    return (
      <div className="fade-rise empty-state" style={{ marginTop: 60 }}>
        <span style={{ color: "#6b7280" }}>Loading positions…</span>
      </div>
    );
  }

  if (err) {
    return (
      <div className="fade-rise empty-state" style={{ marginTop: 60 }}>
        <span style={{ color: "#dc2626" }}>Error: {err}</span>
      </div>
    );
  }

  if (livePositions.length === 0) {
    return (
      <div className="fade-rise empty-state" style={{ marginTop: 60 }}>
        <div className="empty-state-title">No positions yet</div>
        <div className="empty-state-desc">Deposit collateral or borrow from a pool on the markets page.</div>
      </div>
    );
  }

  return (
    <div className="fade-rise">
      {/* Subtitle */}
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "#5b5b66", letterSpacing: ".05em", textTransform: "uppercase" }}>Your portfolio</span>
        <span style={{ fontSize: 11.5, color: "#9ca3af" }}>— {shortAddr(publicKey!.toBase58())}</span>
      </div>

      {/* Metrics row */}
      <div className="metrics-row">
        <MetricCard label="Positions" value={String(rows.length)} sub={`${totalSupplyCount} supplied · ${totalBorrowCount} borrowed`} />
        <MetricCard label="Supply positions" value={formatUsd(totalSupplyUsd)} color="#059669" sub={`${totalSupplyCount} earning interest`} />
        <MetricCard label="Borrow positions" value={formatUsd(totalBorrowUsd)} color={totalBorrowCount > 0 ? "#dc2626" : "#0b0b10"} sub={totalBorrowCount === 0 ? "No debt" : `${totalBorrowCount} paying interest`} />
        <MetricCard label="Health Factor" value={overallHf < 999 ? overallHf.toFixed(2) : "∞"} color={overallHf < 999 ? hfColor : "#059669"} sub={overallHf < 1.0 ? "LIQUIDATABLE" : overallHf < 1.2 ? "At risk" : "Safe — liq. < 1.0"} />
      </div>

      {/* Two-column layout */}
      <div className="portfolio-layout">
        {/* Left: positions table */}
        <div>
          <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 0", flexWrap: "wrap", gap: 8 }}>
              <PortfolioFilterTabs filter={filter} setFilter={setFilter} />
              <span style={{ fontSize: 11.5, color: "#9ca3af" }}>Click any row for transaction history</span>
            </div>

            <div className="pos-row-grid" style={{ padding: "10px 18px", marginTop: 10, borderBottom: "1px solid #f0f0f3" }}>
              {["Asset", "Total position", "APY", "Interest", "LTV", "Actions"].map((h, i) => (
                <span key={i} style={{ fontSize: 11, color: "#5b5b66", fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" }}>{h}</span>
              ))}
            </div>

            {visible.length === 0 ? (
              <div style={{ padding: "30px 18px", textAlign: "center", fontSize: 13, color: "#9ca3af" }}>
                No {filter === "all" ? "" : filter} positions yet
              </div>
            ) : visible.map((row, i) => (
              <PortfolioPoolRow
                key={row.key}
                row={row}
                fhe={fhe}
                isOpen={expanded === row.key}
                onToggle={() => setExpanded((prev) => prev === row.key ? null : row.key)}
                explorerUrl={explorerUrl}
                setModal={setModal}
                isLast={i === visible.length - 1}
                pythPrices={pythPrices}
              />
            ))}
          </div>

          {pools.length > 0 && (
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <PoolPickerButton pools={pools} modalType="supply" setModal={setModal} label="+ Supply asset" className="btn-supply" style={{ padding: "10px", borderRadius: 12, fontSize: 13 }} />
              <PoolPickerButton pools={pools} modalType="borrow" setModal={setModal} label="+ Borrow asset" className="btn-borrow" style={{ padding: "10px", borderRadius: 12, fontSize: 13 }} />
            </div>
          )}

          <div style={{ marginTop: 10, padding: "9px 14px", background: "rgba(255,255,255,.55)", border: "1px solid #f0f0f3", borderRadius: 10, fontSize: 11.5, color: "#5b5b66", display: "flex", alignItems: "center", gap: 7 }}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9"><path d="M11 1l-6 8h3l-1 6 6-8h-3l1-6z" /></svg>
            Kink-based rate model · Pyth oracle · Interest accrues per-block
          </div>
        </div>

        {/* Right: sticky position summary */}
        <PortfolioSummary positions={livePositions} pools={pools} setModal={setModal} pythPrices={pythPrices} />
      </div>
    </div>
  );
};

// ─── Cross-Collateral Borrow View ───────────────────────────────────────────

// ─── Flash Loans View ─────────────────────────────────────────────────────────

const FlashView = ({ connected, fhe, pools, pythPrices }: { connected: boolean; fhe: boolean; pools: PoolView[]; pythPrices: PythPrices }) => {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [flashInputMode, setFlashInputMode] = useState<"token" | "usd">("token");
  const [openEndpoint, setOpenEndpoint] = useState<number | null>(null);
  const pool = pools[selectedIdx] ?? null;
  const rpc = useSolanaRpc();
  const { flashExecute, status, txSig, errorMsg, reset } = useVeilActions();

  const feeBps = pool?.flashFeeBps ?? 9;
  const feeRate = feeBps / 10000;
  const flashPrice = pool ? (pythPrices[pool.id] ?? null) : null;
  const flashParsed = parseFloat(amount);
  const flashValid = !isNaN(flashParsed) && flashParsed > 0;
  const flashTokenAmt = flashInputMode === "token" ? (flashValid ? flashParsed : 0) : (flashValid && flashPrice ? flashParsed / flashPrice : 0);
  const flashUsdAmt = flashInputMode === "usd" ? (flashValid ? flashParsed : 0) : (flashValid && flashPrice ? flashParsed * flashPrice : 0);

  if (pools.length === 0) return (
    <div className="fade-rise empty-state">
      <div className="empty-state-title">No pools available</div>
      <div className="empty-state-desc">Pools must be initialized before flash loans are available.</div>
    </div>
  );

  return (
    <div className="fade-rise">
      <div className="flash-grid" style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 16, alignItems: "start", marginBottom: 16 }}>
        {/* Info panel */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".08em", color: "#5b5b66", textTransform: "uppercase", marginBottom: 12 }}>Flash Loans</div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 8 }}>Atomic, uncollateralized liquidity</div>
          <p style={{ fontSize: 14, color: "#5b5b66", lineHeight: 1.7, marginBottom: 18 }}>
            Borrow any amount within a single Solana transaction — no collateral required. Funds must be returned with fee by the final instruction.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
            {[{ k: "Fee", v: `${(feeRate * 100).toFixed(2)}%` }, { k: "LP share", v: "90%" }, { k: "Max borrow", v: "Free liquidity" }, { k: "Enforcement", v: "Program-level" }].map((r, i) => (
              <div key={i} style={{ background: "#f4f4f6", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, color: "#5b5b66", fontWeight: 500, marginBottom: 2 }}>{r.k}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#5b5b66", letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8 }}>Available Liquidity</div>
          {pools.map((p, i) => {
            const util = poolUtil(p);
            const avail = p.totalDeposits - p.totalBorrows;
            return (
              <div key={p.poolAddress.toBase58()} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: i < pools.length - 1 ? "1px solid #f7f7f9" : "none" }}>
                <AssetIcon pool={p} size={22} />
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{p.symbol}</span>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, color: "#5b5b66" }}>{formatBigAmount(avail > 0n ? avail : 0n, p.decimals)}</div>
                  {(() => { const pr = pythPrices[p.id]; const uv = pr ? tokenToUsd(avail > 0n ? avail : 0n, p.decimals, pr) : null; return uv != null ? <div style={{ fontSize: 11, color: "#059669" }}>{formatUsd(uv)}</div> : null; })()}
                </div>
                <span style={{ fontSize: 11, color: util > 70 ? "#dc2626" : util > 50 ? "#d97706" : "#059669", fontWeight: 600, background: util > 70 ? "#fef2f2" : util > 50 ? "#fffbeb" : "#ecfdf5", padding: "2px 7px", borderRadius: 999 }}>{util.toFixed(0)}% used</span>
              </div>
            );
          })}
        </div>

        {/* Execute panel */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>New flash loan</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Asset</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {pools.map((p, i) => (
                <button key={p.poolAddress.toBase58()} onClick={() => setSelectedIdx(i)} style={{ padding: "5px 12px", borderRadius: 999, border: `1px solid ${selectedIdx === i ? "#6d28d9" : "#e7e7ec"}`, background: selectedIdx === i ? "#ede9fe" : "white", color: selectedIdx === i ? "#4c1d95" : "#5b5b66", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{p.symbol}</button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Amount</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f4f4f6", border: "1px solid #e7e7ec", borderRadius: 12, padding: "10px 14px" }}>
              {flashInputMode === "usd" && <span style={{ fontSize: 20, fontWeight: 600, color: "#0b0b10" }}>$</span>}
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 20, fontWeight: 600, color: "#0b0b10", width: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}>{flashInputMode === "token" ? (pool?.symbol ?? "—") : "USD"}</span>
              {flashPrice && (
                <button onClick={() => {
                  if (flashInputMode === "token" && flashValid) { setFlashInputMode("usd"); setAmount((flashParsed * flashPrice).toFixed(2)); }
                  else if (flashInputMode === "usd" && flashValid) { setFlashInputMode("token"); setAmount((flashParsed / flashPrice).toFixed(4)); }
                  else { setFlashInputMode(flashInputMode === "token" ? "usd" : "token"); setAmount(""); }
                }} title={`Switch to ${flashInputMode === "token" ? "USD" : pool?.symbol}`} style={{ marginLeft: 4, width: 26, height: 26, borderRadius: 999, border: "1px solid #e7e7ec", background: "white", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 12, color: "#5b5b66", flexShrink: 0 }}>⇄</button>
              )}
            </div>
            {pool && (
              <div style={{ fontSize: 11.5, color: "#5b5b66", marginTop: 4, display: "flex", justifyContent: "space-between" }}>
                <span>Available: {formatBigAmount(pool.totalDeposits - pool.totalBorrows > 0n ? pool.totalDeposits - pool.totalBorrows : 0n, pool.decimals)} · Fee: {flashTokenAmt ? (flashTokenAmt * feeRate).toFixed(4) : 0} {pool.symbol}</span>
                {flashValid && (
                  <span style={{ fontFamily: "var(--font-mono),monospace", color: "#059669" }}>
                    {flashInputMode === "token" ? `≈ ${formatUsd(flashUsdAmt)}` : `≈ ${flashTokenAmt.toFixed(4)} ${pool.symbol}`}
                  </span>
                )}
              </div>
            )}
          </div>

          {pool && (
            <div style={{ background: "#0b0b10", borderRadius: 12, padding: "12px 14px", fontFamily: "var(--font-mono),monospace", fontSize: 11.5, lineHeight: 1.8, marginBottom: 14 }}>
              <span style={{ color: "#9ca3af" }}>{"// append to your transaction"}</span><br />
              <span style={{ color: "#a78bfa" }}>flash_borrow</span><span style={{ color: "#e5e7eb" }}>(</span><span style={{ color: "#6ee7b7" }}>{pool.symbol.toLowerCase()}</span><span style={{ color: "#e5e7eb" }}>, amount);</span><br />
              <span style={{ color: "#9ca3af" }}>{"// ... your instructions ..."}</span><br />
              <span style={{ color: "#a78bfa" }}>flash_repay</span><span style={{ color: "#e5e7eb" }}>(loan_id, amount + fee);</span>
            </div>
          )}

          <div style={{ borderTop: "1px solid #f0f0f3", paddingTop: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { k: "Borrow amount", v: flashTokenAmt && pool ? `${flashTokenAmt.toFixed(4)} ${pool.symbol}${flashUsdAmt ? ` (${formatUsd(flashUsdAmt)})` : ""}` : "—" },
              { k: `Fee (${(feeRate * 100).toFixed(2)}%)`, v: flashTokenAmt && pool ? `${(flashTokenAmt * feeRate).toFixed(4)} ${pool.symbol}${flashPrice ? ` (${formatUsd(flashTokenAmt * feeRate * flashPrice)})` : ""}` : "—" },
              { k: "Repayment due", v: flashTokenAmt && pool ? `${(flashTokenAmt * (1 + feeRate)).toFixed(4)} ${pool.symbol}${flashPrice ? ` (${formatUsd(flashTokenAmt * (1 + feeRate) * flashPrice)})` : ""}` : "—" },
            ].map((r, i) => <InfoRow key={i} k={r.k} v={r.v} />)}
          </div>

          {fhe ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ background: "linear-gradient(135deg,#ede9fe,#fdf2ff)", border: "1px solid #c4b5fd", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                <svg viewBox="0 0 16 16" width="13" height="13" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
                <span style={{ fontSize: 12.5, color: "#4c1d95", fontWeight: 500 }}>Private flash loans via FHE coming soon.</span>
              </div>
              <button disabled style={{ width: "100%", padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#6d28d9,#9333ea)", color: "rgba(255,255,255,.6)", border: "none", fontSize: 14, fontWeight: 700, cursor: "not-allowed", opacity: 0.6 }}>Coming Soon</button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {status === "success" && txSig && (
                <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#065f46", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 500 }}>Confirmed</span>
                  <a href={buildExplorerTxUrl(txSig, rpc)} target="_blank" rel="noreferrer" style={{ color: "#059669", fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-mono),monospace", fontSize: 11 }}>{txSig.slice(0, 8)}…{txSig.slice(-6)} ↗</a>
                </div>
              )}
              {status === "error" && errorMsg && (
                <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#991b1b" }}>{errorMsg}</div>
              )}
              <button disabled={!connected || !flashTokenAmt || !pool || ["building", "signing", "confirming"].includes(status)} onClick={() => { if (pool && flashTokenAmt > 0) { reset(); flashExecute(pool, BigInt(Math.round(flashTokenAmt * 10 ** (pool?.decimals ?? 9)))); } }} style={{ width: "100%", padding: "11px", borderRadius: 12, background: connected && flashTokenAmt ? "#0b0b10" : "#e7e7ec", color: connected && flashTokenAmt ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: connected && flashTokenAmt ? "pointer" : "not-allowed", transition: "all .2s" }}>
                {!connected ? "Connect wallet" : status === "building" ? "Building…" : status === "signing" ? "Approve in wallet…" : status === "confirming" ? "Confirming…" : "Execute flash loan"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* API Reference */}
      <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>API Reference</div>
        <div style={{ fontSize: 13, color: "#5b5b66", marginBottom: 18 }}>REST + JSON · Flash loan endpoints for programmatic access</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {API_ENDPOINTS.map((ep, i) => {
            const open = openEndpoint === i;
            return (
              <div key={i} style={{ border: "1px solid #f0f0f3", borderRadius: 12, overflow: "hidden", boxShadow: open ? "0 4px 16px -4px rgba(109,40,217,.1)" : "none" }}>
                <div onClick={() => setOpenEndpoint(open ? null : i)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer", background: open ? "#fafafc" : "transparent", userSelect: "none" }}>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, fontWeight: 700, color: METHOD_COLOR[ep.method] ?? "#0b0b10", background: (METHOD_COLOR[ep.method] ?? "#0b0b10") + "18", padding: "2px 8px", borderRadius: 6, minWidth: 44, textAlign: "center" }}>{ep.method}</span>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{ep.path}</span>
                  <span style={{ fontSize: 13, color: "#9ca3af", flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.desc}</span>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0 }}><path d="M4 6l4 4 4-4" /></svg>
                </div>
                {open && (
                  <div style={{ padding: "12px 16px", borderTop: "1px solid #f0f0f3", background: "#fafafc" }}>
                    <div style={{ fontSize: 13, color: "#5b5b66", marginBottom: ep.params.length ? 12 : 0, lineHeight: 1.6 }}>{ep.desc}</div>
                    {ep.params.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "#9ca3af", marginBottom: 8 }}>Parameters</div>
                        {ep.params.map((p, j) => (
                          <div key={j} style={{ display: "grid", gridTemplateColumns: "120px 70px 1fr", gap: 10, alignItems: "start", fontSize: 13, marginBottom: 4 }}>
                            <span className="mono" style={{ fontWeight: 600, color: "#0b0b10" }}>{p.n}</span>
                            <span style={{ color: "#6d28d9", fontFamily: "var(--font-mono),monospace", fontSize: 11.5 }}>{p.t}</span>
                            <span style={{ color: "#5b5b66" }}>{p.d}</span>
                          </div>
                        ))}
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
};

// ─── Liquidate View ───────────────────────────────────────────────────────────

const LiquidateView = ({ connected, pools, pythPrices }: { connected: boolean; pools: PoolView[]; pythPrices: PythPrices }) => {
  const [unhealthy, setUnhealthy] = useState<UnhealthyPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const { liquidate, status, txSig, errorMsg, reset } = useVeilActions();
  const rpc = useSolanaRpc();

  useEffect(() => {
    fetch("/api/positions/unhealthy", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setUnhealthy(d.positions ?? []))
      .catch(() => setUnhealthy([]))
      .finally(() => setLoading(false));
  }, []);

  const enriched = unhealthy.map((pos) => {
    const pool = pools.find((p) => p.poolAddress.toBase58() === pos.pool_address);
    const shares = BigInt(pos.deposit_shares || "0");
    const principal = BigInt(pos.borrow_principal || "0");
    const deposits = pool ? (shares * pool.supplyIndex) / WAD : shares;
    const borrows = principal;
    const liqThreshold = pool?.liquidationThresholdWad ?? (WAD * 80n / 100n);
    const hf = borrows > 0n ? estimateHF(deposits, borrows, liqThreshold) : null;
    return { pos, pool, deposits, borrows, hf };
  }).filter((e) => e.pool != null) as { pos: UnhealthyPosition; pool: PoolView; deposits: bigint; borrows: bigint; hf: number | null }[];

  return (
    <div className="fade-rise">
      <div style={{ marginBottom: 16 }}>
        <div className="section-header">Liquidator</div>
        <div className="section-sub">Monitor and liquidate unhealthy positions. Earn the liquidation bonus for each successful liquidation.</div>
      </div>

      <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "48px 18px", textAlign: "center", color: "#6b7280", fontSize: 14 }}>Loading unhealthy positions…</div>
        ) : enriched.length === 0 ? (
          <div className="empty-state">
            <div style={{ width: 48, height: 48, borderRadius: 14, background: "#ecfdf5", border: "1px solid #a7f3d0", display: "grid", placeItems: "center", margin: "0 auto 12px" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round"><path d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="empty-state-title">All positions healthy</div>
            <div className="empty-state-desc">No positions are currently eligible for liquidation.</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="pool-table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Owner</th>
                  <th style={{ textAlign: "right" }}>Collateral</th>
                  <th style={{ textAlign: "right" }}>Debt</th>
                  <th style={{ textAlign: "center" }}>HF</th>
                  <th style={{ textAlign: "center" }}>Bonus</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map(({ pos, pool, deposits, borrows, hf }, i) => (
                  <tr key={i} style={{ cursor: "default" }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <AssetIcon pool={pool} size={28} />
                        <span style={{ fontWeight: 600 }}>{pool.symbol}</span>
                      </div>
                    </td>
                    <td><span style={{ fontSize: 12, fontFamily: "var(--font-mono),monospace", color: "#5b5b66" }}>{shortAddr(pos.owner)}</span></td>
                    <td style={{ textAlign: "right", fontWeight: 500 }}>
                      <div>{formatBigAmount(deposits, pool.decimals)}</div>
                      {(() => { const pr = pythPrices[pool.id]; const uv = pr ? tokenToUsd(deposits, pool.decimals, pr) : null; return uv != null ? <div style={{ fontSize: 11, color: "#059669" }}>{formatUsd(uv)}</div> : null; })()}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 500, color: "#dc2626" }}>
                      <div>{formatBigAmount(borrows, pool.decimals)}</div>
                      {(() => { const pr = pythPrices[pool.id]; const uv = pr ? tokenToUsd(borrows, pool.decimals, pr) : null; return uv != null ? <div style={{ fontSize: 11, color: "#dc2626", opacity: 0.7 }}>{formatUsd(uv)}</div> : null; })()}
                    </td>
                    <td style={{ textAlign: "center" }}><HFBadge hf={hf} /></td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#059669", background: "#ecfdf5", padding: "2px 8px", borderRadius: 999 }}>+{wadToPctNum(pool.liquidationBonusWad)}%</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn-supply"
                        style={{ fontSize: 11, padding: "5px 12px", background: "#dc2626" }}
                        disabled={!connected || ["building", "signing", "confirming"].includes(status)}
                        onClick={() => { reset(); liquidate(pool, new PublicKey(pos.owner)); }}
                      >
                        Liquidate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {status === "success" && txSig && (
        <div style={{ marginTop: 12, background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: "#065f46", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 500 }}>Liquidation confirmed</span>
          <a href={buildExplorerTxUrl(txSig, rpc)} target="_blank" rel="noreferrer" style={{ color: "#059669", fontFamily: "var(--font-mono),monospace", fontSize: 11, textDecoration: "none" }}>{txSig.slice(0, 8)}…{txSig.slice(-6)} ↗</a>
        </div>
      )}
      {status === "error" && errorMsg && (
        <div style={{ marginTop: 12, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: "#991b1b" }}>{errorMsg}</div>
      )}

      {!connected && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "#fffbeb", border: "1px solid #fef08a", borderRadius: 12, fontSize: 13, color: "#854d0e" }}>Connect your wallet to execute liquidations.</div>
      )}
    </div>
  );
};

// ─── History View ───────��───────────────────────────���─────────────────────────

const HISTORY_ACTION_COLOR: Record<string, string> = {
  deposit: "#059669", withdraw: "#7c3aed", borrow: "#0284c7", repay: "#16a34a",
  liquidate: "#dc2626", flash: "#d97706", flash_borrow: "#6d28d9", flash_repay: "#059669",
  init: "#0b0b10", update_pool: "#6b7280", pause: "#dc2626", resume: "#059669",
  collect_fees: "#a16207", update_oracle: "#0891b2",
};

const formatTxAmount = (raw: string | null, pool: PoolView | undefined): string => {
  if (!raw) return "—";
  try {
    const v = BigInt(raw);
    if (v === 0n) return "—";
    const decimals = pool?.decimals ?? 9;
    const symbol = pool?.symbol ?? "";
    return `${formatBigAmount(v, decimals)}${symbol ? ` ${symbol}` : ""}`;
  } catch {
    return raw;
  }
};

const HISTORY_PAGE_SIZE = 25;
const HISTORY_INITIAL_CAP = 200;

const HISTORY_ACTIONS = [
  "deposit", "withdraw", "borrow", "repay", "liquidate",
  "flash", "flash_borrow", "flash_repay",
  "init", "update_pool", "pause", "resume",
  "collect_fees", "update_oracle",
] as const;

const HistoryView = ({ connected, pools }: { connected: boolean; pools: PoolView[] }) => {
  const { publicKey } = useWallet();
  const [txs, setTxs] = useState<TxLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [fetchAll, setFetchAll] = useState(false);
  const rpc = useSolanaRpc();

  // Filters
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [poolFilter, setPoolFilter] = useState("");

  const pageSize = fetchAll ? HISTORY_INITIAL_CAP : HISTORY_PAGE_SIZE;

  const fetchTxs = useCallback((pg: number, from: string, to: string, action: string, pool: string, all: boolean) => {
    if (!publicKey) { setTxs([]); setTotal(0); setLoading(false); return; }
    setLoading(true); setError(null);
    const ps = pageSize;
    const params = new URLSearchParams({
      wallet: publicKey.toBase58(),
      limit: String(ps),
      offset: String(pg * ps),
    });
    if (all) params.set("all", "true");
    if (from) params.set("from", new Date(from).toISOString());
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      params.set("to", end.toISOString());
    }
    if (action) params.set("action", action);
    if (pool) params.set("pool", pool);
    fetch(`/api/transactions?${params}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => { setTxs(d.transactions ?? []); setTotal(d.total ?? 0); setCapped(d.capped ?? false); })
      .catch((e) => { setTxs([]); setTotal(0); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [publicKey, pageSize]);

  useEffect(() => { fetchTxs(page, fromDate, toDate, actionFilter, poolFilter, fetchAll); }, [fetchTxs, page, fromDate, toDate, actionFilter, poolFilter, fetchAll]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const clearFilters = () => { setFromDate(""); setToDate(""); setActionFilter(""); setPoolFilter(""); setPage(0); setFetchAll(false); };

  const handleLoadAll = () => { setFetchAll(true); setPage(0); };

  if (!connected) return (
    <div className="fade-rise empty-state" style={{ marginTop: 60 }}>
      <div className="empty-state-title">Connect wallet</div>
      <div className="empty-state-desc">Connect your wallet to view transaction history.</div>
    </div>
  );

  return (
    <div className="fade-rise">
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-header">Transaction History</div>
          <div className="section-sub">{total > 0 ? `${total} transaction${total === 1 ? "" : "s"}` : "Your recent protocol interactions"}</div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            value={actionFilter}
            onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
            style={{ ...dateInput, cursor: "pointer", minWidth: 90 }}
          >
            <option value="">All actions</option>
            {HISTORY_ACTIONS.map((a) => (
              <option key={a} value={a}>{a.replace(/_/g, " ")}</option>
            ))}
          </select>
          {pools.length > 0 && (
            <select
              value={poolFilter}
              onChange={(e) => { setPoolFilter(e.target.value); setPage(0); }}
              style={{ ...dateInput, cursor: "pointer", minWidth: 80 }}
            >
              <option value="">All pools</option>
              {pools.map((p) => (
                <option key={p.poolAddress.toBase58()} value={p.poolAddress.toBase58()}>{p.symbol}</option>
              ))}
            </select>
          )}
          <label style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>FROM</label>
          <input
            type="date" value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPage(0); }}
            style={dateInput}
          />
          <label style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>TO</label>
          <input
            type="date" value={toDate}
            onChange={(e) => { setToDate(e.target.value); setPage(0); }}
            style={dateInput}
          />
          {(fromDate || toDate || actionFilter || poolFilter) && (
            <button onClick={clearFilters} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>Clear</button>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ borderRadius: 18, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "48px 18px", textAlign: "center", color: "#6b7280", fontSize: 14 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: "24px 18px", textAlign: "center" }}>
            <div style={{ color: "#dc2626", marginBottom: 4, fontSize: 13 }}>Error: {error}</div>
          </div>
        ) : txs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No transactions{fromDate || toDate ? " in this range" : " yet"}</div>
            <div className="empty-state-desc">
              {fromDate || toDate ? "Try adjusting the date range." : "Transactions sent from this dApp are logged here automatically."}
            </div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="pool-table history-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Pool</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((tx) => {
                    const pool = pools.find((p) => p.poolAddress.toBase58() === tx.pool_address);
                    const ac = HISTORY_ACTION_COLOR[tx.action] ?? "#5b5b66";
                    const statusColor = tx.status === "confirmed" ? "#059669" : tx.status === "failed" ? "#dc2626" : "#d97706";
                    const statusBg = tx.status === "confirmed" ? "#ecfdf5" : tx.status === "failed" ? "#fef2f2" : "#fffbeb";

                    return (
                      <tr key={tx.signature ?? tx.id} style={{ cursor: "default" }}>
                        <td>
                          <span style={{ fontSize: 12, color: "#9ca3af" }}>
                            {new Date(tx.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, fontWeight: 600, color: ac, background: ac + "14", padding: "3px 10px", borderRadius: 999, textTransform: "capitalize", whiteSpace: "nowrap" }}>
                            {tx.action.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td>
                          {pool ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <AssetIcon pool={pool} size={22} />
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{pool.symbol}</span>
                            </div>
                          ) : tx.pool_address ? (
                            <a
                              href={`https://explorer.solana.com/address/${tx.pool_address}${rpc.preset === "devnet" ? "?cluster=devnet" : rpc.preset === "mainnet" ? "" : `?cluster=custom&customUrl=${encodeURIComponent(rpc.endpoint)}`}`}
                              target="_blank" rel="noreferrer"
                              style={{ fontSize: 12, color: "#6d28d9", fontFamily: "var(--font-mono),monospace", textDecoration: "none" }}
                            >
                              {shortAddr(tx.pool_address)} ↗
                            </a>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>—</span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono),monospace" }}>
                            {formatTxAmount(tx.amount, pool)}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 600, color: statusColor, background: statusBg, padding: "2px 8px", borderRadius: 999 }}>
                            {tx.status}
                          </span>
                          {tx.error_msg && (
                            <div style={{ fontSize: 10, color: "#dc2626", marginTop: 2, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tx.error_msg}>
                              {tx.error_msg}
                            </div>
                          )}
                        </td>
                        <td>
                          <a href={buildExplorerTxUrl(tx.signature, rpc)} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontFamily: "var(--font-mono),monospace", color: "#6d28d9", textDecoration: "none" }}>
                            {tx.signature.slice(0, 8)}…{tx.signature.slice(-4)} ↗
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Capped banner — offer to load all */}
            {capped && !fetchAll && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderTop: "1px solid #f0f0f3", background: "#fffbeb" }}>
                <span style={{ fontSize: 12, color: "#92400e" }}>
                  Showing first {txs.length} of {total} transactions
                </span>
                <button
                  onClick={handleLoadAll}
                  style={{ fontSize: 12, fontWeight: 600, padding: "5px 14px", borderRadius: 8, border: "1px solid #fbbf24", background: "#fef3c7", color: "#92400e", cursor: "pointer" }}
                >Load all ({total})</button>
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderTop: "1px solid #f0f0f3" }}>
                <span style={{ fontSize: 12, color: "#9ca3af" }}>
                  {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    disabled={page === 0}
                    onClick={() => setPage(0)}
                    style={pgBtn(page === 0)}
                    title="First page"
                  >««</button>
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    style={pgBtn(page === 0)}
                  >‹ Prev</button>
                  <span style={{ fontSize: 12, color: "#5b5b66", fontWeight: 600, padding: "0 8px", display: "flex", alignItems: "center" }}>
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                    style={pgBtn(page >= totalPages - 1)}
                  >Next ›</button>
                  <button
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(totalPages - 1)}
                    style={pgBtn(page >= totalPages - 1)}
                    title="Last page"
                  >»»</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const dateInput: CSSProperties = {
  fontSize: 12, fontFamily: "var(--font-mono),monospace",
  padding: "5px 10px", border: "1px solid #e5e7eb", borderRadius: 8,
  background: "white", color: "#0b0b10", outline: "none",
};

const pgBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 8,
  border: "1px solid #e5e7eb", background: disabled ? "#f9f9fb" : "white",
  color: disabled ? "#d1d5db" : "#5b5b66", cursor: disabled ? "default" : "pointer",
});

// ─── Ika dWallet Setup Modal ───────────────��──────────────────────────────────

type IkaStep = "create" | "transfer" | "register" | "done";

const IKA_STEPS: { id: IkaStep; label: string; desc: string }[] = [
  { id: "create", label: "Create dWallet", desc: "Run 2PC-MPC distributed key generation via the Ika network" },
  { id: "transfer", label: "Transfer authority", desc: "Hand dWallet control to Veil's CPI authority PDA" },
  { id: "register", label: "Register collateral", desc: "Create an IkaDwalletPosition on Veil and unlock borrowing" },
  { id: "done", label: "Ready", desc: "Your cross-chain collateral is live" },
];

const IkaStepIcon = ({ step, current, done }: { step: IkaStep; current: IkaStep; done: boolean }) => {
  const steps = IKA_STEPS.map((s) => s.id);
  const idx = steps.indexOf(step);
  const curIdx = steps.indexOf(current);
  const isActive = step === current;
  const isPast = done || idx < curIdx;
  const bg = isPast ? "#059669" : isActive ? "#6d28d9" : "#f0f0f3";
  const color = isPast || isActive ? "white" : "#9ca3af";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 26, height: 26, borderRadius: 999, background: bg, color, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, transition: "background .25s" }}>{isPast ? "✓" : idx + 1}</div>
      <div style={{ fontSize: 12.5, fontWeight: isActive ? 700 : 500, color: isActive ? "#0b0b10" : isPast ? "#5b5b66" : "#9ca3af" }}>{IKA_STEPS[idx].label}</div>
    </div>
  );
};

const IkaSetupModal = ({ pool, setModal }: { pool: PoolView; setModal: (m: ModalState | null) => void }) => {
  const { publicKey, sendTransaction } = useWallet();
  const rpc = useSolanaRpc();
  const [step, setStep] = useState<IkaStep>("create");
  const [dwalletAddr, setDwalletAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [txSig, setTxSig] = useState("");
  const isDone = step === "done";
  const accentBg = "linear-gradient(135deg,#f97316,#eab308)";
  const ltv = wadToPctNum(pool.ltvWad);
  const liqTh = wadToPctNum(pool.liquidationThresholdWad);

  const handleCreate = async () => {
    if (!publicKey) return;
    setBusy(true); setErr("");
    try {
      await new Promise((r) => setTimeout(r, 2000));
      setDwalletAddr(publicKey.toBase58().slice(0, 8) + "…dWallet");
      setStep("transfer");
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "DKG failed"); }
    finally { setBusy(false); }
  };

  const handleTransfer = async () => {
    if (!publicKey || !sendTransaction) return;
    setBusy(true); setErr("");
    try {
      await new Promise((r) => setTimeout(r, 1500));
      setStep("register");
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Transfer failed"); }
    finally { setBusy(false); }
  };

  const handleRegister = async () => {
    if (!publicKey || !sendTransaction) return;
    setBusy(true); setErr("");
    try {
      await new Promise((r) => setTimeout(r, 1800));
      setTxSig("5KgR…mock");
      setStep("done");
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Registration failed"); }
    finally { setBusy(false); }
  };

  const stepContent: Record<IkaStep, React.ReactNode> = {
    create: (
      <div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>
          A <strong>dWallet</strong> is a 2PC-MPC key controlled jointly by you and the Ika MPC network. Your {pool.symbol} stays on its native chain; only Veil&apos;s CPI authority can approve signatures.
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {[{ icon: "🔑", t: "Distributed key generation", d: "DKG runs over gRPC with the Ika pre-alpha network" }, { icon: "🔒", t: "No custody risk", d: "Neither Veil nor Ika can move funds unilaterally" }, { icon: "⚡", t: "Native asset collateral", d: `Your ${pool.symbol} never leaves its chain` }].map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "10px 12px", background: "#f9f9fb", borderRadius: 10, border: "1px solid #f0f0f3" }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{r.icon}</span>
              <div><div style={{ fontSize: 12.5, fontWeight: 600, color: "#0b0b10", marginBottom: 2 }}>{r.t}</div><div style={{ fontSize: 11.5, color: "#5b5b66" }}>{r.d}</div></div>
            </div>
          ))}
        </div>
        <button disabled={busy || !publicKey} onClick={handleCreate} style={{ width: "100%", padding: "11px", borderRadius: 12, background: publicKey ? accentBg : "#e7e7ec", color: publicKey ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: publicKey ? "pointer" : "not-allowed" }}>
          {busy ? "Running DKG…" : !publicKey ? "Connect wallet first" : "Create dWallet"}
        </button>
      </div>
    ),
    transfer: (
      <div>
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12.5, color: "#065f46", display: "flex", gap: 8 }}>
          <span>✓</span><div><div style={{ fontWeight: 600 }}>dWallet created</div><div style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, marginTop: 2, color: "#059669" }}>{dwalletAddr}</div></div>
        </div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>Transfer the dWallet&apos;s authority to <strong>Veil&apos;s CPI authority PDA</strong>.</div>
        <button disabled={busy} onClick={handleTransfer} style={{ width: "100%", padding: "11px", borderRadius: 12, background: accentBg, color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          {busy ? "Signing transaction…" : "Transfer authority"}
        </button>
      </div>
    ),
    register: (
      <div>
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12.5, color: "#065f46" }}>✓ Authority transferred to Veil CPI PDA</div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.7, marginBottom: 16 }}>Register the dWallet as collateral on Veil.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          {[{ k: "Collateral", v: `${pool.symbol} (native)` }, { k: "Max LTV", v: `${ltv}%` }, { k: "Liq. at", v: `${liqTh}%` }, { k: "Curve", v: "secp256k1" }].map((r, i) => (
            <div key={i} style={{ background: "#f9f9fb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f0f0f3" }}>
              <div style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>{r.k}</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.v}</div>
            </div>
          ))}
        </div>
        <button disabled={busy} onClick={handleRegister} style={{ width: "100%", padding: "11px", borderRadius: 12, background: accentBg, color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          {busy ? "Registering…" : `Register ${pool.symbol} collateral`}
        </button>
      </div>
    ),
    done: (
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div style={{ width: 52, height: 52, borderRadius: 999, background: "#ecfdf5", border: "2px solid #a7f3d0", display: "grid", placeItems: "center", margin: "0 auto 14px", fontSize: 22 }}>✓</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Collateral registered!</div>
        <div style={{ fontSize: 13, color: "#5b5b66", lineHeight: 1.6, marginBottom: 16 }}>Your {pool.symbol} dWallet is live as cross-chain collateral.</div>
        {txSig && (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#065f46", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 500 }}>IkaRegister confirmed</span>
            <a href={buildExplorerTxUrl(txSig, rpc)} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11, color: "#059669", textDecoration: "none" }}>{txSig} ↗</a>
          </div>
        )}
        <button onClick={() => setModal(null)} style={{ width: "100%", padding: "11px", borderRadius: 12, background: "#0b0b10", color: "white", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Done — go to Markets</button>
      </div>
    ),
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AssetIcon pool={pool} size={36} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Register {pool.symbol} Collateral</div>
              <Tag type={getPoolType(pool.symbol)} />
            </div>
          </div>
          <button onClick={() => setModal(null)} style={{ width: 28, height: 28, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 14, color: "#5b5b66" }}>✕</button>
        </div>
        {!isDone && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", background: "#f9f9fb", borderRadius: 12, marginBottom: 18, border: "1px solid #f0f0f3" }}>
            {IKA_STEPS.filter((s) => s.id !== "done").map((s) => <IkaStepIcon key={s.id} step={s.id} current={step} done={isDone} />)}
          </div>
        )}
        {err && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#991b1b", marginBottom: 12 }}>{err}</div>}
        {stepContent[step]}
      </div>
    </div>
  );
};

// ─── Toast notification ──────────────────────────────────────────────────────

type ToastItem = { id: number; action: string; symbol: string; status: "signing" | "confirming" | "success" | "error"; sig?: string; error?: string };

const TxToastContainer = ({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) => {
  const rpc = useSolanaRpc();
  if (toasts.length === 0) return null;
  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
      {toasts.map((t) => {
        const pending = t.status === "signing" || t.status === "confirming";
        const bg = t.status === "success" ? "#f0fdf4" : t.status === "error" ? "#fef2f2" : "#f8fafc";
        const border = t.status === "success" ? "#bbf7d0" : t.status === "error" ? "#fecaca" : "#e2e8f0";
        const color = t.status === "success" ? "#065f46" : t.status === "error" ? "#991b1b" : "#334155";
        const label = t.status === "signing" ? "Approve in wallet…"
          : t.status === "confirming" ? "Confirming on-chain…"
          : t.status === "success" ? "Transaction confirmed"
          : "Transaction failed";
        return (
          <div key={t.id} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: "10px 14px", boxShadow: "0 4px 24px rgba(0,0,0,.08)", animation: "fadeSlideUp .25s ease-out" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              {pending && (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" opacity=".25" /><path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              )}
              {t.status === "success" && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"><path d="M5 13l4 4L19 7" /></svg>}
              {t.status === "error" && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>}
              <span style={{ fontSize: 12.5, fontWeight: 600, color, flex: 1 }}>{label}</span>
              {!pending && <button onClick={() => onDismiss(t.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 14, color: "#9ca3af", lineHeight: 1 }}>✕</button>}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>{t.action} {t.symbol}</div>
            {t.status === "success" && t.sig && (
              <a href={buildExplorerTxUrl(t.sig, rpc)} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: "#059669", fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-mono),monospace", marginTop: 2, display: "inline-block" }}>
                {t.sig.slice(0, 10)}…{t.sig.slice(-6)} ↗
              </a>
            )}
            {t.status === "error" && t.error && (
              <div style={{ fontSize: 11, color: "#991b1b", marginTop: 2, lineHeight: 1.4 }}>{t.error.length > 80 ? t.error.slice(0, 80) + "…" : t.error}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ─── Supply/Borrow/Withdraw/Repay Modal ─────────────────────────────────────

type ActionModalProps = {
  modal: ModalState;
  setModal: (m: ModalState | null) => void;
  fhe: boolean;
  onSubmit: (type: ModalType, pool: PoolView, amount: bigint, withdrawShares?: bigint) => void;
  pythPrices: PythPrices;
};

/** Shows principal + interest breakdown for both withdraw and repay modals. */
const BreakdownInfo = ({ pool, principal, interest, walletBalance, isRepay, price }: {
  pool: PoolView; principal: string; interest: string;
  walletBalance?: string; isRepay: boolean; price: number | null;
}) => {
  const dp = pool.decimals > 4 ? 4 : pool.decimals;
  const principalNum = Number(BigInt(principal)) / 10 ** pool.decimals;
  const interestNum = Number(BigInt(interest)) / 10 ** pool.decimals;
  const total = principalNum + interestNum;
  const walletBal = walletBalance ? Number(BigInt(walletBalance)) / 10 ** pool.decimals : null;
  const insufficient = isRepay && walletBal !== null && walletBal < total;
  return (
    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
      <span>{isRepay ? "Borrowed" : "Deposited"}: {principalNum.toFixed(dp)} {pool.symbol}</span>
      <span>Interest {isRepay ? "owed" : "earned"}: <span style={{ color: isRepay ? "#dc2626" : "#059669" }}>
        {isRepay ? "+" : "+"}{interestNum.toFixed(dp)} {pool.symbol}
      </span></span>
      <span style={{ fontWeight: 600, color: "#5b5b66" }}>
        {isRepay ? "Total debt" : "Total value"}: {total.toFixed(dp)} {pool.symbol}
        {price ? ` · ${formatUsd(total * price)}` : ""}
      </span>
      {insufficient && (
        <span style={{ color: "#f59e0b", fontWeight: 600, marginTop: 2 }}>
          Wallet: {walletBal!.toFixed(dp)} {pool.symbol} — not enough for full repay
        </span>
      )}
    </div>
  );
};

const ActionModal = ({ modal, setModal, fhe, onSubmit, pythPrices }: ActionModalProps) => {
  const { type, pool, maxAmount, maxShares, principal, interest, walletBalance } = modal;
  const poolType = getPoolType(pool.symbol);
  const [amount, setAmount] = useState("");
  const [inputMode, setInputMode] = useState<"token" | "usd">("token");
  const [encPos, setEncPos] = useState(fhe && poolType === "enc");
  const [chain, setChain] = useState(poolType === "ika" ? "ika" : "solana");
  const [customPct, setCustomPct] = useState("");
  const [showCustomPct, setShowCustomPct] = useState(false);
  /** Tracks which percentage button was used (for bigint share math on withdraw). null = manual input. */
  const [selectedPct, setSelectedPct] = useState<number | null>(null);

  const price = pythPrices[pool.id] ?? null;
  const parsed = parseFloat(amount);
  const validInput = !isNaN(parsed) && parsed > 0;

  // Max amount for withdraw/repay as a human-readable number
  const hasMax = (type === "withdraw" || type === "repay") && maxAmount && maxAmount !== "0";
  const maxTokens = hasMax ? Number(BigInt(maxAmount)) / 10 ** pool.decimals : 0;

  const applyPercent = (pct: number) => {
    if (!hasMax) return;
    const val = (maxTokens * pct) / 100;
    if (inputMode === "usd" && price) {
      setAmount((val * price).toFixed(2));
    } else {
      setAmount(val.toFixed(pool.decimals > 4 ? 4 : pool.decimals));
    }
    setSelectedPct(pct);
    setShowCustomPct(false);
    setCustomPct("");
  };

  const applyCustomPercent = () => {
    const pct = parseFloat(customPct);
    if (isNaN(pct) || pct <= 0 || pct > 100) return;
    applyPercent(pct);
  };

  // Derive token and USD amounts from whichever mode the user is typing in
  const tokenAmount = inputMode === "token" ? (validInput ? parsed : 0) : (validInput && price ? parsed / price : 0);
  const usdAmount = inputMode === "usd" ? (validInput ? parsed : 0) : (validInput && price ? parsed * price : 0);

  const isPrivate = encPos;
  const isSupply = type === "supply" || type === "withdraw";
  const isBorrow = type === "borrow" || type === "repay";
  const title = { supply: `Supply ${pool.symbol}`, borrow: `Borrow ${pool.symbol}`, withdraw: `Withdraw ${pool.symbol}`, repay: `Repay ${pool.symbol}`, "ika-setup": `Register ${pool.symbol}` }[type];
  const btnBg = poolType === "ika" ? "linear-gradient(135deg,#f97316,#eab308)" : poolType === "enc" ? "linear-gradient(135deg,#6d28d9,#9333ea)" : poolType === "oro" ? "linear-gradient(135deg,#eab308,#ca8a04)" : "#0b0b10";

  const handleConfirm = () => {
    if (!amount || tokenAmount <= 0) return;

    // For Max (100%) on repay/withdraw, use the raw bigint maxAmount to avoid float precision loss
    if (selectedPct !== null && selectedPct >= 100 && maxAmount) {
      const rawMax = BigInt(maxAmount);
      if (rawMax <= 0n) return;
      let withdrawShares: bigint | undefined;
      if (type === "withdraw" && maxShares) {
        withdrawShares = BigInt(maxShares);
      }
      // For repay max, send u64::MAX so on-chain program repays exact current debt
      // (avoids dust from interest accruing between read and TX confirmation)
      const submitAmount = type === "repay" ? 18446744073709551615n : rawMax;
      onSubmit(type, pool, submitAmount, withdrawShares);
      setModal(null);
      return;
    }

    // Convert the resolved token amount to lamports (base units)
    const tokenStr = tokenAmount.toFixed(pool.decimals);
    const [whole = "0", frac = ""] = tokenStr.split(".");
    const fracPadded = frac.padEnd(pool.decimals, "0").slice(0, pool.decimals);
    const lamports = BigInt(whole + fracPadded);
    if (lamports <= 0n) return;

    // For withdraw: compute shares via bigint math to avoid float precision issues
    let withdrawShares: bigint | undefined;
    if (type === "withdraw" && maxShares && selectedPct !== null) {
      const totalShares = BigInt(maxShares);
      withdrawShares = (totalShares * BigInt(Math.round(selectedPct * 100))) / 10000n;
    }

    onSubmit(type, pool, lamports, withdrawShares);
    setModal(null);
  };

  const toggleMode = () => {
    if (!price) return;
    // Convert the current input to the other denomination
    if (inputMode === "token" && validInput) {
      setInputMode("usd");
      setAmount((parsed * price).toFixed(2));
    } else if (inputMode === "usd" && validInput) {
      setInputMode("token");
      setAmount((parsed / price).toFixed(pool.decimals > 4 ? 4 : pool.decimals));
    } else {
      setInputMode(inputMode === "token" ? "usd" : "token");
      setAmount("");
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
      <div className="modal-card" style={{ maxWidth: 380 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
            <Tag type={poolType} />
          </div>
          <button onClick={() => setModal(null)} style={{ width: 28, height: 28, borderRadius: 999, border: "1px solid #e7e7ec", background: "#f4f4f6", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 14, color: "#5b5b66" }}>✕</button>
        </div>

        {poolType === "ika" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, color: "#5b5b66", fontWeight: 500, marginBottom: 6 }}>Collateral chain</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ id: "solana", label: "Solana" }, { id: "ika", label: `${pool.symbol} (Ika)` }].map((c) => (
                <button key={c.id} onClick={() => setChain(c.id)} style={{ flex: 1, padding: "7px", borderRadius: 10, border: `1px solid ${chain === c.id ? "#059669" : "#e7e7ec"}`, background: chain === c.id ? "#ecfdf5" : "white", color: chain === c.id ? "#065f46" : "#5b5b66", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{c.label}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ background: "#f4f4f6", border: "1px solid #e7e7ec", borderRadius: 12, display: "flex", alignItems: "center", padding: "10px 14px", marginBottom: 6 }}>
          {inputMode === "usd" && <span style={{ fontSize: 22, fontWeight: 600, color: "#0b0b10", marginRight: 2 }}>$</span>}
          <input value={amount} onChange={(e) => { setAmount(e.target.value); setSelectedPct(null); }} placeholder="0.00" style={{ background: "none", border: "none", outline: "none", fontSize: 22, fontWeight: 600, flex: 1, color: "#0b0b10", width: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}>{inputMode === "token" ? pool.symbol : "USD"}</span>
          {price && (
            <button onClick={toggleMode} title={`Switch to ${inputMode === "token" ? "USD" : pool.symbol}`} style={{ marginLeft: 8, width: 28, height: 28, borderRadius: 999, border: "1px solid #e7e7ec", background: "white", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 13, color: "#5b5b66", flexShrink: 0 }}>⇄</button>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "#5b5b66", marginBottom: hasMax ? 8 : 14, display: "flex", justifyContent: "space-between" }}>
          <span>
            {inputMode === "token" ? `Enter amount in ${pool.symbol}` : `Enter amount in USD`}
            {price && <span style={{ color: "#9ca3af" }}> · {formatPrice(price, "")}/{pool.symbol}</span>}
          </span>
          {validInput && (
            <span style={{ fontFamily: "var(--font-mono),monospace", color: "#059669" }}>
              {inputMode === "token" ? `≈ ${formatUsd(usdAmount)}` : `≈ ${tokenAmount.toFixed(pool.decimals > 4 ? 4 : pool.decimals)} ${pool.symbol}`}
            </span>
          )}
        </div>

        {hasMax && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: showCustomPct ? 6 : 0 }}>
              {[25, 50, 75, 100].map((pct) => (
                <button key={pct} onClick={() => applyPercent(pct)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "1px solid #e7e7ec", background: "white", fontSize: 12.5, fontWeight: 600, color: "#0b0b10", cursor: "pointer", transition: "all .15s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f6"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "white"; }}>
                  {pct === 100 ? "Max" : `${pct}%`}
                </button>
              ))}
              <button onClick={() => setShowCustomPct((v) => !v)} style={{ width: 36, borderRadius: 8, border: `1px solid ${showCustomPct ? "#6d28d9" : "#e7e7ec"}`, background: showCustomPct ? "#ede9fe" : "white", fontSize: 12, fontWeight: 600, color: showCustomPct ? "#6d28d9" : "#5b5b66", cursor: "pointer", transition: "all .15s", display: "grid", placeItems: "center" }} title="Custom %">
                %
              </button>
            </div>
            {showCustomPct && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input value={customPct} onChange={(e) => setCustomPct(e.target.value)} placeholder="e.g. 33" style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid #e7e7ec", background: "#f4f4f6", fontSize: 12.5, fontWeight: 500, outline: "none", color: "#0b0b10" }} onKeyDown={(e) => { if (e.key === "Enter") applyCustomPercent(); }} />
                <span style={{ fontSize: 12, color: "#5b5b66", fontWeight: 600 }}>%</span>
                <button onClick={applyCustomPercent} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #e7e7ec", background: "#0b0b10", color: "white", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Apply</button>
              </div>
            )}
            {principal && interest ? (
              <BreakdownInfo pool={pool} principal={principal} interest={interest}
                walletBalance={walletBalance} isRepay={type === "repay"} price={price} />
            ) : (
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                Balance: {maxTokens.toFixed(pool.decimals > 4 ? 4 : pool.decimals)} {pool.symbol}
                {price ? ` · ${formatUsd(maxTokens * price)}` : ""}
              </div>
            )}
          </div>
        )}

        {(type === "supply" || type === "borrow") && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: encPos ? "#ede9fe" : "#f4f4f6", borderRadius: 10, marginBottom: 14, cursor: "pointer", border: `1px solid ${encPos ? "#c4b5fd" : "#e7e7ec"}`, transition: "all .2s" }} onClick={() => setEncPos((v) => !v)}>
            <div className={`toggle-track ${encPos ? "on" : ""}`}><div className="toggle-thumb" /></div>
            <span style={{ fontSize: 13, fontWeight: 500, color: encPos ? "#4c1d95" : "#5b5b66" }}>Encrypt position (FHE)</span>
            {encPos && <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>}
          </div>
        )}

        <div style={{ borderTop: "1px solid #f0f0f3", paddingTop: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 7 }}>
          {isSupply && (
            <>
              <InfoRow k="Max LTV" v={wadToPctStr(pool.ltvWad)} />
              <InfoRow k="Supply APY" v={`+${poolSupplyApy(pool).toFixed(1)}%`} vc="#059669" />
              {poolType === "ika" && <InfoRow k="dWallet required" v="Yes — Ika" vc="#059669" />}
              {poolType === "oro" && <InfoRow k="Custody" v="Oro / GRAIL" vc="#d97706" />}
            </>
          )}
          {isBorrow && (
            <>
              <InfoRow k="Borrow APY" v={`${poolBorrowApy(pool).toFixed(1)}%`} vc="#dc2626" />
              <InfoRow k="Liq. threshold" v={wadToPctStr(pool.liquidationThresholdWad)} />
              <InfoRow k="Liq. bonus" v={wadToPctStr(pool.liquidationBonusWad)} />
            </>
          )}
          {(type === "withdraw" || type === "repay") && (
            <InfoRow k="Est. tx fee" v="~0.000005 SOL" vc="#9ca3af" />
          )}
        </div>

        {encPos && (
          <div style={{ background: "#ede9fe", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#4c1d95", marginBottom: 14, lineHeight: 1.6 }}>
            Position will be FHE-encrypted. Balances stored as ciphertext on-chain via Encrypt · REFHE.
          </div>
        )}

        {isPrivate ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ background: "linear-gradient(135deg,#ede9fe,#fdf2ff)", border: "1px solid #c4b5fd", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="#6d28d9"><path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" /></svg>
              <span style={{ fontSize: 12.5, color: "#4c1d95", fontWeight: 500 }}>FHE private operations coming soon.</span>
            </div>
            <button disabled style={{ width: "100%", padding: "11px", borderRadius: 12, background: "linear-gradient(135deg,#6d28d9,#9333ea)", color: "rgba(255,255,255,.6)", border: "none", fontSize: 14, fontWeight: 700, cursor: "not-allowed", opacity: 0.65 }}>Coming Soon</button>
          </div>
        ) : (
          <button disabled={!amount} onClick={handleConfirm} style={{ width: "100%", padding: "11px", borderRadius: 12, background: amount ? btnBg : "#e7e7ec", color: amount ? "white" : "#9ca3af", border: "none", fontSize: 14, fontWeight: 700, cursor: amount ? "pointer" : "not-allowed", transition: "all .2s" }}>
            {type === "supply" ? `Supply${poolType === "ika" ? " via Ika" : ""}` : type === "borrow" ? `Borrow ${pool.symbol}` : type === "withdraw" ? `Withdraw ${pool.symbol}` : `Repay ${pool.symbol}`}
          </button>
        )}
      </div>
    </div>
  );
};

// ─── App Root ───────────���─────────────────────────────────────────────────────

export default function DAppPage() {
  const { publicKey } = useWallet();
  const connected = !!publicKey;
  const { pools, loading: poolsLoading, error: poolsError, refresh: refreshPools } = usePools();
  const actions = useVeilActions();

  const [view, setView] = useState<View>("markets");
  const [fhe, setFhe] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [rpcDrawerOpen, setRpcDrawerOpen] = useState(false);
  const [portfolioRefreshKey, setPortfolioRefreshKey] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const pythPrices = usePythPrices();

  // Track pool addresses where the user has collateral (non-zero deposits)
  const [userCollateralPools, setUserCollateralPools] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!publicKey) { setUserCollateralPools(new Set()); return; }
    fetch(`/api/positions/${encodeURIComponent(publicKey.toBase58())}/detail`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d: { positions: DetailPosition[] }) => {
        const collPools = new Set<string>();
        for (const p of d.positions ?? []) {
          if (BigInt(p.deposit_tokens || "0") > 0n) collPools.add(p.pool_address);
        }
        setUserCollateralPools(collPools);
      })
      .catch(() => {});
  }, [publicKey, portfolioRefreshKey]);

  // Sync view from localStorage after hydration to avoid SSR mismatch
  const validViews: View[] = ["markets", "portfolio", "flash", "liquidate", "history"];
  useEffect(() => {
    const saved = localStorage.getItem("veil_view") as View | null;
    if (saved && saved !== view && validViews.includes(saved)) setView(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch actions hook status and update toasts
  const activeToastId = useRef<number | null>(null);
  useEffect(() => {
    const s = actions.status;
    if (s === "idle") return;

    if (s === "signing" || (s === "building")) {
      // shouldn't reach "building" in practice since it transitions fast
      return;
    }

    const id = activeToastId.current;
    if (id === null) return;

    setToasts((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      if (s === "confirming") return { ...t, status: "confirming" };
      if (s === "success") return { ...t, status: "success", sig: actions.txSig ?? undefined };
      if (s === "error") return { ...t, status: "error", error: actions.errorMsg ?? "Transaction failed" };
      return t;
    }));

    if (s === "success") {
      setTimeout(() => { refreshPools(); setPortfolioRefreshKey((k) => k + 1); }, 600);
      // Auto-dismiss success after 6s
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6000);
      activeToastId.current = null;
    }
    if (s === "error") {
      // Auto-dismiss error after 8s
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 8000);
      activeToastId.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.status, actions.txSig, actions.errorMsg]);

  // Called by ActionModal on submit — fires the action and creates a toast
  const handleActionSubmit = useCallback((type: ModalType, pool: PoolView, amount: bigint, withdrawShares?: bigint) => {
    actions.reset();
    const id = ++toastIdRef.current;
    activeToastId.current = id;
    const actionLabel = type === "supply" ? "Supply" : type === "withdraw" ? "Withdraw" : type === "borrow" ? "Borrow" : "Repay";
    setToasts((prev) => [...prev, { id, action: actionLabel, symbol: pool.symbol, status: "signing" }]);

    if (type === "supply") {
      actions.deposit(pool, amount);
    } else if (type === "withdraw") {
      // Use pre-computed bigint shares when available (from % buttons), fall back to token→shares conversion
      const shares = withdrawShares ?? (pool.supplyIndex > 0n ? (amount * WAD) / pool.supplyIndex : amount);
      actions.withdraw(pool, shares);
    } else if (type === "borrow") {
      // Smart borrow: if user has collateral in other pools, use crossBorrow
      // so the on-chain program can consider all collateral for HF calculation
      const poolAddr = pool.poolAddress.toBase58();
      const otherCollPools = pools.filter((p) => {
        const addr = p.poolAddress.toBase58();
        return addr !== poolAddr && userCollateralPools.has(addr);
      });
      if (otherCollPools.length > 0) {
        actions.crossBorrow(pool, otherCollPools, amount);
      } else {
        actions.borrow(pool, amount);
      }
    } else if (type === "repay") {
      actions.repay(pool, amount);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.deposit, actions.withdraw, actions.borrow, actions.repay, actions.crossBorrow, actions.reset, pools, userCollateralPools]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => { localStorage.setItem("veil_view", view); }, [view]);

  return (
    <div className="dapp-shell">
      <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none" }} className="page-bg" />
      <div aria-hidden className="grid-bg" style={{ position: "fixed", inset: 0, pointerEvents: "none", opacity: 0.5 }} />

      <AppNav view={view} setView={setView} fhe={fhe} setFhe={setFhe} onOpenRpc={() => setRpcDrawerOpen(true)} />

      <main className="dapp-main">
        {view === "markets" && <MarketsView fhe={fhe} setModal={setModal} pools={pools} poolsLoading={poolsLoading} poolsError={poolsError} refreshPools={refreshPools} />}
        {view === "portfolio" && <PortfolioView fhe={fhe} connected={connected} setModal={setModal} pools={pools} refreshKey={portfolioRefreshKey} />}
        {view === "flash" && <FlashView connected={connected} fhe={fhe} pools={pools} pythPrices={pythPrices} />}
        {view === "liquidate" && <LiquidateView connected={connected} pools={pools} pythPrices={pythPrices} />}
        {view === "history" && <HistoryView connected={connected} pools={pools} />}
      </main>

      <RpcSwitcher open={rpcDrawerOpen} onClose={() => setRpcDrawerOpen(false)} />
      {modal && modal.type === "ika-setup" ? (
        <IkaSetupModal pool={modal.pool} setModal={setModal} />
      ) : modal && (
        <ActionModal modal={modal} setModal={setModal} fhe={fhe} onSubmit={handleActionSubmit} pythPrices={pythPrices} />
      )}
      <TxToastContainer toasts={toasts} onDismiss={dismissToast} />
      {/* Mobile bottom tab bar — rendered outside stacking contexts */}
      <MobileTabBar view={view} setView={setView} />
    </div>
  );
}
