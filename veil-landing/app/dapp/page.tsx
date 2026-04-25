"use client";

import React, { useState, useEffect, CSSProperties } from "react";
import { WalletButton as WalletMultiButton } from "../components/WalletButton";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useVeilActions } from "./hooks/useVeilActions";
import { usePythPrices } from "./hooks/usePythPrices";
import { formatPrice, PythPrices } from "../../lib/pyth/prices";
import { usePools, type PoolView } from "@/lib/veil/usePools";

// ─── Types ────────────────────────────────────────────────────────────────────

type View = "markets" | "portfolio" | "flash";
type PoolType = "native" | "ika" | "oro" | "enc";
type ModalType = "supply" | "borrow" | "withdraw" | "repay" | "ika-setup";

interface PositionRow {
  position_address: string;
  pool_address: string;
  owner: string;
  deposit_shares: string;
  borrow_principal: string;
  health_factor_wad: string | null;
  last_synced_at: string;
}

interface ModalState {
  type: ModalType;
  pool: PoolView;
}

interface ApiEndpoint {
  method: string;
  path: string;
  desc: string;
  params: { n: string; t: string; d: string }[];
}

// ─── WAD helpers ──────────────────────────────────────────────────────────────

const WAD = 1_000_000_000_000_000_000n;

function wadToPctNum(v: bigint | null): number {
  if (!v) return 0;
  return Number((v * 10000n) / WAD) / 100;
}

function wadToPctStr(v: bigint | null): string {
  if (!v) return "—";
  return `${wadToPctNum(v)}%`;
}

function formatBigAmount(v: bigint): string {
  if (v === 0n) return "0";
  // Assume 9 decimal places (SOL/SPL standard), display as human-readable
  const whole = v / 1_000_000_000n;
  const frac = v % 1_000_000_000n;
  if (whole > 1_000_000n) return `${(Number(whole) / 1_000_000).toFixed(2)}M`;
  if (whole > 1_000n) return `${(Number(whole) / 1_000).toFixed(1)}K`;
  if (whole > 0n) return `${whole}.${frac.toString().slice(0, 2)}`;
  return v.toString();
}

// ─── Pool helpers ─────────────────────────────────────────────────────────────

function getPoolType(symbol: string): PoolType {
  const s = symbol.toUpperCase();
  if (s === "BTC" || s === "ETH") return "ika";
  if (s === "XAU") return "oro";
  if (s === "USDC") return "enc";
  return "native";
}

function getPoolIcon(symbol: string): string {
  const map: Record<string, string> = {
    SOL: "◎",
    BTC: "₿",
    ETH: "Ξ",
    XAU: "◈",
    USDC: "$",
  };
  return map[symbol.toUpperCase()] ?? "●";
}

function getPoolColor(symbol: string): string {
  const map: Record<string, string> = {
    SOL: "#7c3aed",
    BTC: "#f97316",
    ETH: "#6366f1",
    XAU: "#ca8a04",
    USDC: "#2563eb",
  };
  return map[symbol.toUpperCase()] ?? "#6b7280";
}

function poolUtil(p: PoolView): number {
  if (p.totalDeposits === 0n) return 0;
  return Number((p.totalBorrows * 10000n) / p.totalDeposits) / 100;
}

function borrowRate(
  baseRate: number,
  slope1: number,
  slope2: number,
  optimalUtil: number,
  u: number,
): number {
  if (u <= optimalUtil) return baseRate + (slope1 * u) / optimalUtil;
  return baseRate + slope1 + (slope2 * (u - optimalUtil)) / (100 - optimalUtil);
}

function supplyRate(
  baseRate: number,
  slope1: number,
  slope2: number,
  optimalUtil: number,
  reserveFactor: number,
  u: number,
): number {
  return (
    borrowRate(baseRate, slope1, slope2, optimalUtil, u) *
    (u / 100) *
    (1 - reserveFactor / 100)
  );
}

function poolBorrowApy(p: PoolView): number {
  const u = poolUtil(p);
  return borrowRate(
    wadToPctNum(p.baseRateWad),
    wadToPctNum(p.slope1Wad),
    wadToPctNum(p.slope2Wad),
    wadToPctNum(p.optimalUtilWad) || 80,
    u,
  );
}

function poolSupplyApy(p: PoolView): number {
  const u = poolUtil(p);
  return supplyRate(
    wadToPctNum(p.baseRateWad),
    wadToPctNum(p.slope1Wad),
    wadToPctNum(p.slope2Wad),
    wadToPctNum(p.optimalUtilWad) || 80,
    wadToPctNum(p.reserveFactorWad),
    u,
  );
}

// ─── Cipher animation ─────────────────────────────────────────────────────────

const CIPHER_POOL = [
  "7fA9·12Ce·88aD",
  "E4b2·9C01·F7dd",
  "A1b3·44Cc·ZzQ9",
  "5D0e·09Bc·4F8a",
  "Q7x2·MmN4·L20p",
  "9cE4·DdE1·0aBb",
];

function useCipher(seed = 0) {
  const [i, setI] = useState(seed % CIPHER_POOL.length);
  useEffect(() => {
    const t = setInterval(
      () => setI((p) => (p + 1) % CIPHER_POOL.length),
      2400 + seed * 180,
    );
    return () => clearInterval(t);
  }, [seed]);
  return CIPHER_POOL[i];
}

function CipherVal({ seed, mask }: { seed: number; mask: string }) {
  const v = useCipher(seed);
  return (
    <span className="cipher-mask rotate-cipher" title={`ct:${v}`}>
      {mask}
    </span>
  );
}

// ─── API reference ────────────────────────────────────────────────────────────

const API_ENDPOINTS: ApiEndpoint[] = [
  {
    method: "POST",
    path: "/v1/flash/borrow",
    desc: "Initiate a flash borrow. Returns a signed transaction envelope to include in your bundle.",
    params: [
      {
        n: "asset",
        t: "string",
        d: "Pool asset ID — sol | btc | eth | xau | usdc",
      },
      { n: "amount", t: "u64", d: "Lamports / base units to borrow" },
      {
        n: "receiver",
        t: "pubkey",
        d: "Program that will receive funds and repay",
      },
    ],
  },
  {
    method: "POST",
    path: "/v1/flash/repay",
    desc: "Append the repay instruction to the same transaction. Must be the final instruction.",
    params: [
      { n: "loan_id", t: "string", d: "Returned by /flash/borrow" },
      { n: "amount", t: "u64", d: "Principal + fee in base units" },
    ],
  },
  {
    method: "GET",
    path: "/v1/flash/pools",
    desc: "Returns available liquidity per pool and the current fee rate.",
    params: [],
  },
  {
    method: "GET",
    path: "/v1/flash/history/:wallet",
    desc: "Returns flash loan history for a wallet address.",
    params: [{ n: "wallet", t: "pubkey", d: "Solana wallet address" }],
  },
];

const METHOD_COLOR: Record<string, string> = {
  GET: "#059669",
  POST: "#6d28d9",
  DELETE: "#dc2626",
};

// ─── Tag ──────────────────────────────────────────────────────────────────────

function Tag({ type }: { type: PoolType }) {
  const map: Record<PoolType, [string, string]> = {
    ika: ["tag-ika", "Ika dWallet"],
    enc: ["tag-enc", "FHE encrypted"],
    oro: ["tag-oro", "Oro / GRAIL"],
    native: ["tag-native", "Native"],
  };
  const [cls, label] = map[type];
  return <span className={`tag ${cls}`}>{label}</span>;
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function Logo() {
  return (
    <Link
      href="/"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        textDecoration: "none",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 30,
          height: 30,
          borderRadius: 8,
          background: "linear-gradient(135deg,#6d28d9,#db2777)",
          boxShadow: "0 4px 14px -4px rgba(109,40,217,.5)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="white"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M4 5c4 6 12 6 16 0" />
          <path d="M4 12c4 6 12 6 16 0" opacity=".55" />
          <path d="M4 19c4 6 12 6 16 0" opacity=".28" />
        </svg>
      </span>
      <span
        style={{
          fontSize: 17,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: "#0b0b10",
        }}
      >
        Veil
      </span>
    </Link>
  );
}

// ─── Privacy Toggle ───────────────────────────────────────────────────────────

function PrivacyToggle({
  on,
  setOn,
}: {
  on: boolean;
  setOn: (fn: (v: boolean) => boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 12px",
        borderRadius: 999,
        border: "1px solid",
        borderColor: on ? "#c4b5fd" : "#e7e7ec",
        background: on ? "#ede9fe" : "white",
        cursor: "pointer",
        userSelect: "none",
        transition: "all .2s",
      }}
      onClick={() => setOn((v) => !v)}
    >
      <div
        className={`toggle-track ${on ? "on" : ""}`}
        style={{ width: 26, height: 15 }}
      >
        <div
          className="toggle-thumb"
          style={{ width: 10, height: 10, top: 2.5, left: 2.5 }}
        />
      </div>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: on ? "#4c1d95" : "#5b5b66",
        }}
      >
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

function AppNav({
  view,
  setView,
  fhe,
  setFhe,
}: {
  view: View;
  setView: (v: View) => void;
  fhe: boolean;
  setFhe: (fn: (v: boolean) => boolean) => void;
}) {
  const { publicKey } = useWallet();
  const tabs: { id: View; label: string }[] = [
    { id: "markets", label: "Markets" },
    { id: "portfolio", label: "Portfolio" },
    { id: "flash", label: "Flash Loans" },
  ];

  return (
    <header
      style={{ position: "sticky", top: 0, zIndex: 50, padding: "10px 20px" }}
    >
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 52,
          borderRadius: 999,
          border: "1px solid rgba(231,231,236,.8)",
          background: "rgba(255,255,255,.8)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          padding: "0 8px 0 18px",
          boxShadow:
            "0 1px 0 rgba(255,255,255,.7) inset,0 8px 24px -8px rgba(76,29,149,.1)",
        }}
      >
        <Logo />
        <div
          style={{
            display: "flex",
            gap: 3,
            background: "#f4f4f6",
            borderRadius: 999,
            padding: 3,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`dapp-tab ${view === t.id ? "active" : ""}`}
              onClick={() => setView(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PrivacyToggle on={fhe} setOn={setFhe} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid #e7e7ec",
              background: "white",
              fontSize: 12,
              color: "#5b5b66",
              fontWeight: 500,
            }}
          >
            <span className="pulse-dot" style={{ width: 6, height: 6 }} />
            Devnet
          </div>
          <Link
            href="/dapp/markets"
            style={navPillStyle}
            title="Live markets driven by /api/pools"
          >
            Markets
          </Link>
          <Link
            href="/dapp/positions"
            style={navPillStyle}
            title="Your positions"
          >
            Positions
          </Link>
          <Link href="/dapp/history" style={navPillStyle} title="Tx history">
            History
          </Link>
          <Link href="/dapp/liquidate" style={navPillStyle} title="Liquidator">
            Liquidate
          </Link>
          <Link
            href="/dapp/admin"
            style={{ ...navPillStyle, fontWeight: 600 }}
            title="Admin panel"
          >
            <svg
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="#9ca3af"
              style={{ marginRight: 4 }}
            >
              <path d="M8 1a5 5 0 100 10A5 5 0 008 1zm0 8a3 3 0 110-6 3 3 0 010 6zm4.5 1.5h-9a.5.5 0 00-.5.5v.5a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V11a.5.5 0 00-.5-.5z" />
            </svg>
            Admin
          </Link>
          <WalletMultiButton
            style={{
              fontSize: "12.5px",
              height: "34px",
              borderRadius: "999px",
              padding: "0 14px",
              background: publicKey ? "#ecfdf5" : "#0b0b10",
              color: publicKey ? "#065f46" : "#ffffff",
              border: publicKey ? "1px solid #a7f3d0" : "none",
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          />
        </div>
      </nav>
    </header>
  );
}

const navPillStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #e7e7ec",
  background: "white",
  fontSize: 12,
  color: "#5b5b66",
  fontWeight: 500,
  textDecoration: "none",
  transition: "all .15s",
};

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,.7)",
        border: "1px solid #f0f0f3",
        borderRadius: 12,
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: "#5b5b66",
          fontWeight: 500,
          marginBottom: 5,
          letterSpacing: ".02em",
          textTransform: "uppercase" as const,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: color ?? "#0b0b10",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── Asset Icon ───────────────────────────────────────────────────────────────

function AssetIcon({ pool, size = 34 }: { pool: PoolView; size?: number }) {
  const type = getPoolType(pool.symbol);
  const bg =
    type === "ika"
      ? "linear-gradient(135deg,#f97316,#eab308)"
      : type === "oro"
        ? "linear-gradient(135deg,#eab308,#ca8a04)"
        : type === "enc"
          ? "linear-gradient(135deg,#6d28d9,#9333ea)"
          : "linear-gradient(135deg,#7c3aed,#6d28d9)";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.29,
        display: "grid",
        placeItems: "center",
        fontSize: size * 0.41,
        fontWeight: 700,
        flexShrink: 0,
        background: bg,
        color: "white",
      }}
    >
      {getPoolIcon(pool.symbol)}
    </div>
  );
}

// ─── Util Bar ─────────────────────────────────────────────────────────────────

function UtilBar({ pct }: { pct: number }) {
  const color = pct > 80 ? "#dc2626" : pct > 60 ? "#d97706" : "#059669";
  return (
    <div
      style={{
        marginTop: 4,
        height: 3,
        background: "#f0f0f3",
        borderRadius: 2,
        overflow: "hidden",
        width: "80%",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: 2,
          transition: "width .6s",
        }}
      />
    </div>
  );
}

// ─── IRM Chart ────────────────────────────────────────────────────────────────

function IrmChart({ pool }: { pool: PoolView }) {
  const VW = 240,
    VH = 110;
  const padL = 30,
    padB = 22,
    padT = 8,
    padR = 10;
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

  const bp = Array.from(
    { length: 101 },
    (_, i) =>
      `${X(i).toFixed(1)},${Y(borrowRate(base, s1, s2, optUtil, i)).toFixed(1)}`,
  ).join(" ");
  const sp = Array.from(
    { length: 101 },
    (_, i) =>
      `${X(i).toFixed(1)},${Y(supplyRate(base, s1, s2, optUtil, rf, i)).toFixed(1)}`,
  ).join(" ");

  const kx = X(optUtil);
  const cx = X(currentUtil);
  const cy = Y(borrowRate(base, s1, s2, optUtil, currentUtil));
  const midRate = Math.round(maxY / 2);

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: "block" }}>
      <line
        x1={padL}
        y1={padT}
        x2={padL}
        y2={padT + cH}
        stroke="#e7e7ec"
        strokeWidth="1"
      />
      <line
        x1={padL}
        y1={padT + cH}
        x2={VW - padR}
        y2={padT + cH}
        stroke="#e7e7ec"
        strokeWidth="1"
      />
      {[0, midRate, maxY].map((v) => (
        <g key={v}>
          <line
            x1={padL}
            y1={Y(v)}
            x2={VW - padR}
            y2={Y(v)}
            stroke="#f0f0f3"
            strokeWidth="1"
          />
          <text
            x={padL - 4}
            y={Y(v) + 3.5}
            textAnchor="end"
            fontSize="8"
            fill="#9ca3af"
          >
            {v}%
          </text>
        </g>
      ))}
      <text x={padL} y={VH - 3} textAnchor="middle" fontSize="8" fill="#9ca3af">
        0%
      </text>
      <text x={kx} y={VH - 3} textAnchor="middle" fontSize="8" fill="#8b5cf6">
        {optUtil}%
      </text>
      <text
        x={VW - padR}
        y={VH - 3}
        textAnchor="end"
        fontSize="8"
        fill="#9ca3af"
      >
        100%
      </text>
      <line
        x1={kx}
        y1={padT}
        x2={kx}
        y2={padT + cH}
        stroke="#c4b5fd"
        strokeWidth="1"
        strokeDasharray="3 2"
      />
      <polyline
        points={sp}
        fill="none"
        stroke="#059669"
        strokeWidth="1.5"
        opacity="0.65"
      />
      <polyline points={bp} fill="none" stroke="#d97706" strokeWidth="2" />
      <line
        x1={cx}
        y1={padT}
        x2={cx}
        y2={padT + cH}
        stroke="#6d28d9"
        strokeWidth="1"
        strokeDasharray="3 2"
      />
      <circle
        cx={cx}
        cy={cy}
        r="3.5"
        fill="#d97706"
        stroke="white"
        strokeWidth="1.5"
      />
    </svg>
  );
}

// ─── Pool Detail Panel ────────────────────────────────────────────────────────

function PoolDetail({
  pool,
  fhe,
  setModal,
  onClose,
  pythPrices,
}: {
  pool: PoolView;
  fhe: boolean;
  setModal: (m: ModalState | null) => void;
  onClose: () => void;
  pythPrices?: PythPrices;
}) {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        className="glass-card"
        style={{ borderRadius: 18, overflow: "hidden" }}
      >
        <div
          style={{
            padding: "16px 18px 14px",
            borderBottom: "1px solid #f0f0f3",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AssetIcon pool={pool} size={38} />
            <div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                {pool.symbol}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 3,
                }}
              >
                <Tag type={type} />
                <span
                  style={{
                    fontSize: 11.5,
                    color: "#9ca3af",
                    fontFamily: "var(--font-mono),monospace",
                  }}
                >
                  {formatPrice(pythPrices?.[pool.id], "—")}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              border: "1px solid #e7e7ec",
              background: "#f4f4f6",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              fontSize: 13,
              color: "#5b5b66",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 0,
            borderBottom: "1px solid #f0f0f3",
          }}
        >
          {[
            {
              label: "Supply APY",
              value: `+${sApy.toFixed(1)}%`,
              color: "#059669",
              bg: "#f0fdf4",
            },
            {
              label: "Borrow APY",
              value: `${bApy.toFixed(1)}%`,
              color: "#d97706",
              bg: "#fffbeb",
            },
            {
              label: "Utilization",
              value: enc ? "––" : `${util.toFixed(0)}%`,
              color: utilColor,
              bg: "#fafafc",
            },
          ].map((s, i) => (
            <div
              key={i}
              style={{
                padding: "14px 16px",
                background: s.bg,
                borderRight: i < 2 ? "1px solid #f0f0f3" : "none",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: ".05em",
                  textTransform: "uppercase" as const,
                  color: "#9ca3af",
                  marginBottom: 5,
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: s.color,
                  letterSpacing: "-0.02em",
                }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f3" }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            <span style={{ color: "#5b5b66", fontWeight: 500 }}>
              Pool utilization
            </span>
            <span style={{ fontWeight: 700, color: utilColor }}>
              {enc ? "––" : `${util.toFixed(0)}%`}
            </span>
          </div>
          <div
            style={{
              height: 6,
              background: "#f0f0f3",
              borderRadius: 3,
              overflow: "hidden",
              marginBottom: 10,
            }}
          >
            <div
              style={{
                height: "100%",
                width: enc ? "0" : `${util}%`,
                background:
                  util > 80
                    ? "#dc2626"
                    : util > 60
                      ? "#d97706"
                      : "linear-gradient(90deg,#059669,#10b981)",
                borderRadius: 3,
                transition: "width .6s",
              }}
            />
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <div
              style={{
                background: "#f9f9fb",
                borderRadius: 8,
                padding: "8px 10px",
                border: "1px solid #f0f0f3",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#9ca3af",
                  fontWeight: 500,
                  marginBottom: 2,
                }}
              >
                Total supplied
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {enc ? (
                  <CipherVal seed={0} mask="$◉◉◉,◉◉◉" />
                ) : (
                  formatBigAmount(pool.totalDeposits)
                )}
              </div>
            </div>
            <div
              style={{
                background: "#f9f9fb",
                borderRadius: 8,
                padding: "8px 10px",
                border: "1px solid #f0f0f3",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#9ca3af",
                  fontWeight: 500,
                  marginBottom: 2,
                }}
              >
                Available
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>
                {enc ? "••••" : formatBigAmount(availLiq > 0n ? availLiq : 0n)}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f3" }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".05em",
              textTransform: "uppercase" as const,
              color: "#5b5b66",
              marginBottom: 10,
            }}
          >
            Interest Rate Model
          </div>
          <IrmChart pool={pool} />
          <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
            <span
              style={{
                fontSize: 10.5,
                color: "#d97706",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 2,
                  background: "#d97706",
                  display: "inline-block",
                  borderRadius: 1,
                }}
              />{" "}
              Borrow APY
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: "#059669",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 2,
                  background: "#059669",
                  display: "inline-block",
                  borderRadius: 1,
                  opacity: 0.65,
                }}
              />{" "}
              Supply APY
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: "#8b5cf6",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 2,
                  background: "#8b5cf6",
                  display: "inline-block",
                  borderRadius: 1,
                  opacity: 0.6,
                }}
              />{" "}
              Kink
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 8,
              flexWrap: "wrap" as const,
            }}
          >
            {[
              { k: "Base", v: `${base}%` },
              { k: "Slope\u2081", v: `${s1}%` },
              { k: "Kink", v: `${optUtil}%` },
              { k: "Slope\u2082", v: `${s2}%` },
            ].map((r, i) => (
              <div
                key={i}
                style={{
                  background: "#f4f4f6",
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontSize: 11,
                }}
              >
                <span style={{ color: "#9ca3af" }}>{r.k} </span>
                <span style={{ fontWeight: 700, color: "#0b0b10" }}>{r.v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: "14px 18px" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".05em",
              textTransform: "uppercase" as const,
              color: "#5b5b66",
              marginBottom: 10,
            }}
          >
            Risk Parameters
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginBottom: 14,
            }}
          >
            {[
              { k: "Max LTV", v: `${ltv}%`, info: "Maximum loan-to-value" },
              {
                k: "Liq. threshold",
                v: `${liqTh}%`,
                info: "Health factor liquidation trigger",
              },
              {
                k: "Liq. bonus",
                v: `+${liqBonus}%`,
                info: "Discount liquidators receive",
              },
              {
                k: "Reserve factor",
                v: `${rf}%`,
                info: "Share of interest to protocol",
              },
            ].map((r, i) => (
              <div
                key={i}
                style={{
                  background: "#f9f9fb",
                  borderRadius: 10,
                  padding: "10px 12px",
                  border: "1px solid #f0f0f3",
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    color: "#5b5b66",
                    fontWeight: 500,
                    marginBottom: 4,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {r.k}
                  <span
                    title={r.info}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      border: "1px solid #e7e7ec",
                      display: "inline-grid",
                      placeItems: "center",
                      fontSize: 8,
                      color: "#9ca3af",
                      cursor: "help",
                      flexShrink: 0,
                    }}
                  >
                    ?
                  </span>
                </div>
                <div
                  style={{ fontSize: 17, fontWeight: 700, color: "#0b0b10" }}
                >
                  {r.v}
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              color: "#5b5b66",
              padding: "8px 10px",
              background: "#f4f4f6",
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="#6d28d9">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="#6d28d9"
                strokeWidth="1.5"
                fill="none"
              />
              <path
                d="M8 4v4l2.5 2.5"
                stroke="#6d28d9"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            Oracle:{" "}
            <span style={{ fontWeight: 600, color: "#4c1d95" }}>
              Pyth Network
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 10,
                background: "#ede9fe",
                color: "#6d28d9",
                padding: "1px 6px",
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              live
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-supply"
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
                background:
                  type === "ika"
                    ? "linear-gradient(135deg,#f97316,#eab308)"
                    : undefined,
              }}
              onClick={() =>
                setModal({
                  type: type === "ika" ? "ika-setup" : "supply",
                  pool,
                })
              }
            >
              {type === "ika" ? "Register dWallet" : "Supply"}
            </button>
            <button
              className="btn-borrow"
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
              }}
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

function PositionSummary({
  connected,
  fhe,
  pools,
  positions,
  setModal,
}: {
  connected: boolean;
  fhe: boolean;
  pools: PoolView[];
  positions: PositionRow[];
  setModal: (m: ModalState | null) => void;
}) {
  const hasPositions = connected && positions.length > 0;
  const totalDepositShares = positions.reduce(
    (s, p) => s + BigInt(p.deposit_shares || "0"),
    0n,
  );
  const totalBorrowPrincipal = positions.reduce(
    (s, p) => s + BigInt(p.borrow_principal || "0"),
    0n,
  );

  const metrics = [
    {
      label: "Deposit Shares",
      value: hasPositions ? formatBigAmount(totalDepositShares) : "0",
      color: connected ? "#0b0b10" : "#c4c4cc",
    },
    {
      label: "Borrow Principal",
      value: hasPositions ? formatBigAmount(totalBorrowPrincipal) : "0",
      color: connected ? "#dc2626" : "#c4c4cc",
    },
    {
      label: "Positions",
      value: connected ? String(positions.length) : "0",
      color: connected ? "#0b0b10" : "#c4c4cc",
    },
    {
      label: "Pools Available",
      value: String(pools.length),
      color: connected ? "#059669" : "#c4c4cc",
    },
  ];

  return (
    <div
      style={{
        position: "sticky",
        top: 82,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        className="glass-card"
        style={{ borderRadius: 18, overflow: "hidden" }}
      >
        <div
          style={{
            padding: "16px 18px 12px",
            borderBottom: "1px solid #f0f0f3",
          }}
        >
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: ".06em",
              textTransform: "uppercase" as const,
              color: "#5b5b66",
              marginBottom: 2,
            }}
          >
            Position Summary
          </div>
          {!connected && (
            <div style={{ fontSize: 12, color: "#5b5b66", marginTop: 4 }}>
              Connect wallet to see your position
            </div>
          )}
        </div>
        <div style={{ padding: "0 0 4px" }}>
          {metrics.map((m, i) => (
            <div
              key={i}
              style={{
                padding: "13px 18px",
                borderBottom: i < 3 ? "1px solid #f7f7f9" : "none",
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  color: "#5b5b66",
                  fontWeight: 500,
                  marginBottom: 5,
                }}
              >
                {m.label}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: "-0.03em",
                  color: m.color,
                }}
              >
                {m.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-card" style={{ borderRadius: 18, padding: 18 }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: ".06em",
            textTransform: "uppercase" as const,
            color: "#5b5b66",
            marginBottom: 12,
          }}
        >
          Your Collateral
        </div>
        {!hasPositions ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 12 }}>
              No collateral posted
            </div>
            {pools.length > 0 && (
              <button
                className="btn-supply"
                style={{ fontSize: 12.5, padding: "7px 18px" }}
                onClick={() => setModal({ type: "supply", pool: pools[0] })}
              >
                Supply assets
              </button>
            )}
          </div>
        ) : (
          <>
            {positions
              .filter((p) => BigInt(p.deposit_shares || "0") > 0n)
              .map((pos, i) => {
                const pool = pools.find(
                  (p) => p.poolAddress.toBase58() === pos.pool_address,
                );
                if (!pool) return null;
                const enc = fhe && getPoolType(pool.symbol) === "enc";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 0",
                      borderBottom:
                        i < positions.length - 1 ? "1px solid #f7f7f9" : "none",
                    }}
                  >
                    <AssetIcon pool={pool} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {pool.symbol}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {enc ? (
                            <CipherVal seed={20 + i} mask="◉◉◉◉" />
                          ) : (
                            formatBigAmount(BigInt(pos.deposit_shares))
                          )}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "#5b5b66" }}>
                        shares · HF{" "}
                        {pos.health_factor_wad
                          ? (
                              Number(
                                (BigInt(pos.health_factor_wad) * 100n) / WAD,
                              ) / 100
                            ).toFixed(2)
                          : "—"}
                      </div>
                    </div>
                  </div>
                );
              })}
            {pools.length > 0 && (
              <button
                className="btn-supply"
                style={{
                  width: "100%",
                  marginTop: 12,
                  padding: "8px",
                  borderRadius: 10,
                  fontSize: 13,
                }}
                onClick={() => setModal({ type: "supply", pool: pools[0] })}
              >
                + Add collateral
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Markets View ─────────────────────────────────────────────────────────────

function MarketsView({
  fhe,
  connected,
  setModal,
  pools,
  poolsLoading,
  poolsError,
  refreshPools,
  positions,
}: {
  fhe: boolean;
  connected: boolean;
  setModal: (m: ModalState | null) => void;
  pools: PoolView[];
  poolsLoading: boolean;
  poolsError: string | null;
  refreshPools: () => void;
  positions: PositionRow[];
}) {
  const [poolTab, setPoolTab] = useState<"all" | "supply" | "borrow">("all");
  const [selectedPool, setSelectedPool] = useState<PoolView | null>(null);
  const pythPrices = usePythPrices();

  const totalDeposits = pools.reduce((s, p) => s + p.totalDeposits, 0n);
  const totalBorrows = pools.reduce((s, p) => s + p.totalBorrows, 0n);
  const avgUtil =
    pools.length > 0
      ? pools.reduce((s, p) => s + poolUtil(p), 0) / pools.length
      : 0;
  const bestSupply =
    pools.length > 0 ? Math.max(...pools.map(poolSupplyApy)) : 0;
  const bestPool = pools.find((p) => poolSupplyApy(p) === bestSupply);

  const colStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "2fr 1.2fr 0.8fr 1.2fr 0.8fr 80px 28px",
    alignItems: "center",
  };

  return (
    <div
      className="fade-rise"
      style={{ maxWidth: 1280, margin: "0 auto", padding: "0 20px 40px" }}
    >
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "#5b5b66",
            letterSpacing: ".05em",
            textTransform: "uppercase",
          }}
        >
          Protocol overview
        </span>
        <span style={{ fontSize: 11.5, color: "#9ca3af" }}>
          — all figures are protocol-wide, not your portfolio
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 10,
          marginBottom: 20,
        }}
      >
        <MetricCard
          label="Total Supplied"
          value={formatBigAmount(totalDeposits)}
          sub="Protocol-wide"
        />
        <MetricCard
          label="Total Borrowed"
          value={formatBigAmount(totalBorrows)}
          sub="Protocol-wide"
        />
        <MetricCard
          label="Utilization"
          value={`${avgUtil.toFixed(0)}%`}
          color="#d97706"
          sub="Avg across pools"
        />
        <MetricCard
          label="Best Supply APY"
          value={`${bestSupply.toFixed(1)}%`}
          color="#059669"
          sub={bestPool ? `${bestPool.symbol} pool` : ""}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: selectedPool ? "1fr 360px" : "1fr 320px",
          gap: 16,
          alignItems: "start",
          transition: "grid-template-columns .25s",
        }}
      >
        <div>
          <div
            className="glass-card"
            style={{ borderRadius: 18, overflow: "hidden" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px 0",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 3,
                  background: "#f4f4f6",
                  borderRadius: 999,
                  padding: 3,
                }}
              >
                {(
                  [
                    { id: "all", label: "All pools" },
                    { id: "supply", label: "Supply" },
                    { id: "borrow", label: "Borrow" },
                  ] as { id: "all" | "supply" | "borrow"; label: string }[]
                ).map((t) => (
                  <button
                    key={t.id}
                    className={`dapp-tab ${poolTab === t.id ? "active" : ""}`}
                    style={{ padding: "5px 12px", fontSize: 13 }}
                    onClick={() => setPoolTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {fhe && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 12,
                    color: "#4c1d95",
                    fontWeight: 500,
                    background: "#ede9fe",
                    padding: "4px 10px",
                    borderRadius: 999,
                  }}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="11"
                    height="11"
                    fill="#6d28d9"
                  >
                    <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
                  </svg>
                  FHE active
                </div>
              )}
            </div>

            <div
              style={{
                ...colStyle,
                padding: "10px 18px",
                marginTop: 10,
                borderBottom: "1px solid #f0f0f3",
              }}
            >
              {[
                "Asset",
                "Total supply",
                "Supply APY",
                "Total borrow",
                "Borrow APY",
                "Utilization",
                "",
              ].map((h, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "#5b5b66",
                    fontWeight: 600,
                    letterSpacing: ".04em",
                    textTransform: "uppercase",
                  }}
                >
                  {h}
                </span>
              ))}
            </div>

            {poolsLoading ? (
              <div
                style={{
                  padding: "48px 18px",
                  textAlign: "center",
                  color: "#6b7280",
                  fontSize: 14,
                }}
              >
                Loading pools from API...
              </div>
            ) : poolsError ? (
              <div style={{ padding: "24px 18px", textAlign: "center" }}>
                <div
                  style={{ color: "#dc2626", marginBottom: 8, fontSize: 13 }}
                >
                  API error: {poolsError}
                </div>
                <button
                  onClick={refreshPools}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    border: "1px solid #e5e7eb",
                    background: "white",
                    cursor: "pointer",
                  }}
                >
                  retry
                </button>
              </div>
            ) : pools.length === 0 ? (
              <div style={{ padding: "48px 18px", textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
                  No pools initialized yet
                </div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  An admin must create pools via{" "}
                  <Link href="/dapp/admin" style={{ color: "#2563eb" }}>
                    /dapp/admin
                  </Link>
                  .
                </div>
              </div>
            ) : (
              pools.map((p, idx) => {
                const type = getPoolType(p.symbol);
                const enc = fhe && type === "enc";
                const isSelected =
                  selectedPool?.poolAddress.toBase58() ===
                  p.poolAddress.toBase58();
                const util = poolUtil(p);
                const utilColor =
                  util > 80 ? "#dc2626" : util > 60 ? "#d97706" : "#059669";
                const sApy = poolSupplyApy(p);
                const bApy = poolBorrowApy(p);
                const availLiq = p.totalDeposits - p.totalBorrows;

                return (
                  <div
                    key={p.poolAddress.toBase58()}
                    className="pool-row"
                    style={{
                      ...colStyle,
                      padding: "13px 18px",
                      borderBottom:
                        idx < pools.length - 1 ? "1px solid #f7f7f9" : "none",
                      cursor: "pointer",
                      background: isSelected ? "#faf9ff" : "transparent",
                      borderLeft: isSelected
                        ? "3px solid #6d28d9"
                        : "3px solid transparent",
                      transition: "background .12s, border-left .12s",
                    }}
                    onClick={() => setSelectedPool(isSelected ? null : p)}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <AssetIcon pool={p} />
                      <div>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: "#0b0b10",
                          }}
                        >
                          {p.symbol}
                        </div>
                        <Tag type={type} />
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "#0b0b10",
                        }}
                      >
                        {enc ? (
                          <CipherVal seed={idx * 2} mask="$◉◉◉,◉◉◉" />
                        ) : (
                          formatBigAmount(p.totalDeposits)
                        )}
                      </div>
                      <div
                        style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}
                      >
                        {enc
                          ? "––"
                          : formatBigAmount(availLiq > 0n ? availLiq : 0n) +
                            " avail"}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#059669",
                      }}
                    >
                      +{sApy.toFixed(1)}%
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "#0b0b10",
                        }}
                      >
                        {enc ? (
                          <CipherVal seed={idx * 2 + 1} mask="$◉◉◉,◉◉◉" />
                        ) : (
                          formatBigAmount(p.totalBorrows)
                        )}
                      </div>
                      <div
                        style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}
                      >
                        {enc ? "––" : `${wadToPctNum(p.ltvWad)}% LTV`}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#d97706",
                      }}
                    >
                      {bApy.toFixed(1)}%
                    </div>
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: utilColor,
                          }}
                        >
                          {enc ? "––" : `${util.toFixed(0)}%`}
                        </span>
                      </div>
                      <UtilBar pct={enc ? 0 : util} />
                    </div>
                    <div
                      style={{ display: "flex", justifyContent: "flex-end" }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke={isSelected ? "#6d28d9" : "#c4c4cc"}
                        strokeWidth="2"
                        strokeLinecap="round"
                        style={{
                          transform: isSelected ? "rotate(180deg)" : "none",
                          transition: "transform .2s, stroke .2s",
                        }}
                      >
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div
            style={{
              marginTop: 10,
              padding: "9px 14px",
              background: "rgba(255,255,255,.55)",
              border: "1px solid #f0f0f3",
              borderRadius: 10,
              fontSize: 11.5,
              color: "#5b5b66",
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9">
              <path d="M11 1l-6 8h3l-1 6 6-8h-3l1-6z" />
            </svg>
            Kink-based rate model · Pyth oracle price feeds · Click any pool to
            view reserve details
          </div>
        </div>

        <div style={{ position: "sticky", top: 82 }}>
          {selectedPool ? (
            <PoolDetail
              pool={selectedPool}
              fhe={fhe}
              setModal={setModal}
              onClose={() => setSelectedPool(null)}
              pythPrices={pythPrices}
            />
          ) : (
            <PositionSummary
              connected={connected}
              fhe={fhe}
              pools={pools}
              positions={positions}
              setModal={setModal}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Portfolio View ───────────────────────────────────────────────────────────

function PortfolioView({
  fhe,
  connected,
  setModal,
  pools,
  positions,
}: {
  fhe: boolean;
  connected: boolean;
  setModal: (m: ModalState | null) => void;
  pools: PoolView[];
  positions: PositionRow[];
}) {
  if (!connected) {
    return (
      <div
        className="fade-rise"
        style={{
          maxWidth: 1240,
          margin: "60px auto",
          padding: "0 20px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: "#f4f4f6",
            border: "1px solid #e7e7ec",
            display: "grid",
            placeItems: "center",
            margin: "0 auto 16px",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="#9ca3af"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
          Connect your wallet
        </div>
        <div style={{ fontSize: 14, color: "#5b5b66" }}>
          Connect a Solana wallet to view your positions and manage collateral.
        </div>
      </div>
    );
  }

  const supplied = positions.filter(
    (p) => BigInt(p.deposit_shares || "0") > 0n,
  );
  const borrowed = positions.filter(
    (p) => BigInt(p.borrow_principal || "0") > 0n,
  );
  const totalDeposits = supplied.reduce(
    (s, p) => s + BigInt(p.deposit_shares || "0"),
    0n,
  );
  const totalBorrows = borrowed.reduce(
    (s, p) => s + BigInt(p.borrow_principal || "0"),
    0n,
  );

  // Compute min health factor across positions
  const hfValues = positions
    .filter(
      (p) => p.health_factor_wad && BigInt(p.health_factor_wad) < 1n << 100n,
    )
    .map((p) => Number((BigInt(p.health_factor_wad!) * 100n) / WAD) / 100);
  const minHF = hfValues.length > 0 ? Math.min(...hfValues) : null;
  const hfColor =
    minHF === null
      ? "#9ca3af"
      : minHF > 1.5
        ? "#059669"
        : minHF > 1.1
          ? "#d97706"
          : "#dc2626";

  return (
    <div
      className="fade-rise"
      style={{ maxWidth: 1240, margin: "0 auto", padding: "0 20px 40px" }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 10,
          marginBottom: 20,
        }}
      >
        <MetricCard label="Positions" value={String(positions.length)} />
        <MetricCard
          label="Deposit Shares"
          value={formatBigAmount(totalDeposits)}
          color="#059669"
        />
        <MetricCard
          label="Borrow Principal"
          value={formatBigAmount(totalBorrows)}
          color="#dc2626"
        />
        <MetricCard
          label="Min Health Factor"
          value={minHF !== null ? minHF.toFixed(2) : "—"}
          color={hfColor}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 300px",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Supplied */}
        <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: "#5b5b66",
              letterSpacing: ".06em",
              textTransform: "uppercase" as const,
              marginBottom: 14,
            }}
          >
            Supplied
          </div>
          {supplied.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "16px 0",
                color: "#9ca3af",
                fontSize: 13,
              }}
            >
              No deposits yet
            </div>
          ) : (
            supplied.map((pos, i) => {
              const pool = pools.find(
                (p) => p.poolAddress.toBase58() === pos.pool_address,
              );
              if (!pool) return null;
              const enc = fhe && getPoolType(pool.symbol) === "enc";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 13px",
                    background: "#f9f9fb",
                    borderRadius: 12,
                    marginBottom: 8,
                    border: "1px solid #f0f0f3",
                  }}
                >
                  <AssetIcon pool={pool} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        {pool.symbol}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        {enc ? (
                          <CipherVal seed={i + 10} mask="◉◉◉◉" />
                        ) : (
                          formatBigAmount(BigInt(pos.deposit_shares))
                        )}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 2,
                      }}
                    >
                      <Tag type={getPoolType(pool.symbol)} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "#059669",
                          fontWeight: 500,
                        }}
                      >
                        +{poolSupplyApy(pool).toFixed(1)}% APY
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn-borrow"
                    style={{
                      fontSize: 11.5,
                      padding: "4px 10px",
                      flexShrink: 0,
                    }}
                    onClick={() => setModal({ type: "withdraw", pool })}
                  >
                    Withdraw
                  </button>
                </div>
              );
            })
          )}
          {pools.length > 0 && (
            <button
              className="btn-supply"
              style={{
                width: "100%",
                padding: "9px",
                borderRadius: 10,
                fontSize: 13,
                marginTop: 8,
              }}
              onClick={() => setModal({ type: "supply", pool: pools[0] })}
            >
              + Supply more
            </button>
          )}
        </div>

        {/* Borrowed + Risk */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                color: "#5b5b66",
                letterSpacing: ".06em",
                textTransform: "uppercase" as const,
                marginBottom: 14,
              }}
            >
              Borrowed
            </div>
            {borrowed.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "16px 0",
                  color: "#9ca3af",
                  fontSize: 13,
                }}
              >
                No borrows yet
              </div>
            ) : (
              borrowed.map((pos, i) => {
                const pool = pools.find(
                  (p) => p.poolAddress.toBase58() === pos.pool_address,
                );
                if (!pool) return null;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "11px 13px",
                      background: "#f9f9fb",
                      borderRadius: 12,
                      marginBottom: 8,
                      border: "1px solid #f0f0f3",
                    }}
                  >
                    <AssetIcon pool={pool} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 600 }}>
                          {pool.symbol}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>
                          {formatBigAmount(BigInt(pos.borrow_principal))}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginTop: 2,
                        }}
                      >
                        <Tag type={getPoolType(pool.symbol)} />
                        <span
                          style={{
                            fontSize: 12,
                            color: "#dc2626",
                            fontWeight: 500,
                          }}
                        >
                          {poolBorrowApy(pool).toFixed(1)}% APY
                        </span>
                      </div>
                    </div>
                    <button
                      className="btn-borrow"
                      style={{
                        fontSize: 11.5,
                        padding: "4px 10px",
                        flexShrink: 0,
                      }}
                      onClick={() => setModal({ type: "repay", pool })}
                    >
                      Repay
                    </button>
                  </div>
                );
              })
            )}
            {pools.length > 0 && (
              <button
                className="btn-borrow"
                style={{
                  width: "100%",
                  padding: "9px",
                  borderRadius: 10,
                  fontSize: 13,
                  marginTop: 8,
                }}
                onClick={() => setModal({ type: "borrow", pool: pools[0] })}
              >
                + Borrow more
              </button>
            )}
          </div>

          <div className="glass-card" style={{ borderRadius: 18, padding: 20 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                color: "#5b5b66",
                letterSpacing: ".06em",
                textTransform: "uppercase" as const,
                marginBottom: 14,
              }}
            >
              Risk
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 13,
                marginBottom: 5,
              }}
            >
              <span style={{ color: "#5b5b66" }}>Min health factor</span>
              <span style={{ fontWeight: 700, color: hfColor }}>
                {minHF !== null
                  ? `${minHF.toFixed(2)} · ${minHF > 1.5 ? "Safe" : minHF > 1.1 ? "Watch" : "Danger"}`
                  : "—"}
              </span>
            </div>
            <div className="hf-bar-wrap" style={{ margin: "0 0 4px" }}>
              <div
                className="hf-bar"
                style={{
                  width:
                    minHF !== null
                      ? `${Math.min((minHF / 3) * 100, 100)}%`
                      : "0",
                  background: hfColor,
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 14 }}>
              Liquidation below 1.0
            </div>
          </div>
        </div>

        <PositionSummary
          connected={connected}
          fhe={fhe}
          pools={pools}
          positions={positions}
          setModal={setModal}
        />
      </div>
    </div>
  );
}

// ─── Flash Loans View ─────────────────────────────────────────────────────────

function FlashView({
  connected,
  fhe,
  pools,
}: {
  connected: boolean;
  fhe: boolean;
  pools: PoolView[];
}) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [openEndpoint, setOpenEndpoint] = useState<number | null>(null);
  const pool = pools[selectedIdx] ?? null;
  const { flashExecute, status, txSig, errorMsg, reset } = useVeilActions();

  const feeBps = pool?.flashFeeBps ?? 9;
  const feeRate = feeBps / 10000;

  return (
    <div
      className="fade-rise"
      style={{ maxWidth: 1240, margin: "0 auto", padding: "0 20px 40px" }}
    >
      {pools.length === 0 ? (
        <div
          style={{
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: "48px 24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
            No pools available
          </div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            Pools must be initialized before flash loans are available.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.15fr 1fr",
            gap: 16,
            alignItems: "start",
            marginBottom: 16,
          }}
        >
          <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: ".08em",
                color: "#5b5b66",
                textTransform: "uppercase" as const,
                marginBottom: 12,
              }}
            >
              Flash Loans
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: "-0.03em",
                marginBottom: 8,
              }}
            >
              Atomic, uncollateralized liquidity
            </div>
            <p
              style={{
                fontSize: 14,
                color: "#5b5b66",
                lineHeight: 1.7,
                marginBottom: 18,
              }}
            >
              Borrow any amount within a single Solana transaction — no
              collateral required. Funds must be returned with fee by the final
              instruction. If repayment is insufficient, the transaction reverts
              atomically.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginBottom: 18,
              }}
            >
              {[
                { k: "Fee", v: `${(feeRate * 100).toFixed(2)}%` },
                { k: "LP share", v: "90%" },
                { k: "Max borrow", v: "Free liquidity" },
                { k: "Enforcement", v: "Program-level" },
              ].map((r, i) => (
                <div
                  key={i}
                  style={{
                    background: "#f4f4f6",
                    borderRadius: 10,
                    padding: "10px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: "#5b5b66",
                      fontWeight: 500,
                      marginBottom: 2,
                    }}
                  >
                    {r.k}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{r.v}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "#5b5b66",
                letterSpacing: ".04em",
                textTransform: "uppercase" as const,
                marginBottom: 8,
              }}
            >
              Available liquidity
            </div>
            {pools.map((p, i) => {
              const util = poolUtil(p);
              const avail = p.totalDeposits - p.totalBorrows;
              return (
                <div
                  key={p.poolAddress.toBase58()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 0",
                    borderBottom:
                      i < pools.length - 1 ? "1px solid #f7f7f9" : "none",
                  }}
                >
                  <AssetIcon pool={p} size={22} />
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
                    {p.symbol}
                  </span>
                  <span style={{ fontSize: 13, color: "#5b5b66" }}>
                    {formatBigAmount(avail > 0n ? avail : 0n)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color:
                        util > 70
                          ? "#dc2626"
                          : util > 50
                            ? "#d97706"
                            : "#059669",
                      fontWeight: 600,
                      background:
                        util > 70
                          ? "#fef2f2"
                          : util > 50
                            ? "#fffbeb"
                            : "#ecfdf5",
                      padding: "2px 7px",
                      borderRadius: 999,
                    }}
                  >
                    {util.toFixed(0)}% used
                  </span>
                </div>
              );
            })}
          </div>

          <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>
              New flash loan
            </div>
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#5b5b66",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Asset
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {pools.map((p, i) => (
                  <button
                    key={p.poolAddress.toBase58()}
                    onClick={() => setSelectedIdx(i)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 999,
                      border: "1px solid",
                      borderColor: selectedIdx === i ? "#6d28d9" : "#e7e7ec",
                      background: selectedIdx === i ? "#ede9fe" : "white",
                      color: selectedIdx === i ? "#4c1d95" : "#5b5b66",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      transition: "all .15s",
                    }}
                  >
                    {p.symbol}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#5b5b66",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Amount
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "#f4f4f6",
                  border: "1px solid #e7e7ec",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  style={{
                    flex: 1,
                    background: "none",
                    border: "none",
                    outline: "none",
                    fontSize: 20,
                    fontWeight: 600,
                    color: "#0b0b10",
                    width: 0,
                  }}
                />
                <span
                  style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}
                >
                  {pool?.symbol ?? "—"}
                </span>
              </div>
              {pool && (
                <div style={{ fontSize: 11.5, color: "#5b5b66", marginTop: 4 }}>
                  Available:{" "}
                  {formatBigAmount(
                    pool.totalDeposits - pool.totalBorrows > 0n
                      ? pool.totalDeposits - pool.totalBorrows
                      : 0n,
                  )}{" "}
                  · Fee:{" "}
                  {amount ? (parseFloat(amount) * feeRate).toFixed(4) : 0}{" "}
                  {pool.symbol}
                </div>
              )}
            </div>
            {pool && (
              <div style={{ marginBottom: 14 }}>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "#5b5b66",
                    fontWeight: 500,
                    marginBottom: 6,
                  }}
                >
                  Repayment instruction
                </div>
                <div
                  style={{
                    background: "#0b0b10",
                    borderRadius: 12,
                    padding: "12px 14px",
                    fontFamily: "var(--font-mono),monospace",
                    fontSize: 11.5,
                    lineHeight: 1.8,
                  }}
                >
                  <span style={{ color: "#9ca3af" }}>
                    {"// append to your transaction"}
                  </span>
                  <br />
                  <span style={{ color: "#a78bfa" }}>flash_borrow</span>
                  <span style={{ color: "#e5e7eb" }}>(</span>
                  <span style={{ color: "#6ee7b7" }}>
                    {pool.symbol.toLowerCase()}
                  </span>
                  <span style={{ color: "#e5e7eb" }}>, amount);</span>
                  <br />
                  <span style={{ color: "#9ca3af" }}>
                    {"// ... your instructions ..."}
                  </span>
                  <br />
                  <span style={{ color: "#a78bfa" }}>flash_repay</span>
                  <span style={{ color: "#e5e7eb" }}>
                    (loan_id, amount + fee);
                  </span>
                </div>
              </div>
            )}
            <div
              style={{
                borderTop: "1px solid #f0f0f3",
                paddingTop: 12,
                marginBottom: 14,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {[
                {
                  k: "Borrow amount",
                  v: amount && pool ? `${amount} ${pool.symbol}` : "—",
                },
                {
                  k: `Fee (${(feeRate * 100).toFixed(2)}%)`,
                  v:
                    amount && pool
                      ? `${(parseFloat(amount) * feeRate).toFixed(4)} ${pool.symbol}`
                      : "—",
                },
                {
                  k: "Repayment due",
                  v:
                    amount && pool
                      ? `${(parseFloat(amount) * (1 + feeRate)).toFixed(4)} ${pool.symbol}`
                      : "—",
                },
              ].map((r, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: "#5b5b66" }}>{r.k}</span>
                  <span style={{ fontWeight: 600 }}>{r.v}</span>
                </div>
              ))}
            </div>
            {fhe ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    background: "linear-gradient(135deg,#ede9fe,#fdf2ff)",
                    border: "1px solid #c4b5fd",
                    borderRadius: 10,
                    padding: "10px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    fill="#6d28d9"
                  >
                    <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
                  </svg>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "#4c1d95",
                      fontWeight: 500,
                    }}
                  >
                    Private flash loans via FHE are coming soon.
                  </span>
                </div>
                <button
                  disabled
                  style={{
                    width: "100%",
                    padding: "11px",
                    borderRadius: 12,
                    background: "linear-gradient(135deg,#6d28d9,#9333ea)",
                    color: "rgba(255,255,255,.6)",
                    border: "none",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "not-allowed",
                    letterSpacing: "-0.01em",
                    opacity: 0.6,
                  }}
                >
                  Coming Soon
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {status === "success" && txSig && (
                  <div
                    style={{
                      background: "#ecfdf5",
                      border: "1px solid #a7f3d0",
                      borderRadius: 10,
                      padding: "9px 12px",
                      fontSize: 12,
                      color: "#065f46",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>
                      Transaction confirmed
                    </span>
                    <a
                      href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: "#059669",
                        fontWeight: 600,
                        textDecoration: "none",
                        fontFamily: "var(--font-mono),monospace",
                        fontSize: 11,
                      }}
                    >
                      {txSig.slice(0, 8)}…{txSig.slice(-6)} ↗
                    </a>
                  </div>
                )}
                {status === "error" && errorMsg && (
                  <div
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fca5a5",
                      borderRadius: 10,
                      padding: "9px 12px",
                      fontSize: 12,
                      color: "#991b1b",
                    }}
                  >
                    {errorMsg}
                  </div>
                )}
                <button
                  disabled={
                    !connected ||
                    !amount ||
                    !pool ||
                    ["building", "signing", "confirming"].includes(status)
                  }
                  onClick={() => {
                    if (pool) {
                      reset();
                      flashExecute(
                        pool,
                        BigInt(Math.round(parseFloat(amount || "0") * 1e9)),
                      );
                    }
                  }}
                  style={{
                    width: "100%",
                    padding: "11px",
                    borderRadius: 12,
                    background: connected && amount ? "#0b0b10" : "#e7e7ec",
                    color: connected && amount ? "white" : "#9ca3af",
                    border: "none",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: connected && amount ? "pointer" : "not-allowed",
                    letterSpacing: "-0.01em",
                    transition: "all .2s",
                  }}
                >
                  {!connected
                    ? "Connect wallet to continue"
                    : status === "building"
                      ? "Building transaction…"
                      : status === "signing"
                        ? "Approve in wallet…"
                        : status === "confirming"
                          ? "Confirming…"
                          : "Execute flash loan"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* API Reference */}
      <div className="glass-card" style={{ borderRadius: 18, padding: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700 }}>API Reference</div>
        </div>
        <div style={{ fontSize: 13, color: "#5b5b66", marginBottom: 18 }}>
          REST + JSON · Flash loan endpoints for programmatic access
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {API_ENDPOINTS.map((ep, i) => {
            const open = openEndpoint === i;
            return (
              <div
                key={i}
                style={{
                  border: "1px solid #f0f0f3",
                  borderRadius: 12,
                  overflow: "hidden",
                  transition: "box-shadow .15s",
                  boxShadow: open
                    ? "0 4px 16px -4px rgba(109,40,217,.1)"
                    : "none",
                }}
              >
                <div
                  onClick={() => setOpenEndpoint(open ? null : i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    cursor: "pointer",
                    background: open ? "#fafafc" : "transparent",
                    userSelect: "none",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono),monospace",
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: METHOD_COLOR[ep.method] ?? "#0b0b10",
                      background: (METHOD_COLOR[ep.method] ?? "#0b0b10") + "18",
                      padding: "2px 8px",
                      borderRadius: 6,
                      flexShrink: 0,
                      minWidth: 44,
                      textAlign: "center" as const,
                    }}
                  >
                    {ep.method}
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 13, fontWeight: 500, flex: 1 }}
                  >
                    {ep.path}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: "#9ca3af",
                      flex: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ep.desc}
                  </span>
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="#9ca3af"
                    strokeWidth="2"
                    strokeLinecap="round"
                    style={{
                      transform: open ? "rotate(180deg)" : "none",
                      transition: "transform .2s",
                      flexShrink: 0,
                    }}
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </div>
                {open && (
                  <div
                    style={{
                      padding: "12px 16px",
                      borderTop: "1px solid #f0f0f3",
                      background: "#fafafc",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        color: "#5b5b66",
                        marginBottom: ep.params.length ? 12 : 0,
                        lineHeight: 1.6,
                      }}
                    >
                      {ep.desc}
                    </div>
                    {ep.params.length > 0 && (
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: ".06em",
                            textTransform: "uppercase" as const,
                            color: "#9ca3af",
                            marginBottom: 8,
                          }}
                        >
                          Parameters
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {ep.params.map((p, j) => (
                            <div
                              key={j}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "120px 70px 1fr",
                                gap: 10,
                                alignItems: "start",
                                fontSize: 13,
                              }}
                            >
                              <span
                                className="mono"
                                style={{ fontWeight: 600, color: "#0b0b10" }}
                              >
                                {p.n}
                              </span>
                              <span
                                style={{
                                  color: "#6d28d9",
                                  fontFamily: "var(--font-mono),monospace",
                                  fontSize: 11.5,
                                }}
                              >
                                {p.t}
                              </span>
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
  {
    id: "create",
    label: "Create dWallet",
    desc: "Run 2PC-MPC distributed key generation via the Ika network",
  },
  {
    id: "transfer",
    label: "Transfer authority",
    desc: "Hand dWallet control to Veil's CPI authority PDA",
  },
  {
    id: "register",
    label: "Register collateral",
    desc: "Create an IkaDwalletPosition on Veil and unlock borrowing",
  },
  { id: "done", label: "Ready", desc: "Your cross-chain collateral is live" },
];

function IkaStepIcon({
  step,
  current,
  done,
}: {
  step: IkaStep;
  current: IkaStep;
  done: boolean;
}) {
  const steps = IKA_STEPS.map((s) => s.id);
  const idx = steps.indexOf(step);
  const curIdx = steps.indexOf(current);
  const isActive = step === current;
  const isPast = done || idx < curIdx;
  const bg = isPast ? "#059669" : isActive ? "#6d28d9" : "#f0f0f3";
  const color = isPast || isActive ? "white" : "#9ca3af";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          background: bg,
          color,
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
          transition: "background .25s",
        }}
      >
        {isPast ? "✓" : idx + 1}
      </div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: isActive ? 700 : 500,
          color: isActive ? "#0b0b10" : isPast ? "#5b5b66" : "#9ca3af",
        }}
      >
        {IKA_STEPS[idx].label}
      </div>
    </div>
  );
}

function IkaSetupModal({
  pool,
  setModal,
}: {
  pool: PoolView;
  setModal: (m: ModalState | null) => void;
}) {
  const { publicKey, sendTransaction } = useWallet();
  const [step, setStep] = useState<IkaStep>("create");
  const [dwalletAddr, setDwalletAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [txSig, setTxSig] = useState("");
  const isDone = step === "done";
  const accentBg = "linear-gradient(135deg,#f97316,#eab308)";
  const ltv = wadToPctNum(pool.ltvWad);
  const liqTh = wadToPctNum(pool.liquidationThresholdWad);

  async function handleCreate() {
    if (!publicKey) return;
    setBusy(true);
    setErr("");
    try {
      await new Promise((r) => setTimeout(r, 2000));
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
    setBusy(true);
    setErr("");
    try {
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
    setBusy(true);
    setErr("");
    try {
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
        <div
          style={{
            fontSize: 13,
            color: "#5b5b66",
            lineHeight: 1.7,
            marginBottom: 16,
          }}
        >
          A <strong>dWallet</strong> is a 2PC-MPC key controlled jointly by you
          and the Ika MPC network. Your {pool.symbol} stays on its native chain;
          only Veil&apos;s CPI authority can approve signatures.
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {[
            {
              icon: "🔑",
              t: "Distributed key generation",
              d: "DKG runs over gRPC with the Ika pre-alpha network",
            },
            {
              icon: "🔒",
              t: "No custody risk",
              d: "Neither Veil nor Ika can move funds unilaterally",
            },
            {
              icon: "⚡",
              t: "Native asset collateral",
              d: `Your ${pool.symbol} never leaves its chain`,
            },
          ].map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 10,
                padding: "10px 12px",
                background: "#f9f9fb",
                borderRadius: 10,
                border: "1px solid #f0f0f3",
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{r.icon}</span>
              <div>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "#0b0b10",
                    marginBottom: 2,
                  }}
                >
                  {r.t}
                </div>
                <div style={{ fontSize: 11.5, color: "#5b5b66" }}>{r.d}</div>
              </div>
            </div>
          ))}
        </div>
        <button
          disabled={busy || !publicKey}
          onClick={handleCreate}
          style={{
            width: "100%",
            padding: "11px",
            borderRadius: 12,
            background: publicKey ? accentBg : "#e7e7ec",
            color: publicKey ? "white" : "#9ca3af",
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            cursor: publicKey ? "pointer" : "not-allowed",
          }}
        >
          {busy
            ? "Running DKG…"
            : !publicKey
              ? "Connect wallet first"
              : "Create dWallet"}
        </button>
      </div>
    ),
    transfer: (
      <div>
        <div
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 14,
            fontSize: 12.5,
            color: "#065f46",
            display: "flex",
            gap: 8,
          }}
        >
          <span>✓</span>
          <div>
            <div style={{ fontWeight: 600 }}>dWallet created</div>
            <div
              style={{
                fontFamily: "var(--font-mono),monospace",
                fontSize: 11.5,
                marginTop: 2,
                color: "#059669",
              }}
            >
              {dwalletAddr}
            </div>
          </div>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#5b5b66",
            lineHeight: 1.7,
            marginBottom: 16,
          }}
        >
          Transfer the dWallet&apos;s authority to{" "}
          <strong>Veil&apos;s CPI authority PDA</strong>.
        </div>
        <button
          disabled={busy}
          onClick={handleTransfer}
          style={{
            width: "100%",
            padding: "11px",
            borderRadius: 12,
            background: accentBg,
            color: "white",
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {busy ? "Signing transaction…" : "Transfer authority"}
        </button>
      </div>
    ),
    register: (
      <div>
        <div
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 14,
            fontSize: 12.5,
            color: "#065f46",
          }}
        >
          ✓ Authority transferred to Veil CPI PDA
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#5b5b66",
            lineHeight: 1.7,
            marginBottom: 16,
          }}
        >
          Register the dWallet as collateral on Veil.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 16,
          }}
        >
          {[
            { k: "Collateral", v: `${pool.symbol} (native)` },
            { k: "Max LTV", v: `${ltv}%` },
            { k: "Liq. at", v: `${liqTh}%` },
            { k: "Curve", v: "secp256k1" },
          ].map((r, i) => (
            <div
              key={i}
              style={{
                background: "#f9f9fb",
                borderRadius: 8,
                padding: "8px 10px",
                border: "1px solid #f0f0f3",
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  color: "#9ca3af",
                  fontWeight: 500,
                  marginBottom: 2,
                }}
              >
                {r.k}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.v}</div>
            </div>
          ))}
        </div>
        <button
          disabled={busy}
          onClick={handleRegister}
          style={{
            width: "100%",
            padding: "11px",
            borderRadius: 12,
            background: accentBg,
            color: "white",
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {busy ? "Registering…" : `Register ${pool.symbol} collateral`}
        </button>
      </div>
    ),
    done: (
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 999,
            background: "#ecfdf5",
            border: "2px solid #a7f3d0",
            display: "grid",
            placeItems: "center",
            margin: "0 auto 14px",
            fontSize: 22,
          }}
        >
          ✓
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
          Collateral registered!
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#5b5b66",
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          Your {pool.symbol} dWallet is live as cross-chain collateral.
        </div>
        {txSig && (
          <div
            style={{
              background: "#ecfdf5",
              border: "1px solid #a7f3d0",
              borderRadius: 10,
              padding: "9px 12px",
              fontSize: 12,
              color: "#065f46",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontWeight: 500 }}>IkaRegister confirmed</span>
            <span
              style={{
                fontFamily: "var(--font-mono),monospace",
                fontSize: 11,
                color: "#059669",
              }}
            >
              {txSig} ↗
            </span>
          </div>
        )}
        <button
          onClick={() => setModal(null)}
          style={{
            width: "100%",
            padding: "11px",
            borderRadius: 12,
            background: "#0b0b10",
            color: "white",
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Done — go to Markets
        </button>
      </div>
    ),
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setModal(null);
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 20,
          padding: 24,
          width: "100%",
          maxWidth: 420,
          boxShadow:
            "0 30px 60px -12px rgba(76,29,149,.2),0 12px 30px -8px rgba(10,10,20,.15)",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AssetIcon pool={pool} size={36} />
            <div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                Register {pool.symbol} Collateral
              </div>
              <Tag type={getPoolType(pool.symbol)} />
            </div>
          </div>
          <button
            onClick={() => setModal(null)}
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              border: "1px solid #e7e7ec",
              background: "#f4f4f6",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              fontSize: 14,
              color: "#5b5b66",
            }}
          >
            ✕
          </button>
        </div>
        {!isDone && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "12px 14px",
              background: "#f9f9fb",
              borderRadius: 12,
              marginBottom: 18,
              border: "1px solid #f0f0f3",
            }}
          >
            {IKA_STEPS.filter((s) => s.id !== "done").map((s) => (
              <IkaStepIcon
                key={s.id}
                step={s.id}
                current={step}
                done={isDone}
              />
            ))}
          </div>
        )}
        {err && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: 10,
              padding: "9px 12px",
              fontSize: 12,
              color: "#991b1b",
              marginBottom: 12,
            }}
          >
            {err}
          </div>
        )}
        {stepContent[step]}
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function InfoRow({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
    >
      <span style={{ color: "#5b5b66" }}>{k}</span>
      <span style={{ fontWeight: 600, color: vc ?? "#0b0b10" }}>{v}</span>
    </div>
  );
}

function Modal({
  modal,
  setModal,
  fhe,
}: {
  modal: ModalState;
  setModal: (m: ModalState | null) => void;
  fhe: boolean;
}) {
  const { type, pool } = modal;
  const poolType = getPoolType(pool.symbol);
  const [amount, setAmount] = useState("");
  const [encPos, setEncPos] = useState(fhe && poolType === "enc");
  const [chain, setChain] = useState(poolType === "ika" ? "ika" : "solana");
  const { deposit, withdraw, borrow, repay, status, txSig, errorMsg, reset } =
    useVeilActions();

  const isPrivate = encPos;
  const isSupply = type === "supply" || type === "withdraw";
  const isBorrow = type === "borrow" || type === "repay";
  const title = {
    supply: `Supply ${pool.symbol}`,
    borrow: `Borrow ${pool.symbol}`,
    withdraw: `Withdraw ${pool.symbol}`,
    repay: `Repay ${pool.symbol}`,
    "ika-setup": `Register ${pool.symbol}`,
  }[type];

  const btnBg =
    poolType === "ika"
      ? "linear-gradient(135deg,#f97316,#eab308)"
      : poolType === "enc"
        ? "linear-gradient(135deg,#6d28d9,#9333ea)"
        : poolType === "oro"
          ? "linear-gradient(135deg,#eab308,#ca8a04)"
          : "#0b0b10";

  function handleConfirm() {
    if (!amount) return;
    reset();
    const lamports = BigInt(Math.round(parseFloat(amount) * 1e9));
    if (type === "supply") deposit(pool, lamports);
    else if (type === "withdraw") withdraw(pool, lamports);
    else if (type === "borrow") borrow(pool, lamports);
    else if (type === "repay") repay(pool, lamports);
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setModal(null);
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 20,
          padding: 24,
          width: "100%",
          maxWidth: 380,
          boxShadow:
            "0 30px 60px -12px rgba(76,29,149,.2),0 12px 30px -8px rgba(10,10,20,.15)",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              {title}
            </div>
            <Tag type={poolType} />
          </div>
          <button
            onClick={() => setModal(null)}
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              border: "1px solid #e7e7ec",
              background: "#f4f4f6",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              fontSize: 14,
              color: "#5b5b66",
            }}
          >
            ✕
          </button>
        </div>

        {poolType === "ika" && (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 11.5,
                color: "#5b5b66",
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              Collateral chain
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { id: "solana", label: "Solana" },
                { id: "ika", label: `${pool.symbol} (Ika)` },
              ].map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChain(c.id)}
                  style={{
                    flex: 1,
                    padding: "7px",
                    borderRadius: 10,
                    border: "1px solid",
                    borderColor: chain === c.id ? "#059669" : "#e7e7ec",
                    background: chain === c.id ? "#ecfdf5" : "white",
                    color: chain === c.id ? "#065f46" : "#5b5b66",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all .15s",
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          style={{
            background: "#f4f4f6",
            border: "1px solid #e7e7ec",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            padding: "10px 14px",
            marginBottom: 6,
          }}
        >
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            style={{
              background: "none",
              border: "none",
              outline: "none",
              fontSize: 22,
              fontWeight: 600,
              flex: 1,
              color: "#0b0b10",
              width: 0,
            }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#5b5b66" }}>
            {pool.symbol}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "#5b5b66", marginBottom: 14 }}>
          Amount in base units (lamports) · {isSupply ? "Deposit" : "Borrow"}{" "}
          into {pool.symbol} pool
        </div>

        {(type === "supply" || type === "borrow") && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              background: encPos ? "#ede9fe" : "#f4f4f6",
              borderRadius: 10,
              marginBottom: 14,
              cursor: "pointer",
              border: "1px solid",
              borderColor: encPos ? "#c4b5fd" : "#e7e7ec",
              transition: "all .2s",
            }}
            onClick={() => setEncPos((v) => !v)}
          >
            <div className={`toggle-track ${encPos ? "on" : ""}`}>
              <div className="toggle-thumb" />
            </div>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: encPos ? "#4c1d95" : "#5b5b66",
              }}
            >
              Encrypt position (FHE)
            </span>
            {encPos && (
              <svg viewBox="0 0 16 16" width="12" height="12" fill="#6d28d9">
                <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
              </svg>
            )}
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid #f0f0f3",
            paddingTop: 12,
            marginBottom: 14,
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          {isSupply && (
            <>
              <InfoRow k="Max LTV" v={wadToPctStr(pool.ltvWad)} />
              <InfoRow
                k="Supply APY"
                v={`+${poolSupplyApy(pool).toFixed(1)}%`}
                vc="#059669"
              />
              {poolType === "ika" && (
                <InfoRow k="dWallet required" v="Yes — Ika" vc="#059669" />
              )}
              {poolType === "oro" && (
                <InfoRow k="Custody" v="Oro / GRAIL" vc="#d97706" />
              )}
            </>
          )}
          {isBorrow && (
            <>
              <InfoRow
                k="Borrow APY"
                v={`${poolBorrowApy(pool).toFixed(1)}%`}
                vc="#dc2626"
              />
              <InfoRow
                k="Liq. threshold"
                v={wadToPctStr(pool.liquidationThresholdWad)}
              />
              <InfoRow
                k="Liq. bonus"
                v={wadToPctStr(pool.liquidationBonusWad)}
              />
            </>
          )}
        </div>

        {encPos && (
          <div
            style={{
              background: "#ede9fe",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 12,
              color: "#4c1d95",
              marginBottom: 14,
              lineHeight: 1.6,
            }}
          >
            Position will be FHE-encrypted. Balances and borrow amounts stored
            as ciphertext on-chain via Encrypt · REFHE.
          </div>
        )}

        {status === "success" && txSig && (
          <div
            style={{
              background: "#ecfdf5",
              border: "1px solid #a7f3d0",
              borderRadius: 10,
              padding: "9px 12px",
              fontSize: 12,
              color: "#065f46",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontWeight: 500 }}>Transaction confirmed</span>
            <a
              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              style={{
                color: "#059669",
                fontWeight: 600,
                textDecoration: "none",
                fontFamily: "var(--font-mono),monospace",
                fontSize: 11,
              }}
            >
              {txSig.slice(0, 8)}…{txSig.slice(-6)} ↗
            </a>
          </div>
        )}
        {status === "error" && errorMsg && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: 10,
              padding: "9px 12px",
              fontSize: 12,
              color: "#991b1b",
              marginBottom: 12,
            }}
          >
            {errorMsg}
          </div>
        )}

        {isPrivate ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                background: "linear-gradient(135deg,#ede9fe,#fdf2ff)",
                border: "1px solid #c4b5fd",
                borderRadius: 10,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="#6d28d9">
                <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
              </svg>
              <span
                style={{ fontSize: 12.5, color: "#4c1d95", fontWeight: 500 }}
              >
                FHE private operations are coming soon.
              </span>
            </div>
            <button
              disabled
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 12,
                background: "linear-gradient(135deg,#6d28d9,#9333ea)",
                color: "rgba(255,255,255,.6)",
                border: "none",
                fontSize: 14,
                fontWeight: 700,
                cursor: "not-allowed",
                letterSpacing: "-0.01em",
                opacity: 0.65,
              }}
            >
              Coming Soon
            </button>
          </div>
        ) : (
          <button
            disabled={
              !amount || ["building", "signing", "confirming"].includes(status)
            }
            onClick={handleConfirm}
            style={{
              width: "100%",
              padding: "11px",
              borderRadius: 12,
              background: amount ? btnBg : "#e7e7ec",
              color: amount ? "white" : "#9ca3af",
              border: "none",
              fontSize: 14,
              fontWeight: 700,
              cursor: amount ? "pointer" : "not-allowed",
              letterSpacing: "-0.01em",
              transition: "all .2s",
            }}
          >
            {status === "building"
              ? "Building transaction…"
              : status === "signing"
                ? "Approve in wallet…"
                : status === "confirming"
                  ? "Confirming…"
                  : type === "supply"
                    ? `Supply${poolType === "ika" ? " via Ika dWallet" : ""}`
                    : type === "borrow"
                      ? `Borrow ${pool.symbol}`
                      : type === "withdraw"
                        ? `Withdraw ${pool.symbol}`
                        : `Repay ${pool.symbol}`}
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
  const {
    pools,
    loading: poolsLoading,
    error: poolsError,
    refresh: refreshPools,
  } = usePools();

  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("veil_view") as View) ?? "markets";
    }
    return "markets";
  });
  const [fhe, setFhe] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);

  // Fetch user positions from the API
  const [positions, setPositions] = useState<PositionRow[]>([]);
  useEffect(() => {
    if (!publicKey) {
      setPositions([]);
      return;
    }
    fetch(`/api/positions/${encodeURIComponent(publicKey.toBase58())}`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((d: { positions: PositionRow[] }) =>
        setPositions(d.positions ?? []),
      )
      .catch(() => setPositions([]));
  }, [publicKey]);

  useEffect(() => {
    localStorage.setItem("veil_view", view);
  }, [view]);

  return (
    <div
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}
    >
      <div
        aria-hidden
        style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
        className="page-bg"
      />
      <div
        aria-hidden
        className="grid-bg"
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          opacity: 0.5,
        }}
      />
      <AppNav view={view} setView={setView} fhe={fhe} setFhe={setFhe} />
      <main style={{ flex: 1, paddingTop: 20, position: "relative" }}>
        {view === "markets" && (
          <MarketsView
            fhe={fhe}
            connected={connected}
            setModal={setModal}
            pools={pools}
            poolsLoading={poolsLoading}
            poolsError={poolsError}
            refreshPools={refreshPools}
            positions={positions}
          />
        )}
        {view === "portfolio" && (
          <PortfolioView
            fhe={fhe}
            connected={connected}
            setModal={setModal}
            pools={pools}
            positions={positions}
          />
        )}
        {view === "flash" && (
          <FlashView connected={connected} fhe={fhe} pools={pools} />
        )}
      </main>
      {modal && modal.type === "ika-setup" ? (
        <IkaSetupModal pool={modal.pool} setModal={setModal} />
      ) : (
        modal && <Modal modal={modal} setModal={setModal} fhe={fhe} />
      )}
    </div>
  );
}
