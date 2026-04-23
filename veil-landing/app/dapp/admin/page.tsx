"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletButton as WalletMultiButton } from "@/app/components/WalletButton";
import { PublicKey, Transaction } from "@solana/web3.js";
import Link from "next/link";
import {
  updatePoolIx,
  pausePoolIx,
  resumePoolIx,
  collectFeesIx,
  type UpdatePoolParams,
} from "@/lib/veil/instructions";
import { findPoolAddress, findPoolAuthorityAddress, findVaultAddress } from "@/lib/veil/pda";
import { WAD } from "@/lib/veil/constants";
import { useAdminRole } from "./hooks/useAdminRole";
import { InitPoolPanel } from "./components/InitPoolPanel";
import { AllowlistPanel } from "./components/AllowlistPanel";
import { AuditLogPanel } from "./components/AuditLogPanel";

// ─── Pool Mints (devnet) ──────────────────────────────────────────────────────

const POOL_MINTS: Record<string, string> = {
  sol:  process.env.NEXT_PUBLIC_SOL_MINT  ?? "So11111111111111111111111111111111111111112",
  btc:  process.env.NEXT_PUBLIC_BTC_MINT  ?? "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  eth:  process.env.NEXT_PUBLIC_ETH_MINT  ?? "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  xau:  process.env.NEXT_PUBLIC_XAU_MINT  ?? "FAksmWHtMiJBUHBVJTExKmGrHo8RNZBcEJuPpvHPG3wy",
  usdc: process.env.NEXT_PUBLIC_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ─── WAD conversion helpers ───────────────────────────────────────────────────

function percentToWad(pct: string): bigint {
  const cleaned = (pct || "0").trim().replace(/[^0-9.]/g, "");
  const [intStr, decStr = ""] = cleaned.split(".");
  const dec2 = decStr.padEnd(2, "0").slice(0, 2);
  const totalCentiPercent = BigInt(intStr || "0") * 100n + BigInt(dec2 || "0");
  return totalCentiPercent * (WAD / 10000n);
}

// ─── Pool definitions ─────────────────────────────────────────────────────────

interface AdminPool {
  id: string;
  symbol: string;
  icon: string;
  color: string;
  accumulatedFees: string;
  paused: boolean;
  defaults: FormState;
}

interface FormState {
  ltv: string;
  liqThreshold: string;
  liqBonus: string;
  protocolLiqFee: string;
  reserveFactor: string;
  closeFactor: string;
  baseRate: string;
  optimalUtil: string;
  slope1: string;
  slope2: string;
  flashFeeBps: string;
}

const ADMIN_POOLS: AdminPool[] = [
  { id: "sol", symbol: "SOL", icon: "◎", color: "#7c3aed", accumulatedFees: "$1,240", paused: false,
    defaults: { ltv: "68", liqThreshold: "73", liqBonus: "7.50", protocolLiqFee: "1.00", reserveFactor: "10", closeFactor: "50", baseRate: "2", optimalUtil: "80", slope1: "8", slope2: "100", flashFeeBps: "9" } },
  { id: "btc", symbol: "BTC", icon: "₿", color: "#f97316", accumulatedFees: "$3,810", paused: false,
    defaults: { ltv: "73", liqThreshold: "78", liqBonus: "5.50", protocolLiqFee: "1.00", reserveFactor: "10", closeFactor: "50", baseRate: "1", optimalUtil: "75", slope1: "6", slope2: "80", flashFeeBps: "9" } },
  { id: "eth", symbol: "ETH", icon: "Ξ", color: "#6366f1", accumulatedFees: "$620", paused: false,
    defaults: { ltv: "75", liqThreshold: "80", liqBonus: "5.00", protocolLiqFee: "1.00", reserveFactor: "10", closeFactor: "50", baseRate: "1", optimalUtil: "80", slope1: "7", slope2: "90", flashFeeBps: "9" } },
  { id: "xau", symbol: "XAU", icon: "◈", color: "#ca8a04", accumulatedFees: "$290", paused: false,
    defaults: { ltv: "60", liqThreshold: "65", liqBonus: "7.50", protocolLiqFee: "1.00", reserveFactor: "15", closeFactor: "50", baseRate: "1", optimalUtil: "70", slope1: "5", slope2: "60", flashFeeBps: "9" } },
  { id: "usdc", symbol: "USDC", icon: "$", color: "#2563eb", accumulatedFees: "$4,100", paused: false,
    defaults: { ltv: "85", liqThreshold: "88", liqBonus: "4.50", protocolLiqFee: "0.50", reserveFactor: "5", closeFactor: "50", baseRate: "0", optimalUtil: "90", slope1: "6", slope2: "60", flashFeeBps: "9" } },
];

type TxStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";
type Tab = "pools" | "init" | "allowlist" | "audit";

// ─── Param row ────────────────────────────────────────────────────────────────

function ParamRow({ label, value, onChange, unit = "%", hint }: { label: string; value: string; onChange: (v: string) => void; unit?: string; hint?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 36px", gap: 8, alignItems: "center" }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: "#374151" }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{hint}</div>}
      </div>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)}
        style={{ textAlign: "right", background: "#f9f9fb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#0b0b10", outline: "none", fontFamily: "var(--font-mono),monospace", width: "100%" }}/>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textAlign: "left" }}>{unit}</div>
    </div>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase" as const, color: "#9ca3af", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #f3f4f6" }}>
      {label}
    </div>
  );
}

function TxBanner({ status, sig, error, onReset }: { status: TxStatus; sig?: string; error?: string; onReset: () => void }) {
  if (status === "idle") return null;
  const pending = ["building", "signing", "confirming"].includes(status);
  const label = status === "building" ? "Building transaction…" : status === "signing" ? "Approve in wallet…" : status === "confirming" ? "Confirming on-chain…" : status === "success" ? "Transaction confirmed" : "Transaction failed";
  const bg = status === "success" ? "#f0fdf4" : status === "error" ? "#fef2f2" : "#eff6ff";
  const border = status === "success" ? "#bbf7d0" : status === "error" ? "#fecaca" : "#bfdbfe";
  const color = status === "success" ? "#166534" : status === "error" ? "#991b1b" : "#1e40af";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
      {pending && (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" opacity=".25" /><path d="M12 2a10 10 0 0 1 10 10" />
        </svg>
      )}
      <span style={{ fontSize: 12.5, fontWeight: 500, color, flex: 1 }}>{label}{status === "error" && error && ` — ${error}`}</span>
      {status === "success" && sig && (
        <a href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`} target="_blank" rel="noreferrer"
          style={{ fontSize: 11, color: "#059669", fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-mono),monospace", flexShrink: 0 }}>
          {sig.slice(0, 8)}…{sig.slice(-6)} ↗
        </a>
      )}
      {!pending && (
        <button onClick={onReset} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>✕</button>
      )}
    </div>
  );
}

// ─── Pool Edit Panel ──────────────────────────────────────────────────────────

function PoolPanel({ pool, onPausedChange }: { pool: AdminPool; onPausedChange: (id: string, paused: boolean) => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [form, setForm] = useState<FormState>({ ...pool.defaults });
  const [treasury, setTreasury] = useState("");

  const [pauseStatus, setPauseStatus] = useState<TxStatus>("idle");
  const [pauseSig, setPauseSig] = useState<string | undefined>();
  const [pauseErr, setPauseErr] = useState<string | undefined>();

  const [updateStatus, setUpdateStatus] = useState<TxStatus>("idle");
  const [updateSig, setUpdateSig] = useState<string | undefined>();
  const [updateErr, setUpdateErr] = useState<string | undefined>();

  const [feesStatus, setFeesStatus] = useState<TxStatus>("idle");
  const [feesSig, setFeesSig] = useState<string | undefined>();
  const [feesErr, setFeesErr] = useState<string | undefined>();

  const field = (key: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  function validateForm(): string | null {
    const ltv = parseFloat(form.ltv);
    const liqTh = parseFloat(form.liqThreshold);
    if (isNaN(ltv) || isNaN(liqTh)) return "LTV and Liquidation Threshold must be numbers";
    if (ltv >= liqTh) return "LTV must be strictly less than Liquidation Threshold";
    if (liqTh >= 100) return "Liquidation Threshold must be less than 100%";
    const rf = parseFloat(form.reserveFactor);
    if (rf < 0 || rf >= 100) return "Reserve Factor must be between 0 and 100%";
    const cf = parseFloat(form.closeFactor);
    if (cf < 0 || cf > 100) return "Close Factor must be between 0 and 100%";
    const bps = parseInt(form.flashFeeBps);
    if (isNaN(bps) || bps < 0 || bps > 10000) return "Flash fee must be 0–10000 bps";
    return null;
  }

  const sendTx = useCallback(async (
    buildIx: (pool: PublicKey) => ReturnType<typeof pausePoolIx>,
    setStatus: (s: TxStatus) => void,
    setSig: (s: string) => void,
    setErr: (e: string) => void,
    action: string,
  ) => {
    if (!publicKey) return;
    setStatus("building");
    try {
      const mintKey = new PublicKey(POOL_MINTS[pool.id]);
      const [poolPda] = findPoolAddress(mintKey);
      const ix = buildIx(poolPda);

      const tx = new Transaction();
      tx.add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      setStatus("signing");
      const sig = await sendTransaction(tx, connection);
      setStatus("confirming");
      await connection.confirmTransaction(sig, "confirmed");
      setSig(sig);
      setStatus("success");

      void fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signature: sig, wallet: publicKey.toBase58(), action,
          pool_address: poolPda.toBase58(), status: "confirmed",
        }),
      });
      void fetch("/api/pools/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool_address: poolPda.toBase58(), symbol: pool.symbol }),
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [publicKey, connection, sendTransaction, pool.id, pool.symbol]);

  async function handlePause() {
    setPauseStatus("idle"); setPauseSig(undefined); setPauseErr(undefined);
    const isPaused = pool.paused;
    await sendTx(
      (poolPda) => isPaused ? resumePoolIx(publicKey!, poolPda) : pausePoolIx(publicKey!, poolPda),
      setPauseStatus, setPauseSig, setPauseErr, isPaused ? "resume" : "pause",
    );
    onPausedChange(pool.id, !isPaused);
  }

  async function handleUpdate() {
    const err = validateForm();
    if (err) { setUpdateStatus("error"); setUpdateErr(err); return; }
    setUpdateStatus("idle"); setUpdateSig(undefined); setUpdateErr(undefined);

    const params: UpdatePoolParams = {
      baseRate: percentToWad(form.baseRate),
      optimalUtilization: percentToWad(form.optimalUtil),
      slope1: percentToWad(form.slope1),
      slope2: percentToWad(form.slope2),
      reserveFactor: percentToWad(form.reserveFactor),
      ltv: percentToWad(form.ltv),
      liquidationThreshold: percentToWad(form.liqThreshold),
      liquidationBonus: percentToWad(form.liqBonus),
      protocolLiqFee: percentToWad(form.protocolLiqFee),
      closeFactor: percentToWad(form.closeFactor),
      flashFeeBps: BigInt(parseInt(form.flashFeeBps || "0")),
    };
    await sendTx((poolPda) => updatePoolIx(publicKey!, poolPda, params),
      setUpdateStatus, setUpdateSig, setUpdateErr, "update_pool");
  }

  async function handleCollect() {
    if (!treasury.trim()) { setFeesStatus("error"); setFeesErr("Enter a treasury token account address"); return; }
    setFeesStatus("idle"); setFeesSig(undefined); setFeesErr(undefined);
    await sendTx((poolPda) => {
      const mintKey = new PublicKey(POOL_MINTS[pool.id]);
      const [poolAuthority] = findPoolAuthorityAddress(poolPda);
      const vault = findVaultAddress(mintKey, poolAuthority);
      const treasuryKey = new PublicKey(treasury.trim());
      return collectFeesIx(publicKey!, poolPda, vault, treasuryKey, poolAuthority);
    }, setFeesStatus, setFeesSig, setFeesErr, "collect_fees");
  }

  const pausing = ["building", "signing", "confirming"].includes(pauseStatus);
  const updating = ["building", "signing", "confirming"].includes(updateStatus);
  const collecting = ["building", "signing", "confirming"].includes(feesStatus);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>{pool.symbol} — Pool Status</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Controls deposit, borrow, and flash loan access</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999,
            background: pool.paused ? "#fef2f2" : "#f0fdf4",
            border: `1px solid ${pool.paused ? "#fecaca" : "#bbf7d0"}`,
            fontSize: 12.5, fontWeight: 700, color: pool.paused ? "#dc2626" : "#059669" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: pool.paused ? "#dc2626" : "#059669" }} />
            {pool.paused ? "Paused" : "Active"}
          </div>
        </div>
        <div style={{ padding: "14px 18px", display: "flex", gap: 10 }}>
          <div style={{ flex: 1, background: "#f9f9fb", borderRadius: 10, padding: "10px 12px", border: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Accumulated fees</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#059669" }}>{pool.accumulatedFees}</div>
          </div>
          <div style={{ flex: 1, background: "#f9f9fb", borderRadius: 10, padding: "10px 12px", border: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 10.5, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>Withdraw/Repay</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Always open</div>
          </div>
        </div>
        <div style={{ padding: "0 18px 16px" }}>
          <button onClick={handlePause} disabled={pausing}
            style={{ width: "100%", padding: "9px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: pausing ? "not-allowed" : "pointer",
              border: `1px solid ${pool.paused ? "#bbf7d0" : "#fecaca"}`,
              background: pool.paused ? "#f0fdf4" : "#fef2f2",
              color: pool.paused ? "#059669" : "#dc2626",
              opacity: pausing ? 0.65 : 1 }}>
            {pausing ? "Processing…" : pool.paused ? "▶  Resume Pool" : "⏸  Pause Pool"}
          </button>
        </div>
        <TxBanner status={pauseStatus} sig={pauseSig} error={pauseErr} onReset={() => setPauseStatus("idle")} />
        {pauseStatus !== "idle" && <div style={{ height: 14 }} />}
      </div>

      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", marginBottom: 16 }}>Update Parameters</div>
        <div style={{ marginBottom: 20 }}>
          <SectionHead label="Risk Parameters" />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <ParamRow label="Max LTV" hint="Must be < Liq. threshold" value={form.ltv} onChange={field("ltv")} />
            <ParamRow label="Liquidation threshold" hint="Must be < 100%" value={form.liqThreshold} onChange={field("liqThreshold")} />
            <ParamRow label="Liquidation bonus" hint="Discount for liquidators" value={form.liqBonus} onChange={field("liqBonus")} />
            <ParamRow label="Protocol liq. fee" hint="Protocol's cut of liq. proceeds" value={form.protocolLiqFee} onChange={field("protocolLiqFee")} />
            <ParamRow label="Reserve factor" hint="Share of interest → treasury" value={form.reserveFactor} onChange={field("reserveFactor")} />
            <ParamRow label="Close factor" hint="Max debt repaid per liquidation" value={form.closeFactor} onChange={field("closeFactor")} />
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <SectionHead label="Interest Rate Model" />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <ParamRow label="Base rate" hint="Minimum borrow rate at 0% util" value={form.baseRate} onChange={field("baseRate")} />
            <ParamRow label="Optimal utilization (kink)" hint="Utilization at which Slope₂ kicks in" value={form.optimalUtil} onChange={field("optimalUtil")} />
            <ParamRow label="Slope₁" hint="Rate increase per 1% util below kink" value={form.slope1} onChange={field("slope1")} />
            <ParamRow label="Slope₂" hint="Steep rate above kink — discourages over-util" value={form.slope2} onChange={field("slope2")} />
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <SectionHead label="Flash Loans" />
          <ParamRow label="Flash fee" hint="1 bps = 0.01%. Max 10000 (100%)" value={form.flashFeeBps} onChange={field("flashFeeBps")} unit="bps" />
        </div>
        <div style={{ padding: "12px 14px", background: "#fffbeb", border: "1px solid #fef08a", borderRadius: 10, fontSize: 12, color: "#854d0e", marginBottom: 14, lineHeight: 1.6 }}>
          <strong>On-chain validation:</strong> LTV &lt; Liq. Threshold &lt; 100% · Reserve factor &lt; 100% · Flash fee ≤ 10000 bps. All WAD-scaled values encoded as u128 LE.
        </div>
        <button onClick={handleUpdate} disabled={updating}
          style={{ width: "100%", padding: "11px", borderRadius: 12, background: updating ? "#e5e7eb" : "#0b0b10", color: updating ? "#9ca3af" : "white", border: "none", fontSize: 14, fontWeight: 700, cursor: updating ? "not-allowed" : "pointer" }}>
          {updating ? (updateStatus === "building" ? "Building transaction…" : updateStatus === "signing" ? "Approve in wallet…" : "Confirming…") : "Apply Changes"}
        </button>
        <TxBanner status={updateStatus} sig={updateSig} error={updateErr} onReset={() => { setUpdateStatus("idle"); setUpdateErr(undefined); }} />
      </div>

      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", marginBottom: 4 }}>Collect Fees</div>
        <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 16 }}>
          Sweep accumulated protocol fees from the pool vault to your treasury token account.
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Treasury token account</div>
          <input value={treasury} onChange={(e) => setTreasury(e.target.value)} placeholder="Enter SPL token account address…"
            style={{ width: "100%", padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, color: "#0b0b10", background: "#f9f9fb", outline: "none", fontFamily: "var(--font-mono),monospace", boxSizing: "border-box" }}/>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
            Must be an ATA for the {pool.symbol} mint owned by your wallet or your Squads vault.
          </div>
        </div>
        <button onClick={handleCollect} disabled={collecting || !treasury.trim()}
          style={{ width: "100%", padding: "10px", borderRadius: 12, background: collecting || !treasury ? "#e5e7eb" : "linear-gradient(135deg,#059669,#10b981)", color: collecting || !treasury ? "#9ca3af" : "white", border: "none", fontSize: 14, fontWeight: 700, cursor: collecting || !treasury ? "not-allowed" : "pointer" }}>
          {collecting ? "Processing…" : "Collect Fees →"}
        </button>
        <TxBanner status={feesStatus} sig={feesSig} error={feesErr} onReset={() => setFeesStatus("idle")} />
      </div>
    </div>
  );
}

// ─── Pools view ───────────────────────────────────────────────────────────────

function PoolsView() {
  const [selectedId, setSelectedId] = useState("sol");
  const [poolState, setPoolState] = useState<AdminPool[]>(ADMIN_POOLS);
  const selectedPool = poolState.find((p) => p.id === selectedId)!;

  function handlePausedChange(id: string, paused: boolean) {
    setPoolState((pools) => pools.map((p) => p.id === id ? { ...p, paused } : p));
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 20, alignItems: "start" }}>
      <div style={{ position: "sticky", top: 20 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase" as const, color: "#9ca3af", marginBottom: 8, paddingLeft: 4 }}>Pools</div>
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
          {poolState.map((p, i) => {
            const isSelected = p.id === selectedId;
            return (
              <div key={p.id} onClick={() => setSelectedId(p.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px",
                  borderBottom: i < poolState.length - 1 ? "1px solid #f3f4f6" : "none",
                  cursor: "pointer", background: isSelected ? "#fafbff" : "transparent",
                  borderLeft: isSelected ? "3px solid #6d28d9" : "3px solid transparent" }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: p.color, display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700, color: "white" }}>{p.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0b0b10" }}>{p.symbol}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: p.paused ? "#dc2626" : "#059669" }}>
                    {p.paused ? "⏸ Paused" : "● Active"}
                  </div>
                </div>
                {isSelected && (
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="#6d28d9" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4" /></svg>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 14, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#1e40af", marginBottom: 6, letterSpacing: ".04em", textTransform: "uppercase" as const }}>Multisig note</div>
          <div style={{ fontSize: 11.5, color: "#1e3a8a", lineHeight: 1.6 }}>
            For mainnet, route all admin transactions through Squads. This UI constructs instructions — signing is handled by your wallet or multisig.
          </div>
        </div>
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: selectedPool.color, display: "grid", placeItems: "center", fontSize: 16, fontWeight: 700, color: "white" }}>{selectedPool.icon}</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#0b0b10" }}>{selectedPool.symbol}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>Pool administrator controls</div>
          </div>
        </div>
        <PoolPanel key={selectedPool.id} pool={selectedPool} onPausedChange={handlePausedChange} />
      </div>
    </div>
  );
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({ tab, setTab, isSuperAdmin }: { tab: Tab; setTab: (t: Tab) => void; isSuperAdmin: boolean }) {
  const tabs: { id: Tab; label: string; visible: boolean }[] = [
    { id: "pools", label: "Manage Pools", visible: true },
    { id: "init", label: "Initialize Pool", visible: true },
    { id: "allowlist", label: "Allowlist", visible: isSuperAdmin },
    { id: "audit", label: "Audit Log", visible: true },
  ];
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid #e5e7eb" }}>
      {tabs.filter((t) => t.visible).map((t) => {
        const active = t.id === tab;
        return (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600,
              color: active ? "#0b0b10" : "#6b7280",
              background: "transparent", border: "none",
              borderBottom: active ? "2px solid #6d28d9" : "2px solid transparent",
              cursor: "pointer", marginBottom: -1 }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────

export default function AdminPage() {
  const { publicKey } = useWallet();
  const { role, loading } = useAdminRole();
  const connected = !!publicKey;
  const isAuthorized = role === "pool_admin" || role === "super_admin";
  const isSuperAdmin = role === "super_admin";
  const [tab, setTab] = useState<Tab>("pools");

  // Allowlist tab is super-admin only — switch back if user loses privilege
  useEffect(() => {
    if (tab === "allowlist" && !isSuperAdmin) setTab("pools");
  }, [tab, isSuperAdmin]);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fa", display: "flex", flexDirection: "column" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <header style={{ background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/dapp" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "#6b7280", fontSize: 13, fontWeight: 500 }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 12L6 8l4-4" /></svg>
              Back to app
            </Link>
            <div style={{ width: 1, height: 18, background: "#e5e7eb" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#0b0b10,#374151)", display: "grid", placeItems: "center" }}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="white"><path d="M8 1a5 5 0 100 10A5 5 0 008 1zm0 8a3 3 0 110-6 3 3 0 010 6zm4.5 1.5a.5.5 0 01.5.5v.5a.5.5 0 01-.5.5H3.5a.5.5 0 01-.5-.5V11a.5.5 0 01.5-.5h9z"/></svg>
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", letterSpacing: "-0.02em" }}>Veil Admin</div>
                <div style={{ fontSize: 10.5, color: "#9ca3af", fontFamily: "var(--font-mono),monospace" }}>
                  Auth: server-side allowlist
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {connected && !loading && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700,
                background: isAuthorized ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${isAuthorized ? "#bbf7d0" : "#fecaca"}`,
                color: isAuthorized ? "#059669" : "#dc2626" }}>
                {isAuthorized ? `✓ ${role}` : "✕ Unauthorized"}
              </div>
            )}
            <WalletMultiButton style={{ fontSize: "12px", height: "34px", borderRadius: "8px", padding: "0 14px",
              background: connected ? (isAuthorized ? "#ecfdf5" : "#0b0b10") : "#0b0b10",
              color: connected ? (isAuthorized ? "#065f46" : "#ffffff") : "#ffffff",
              border: connected && isAuthorized ? "1px solid #a7f3d0" : "none", fontWeight: 600 }} />
          </div>
        </div>
      </header>

      {!connected && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 40 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#f3f4f6", border: "1px solid #e5e7eb", display: "grid", placeItems: "center" }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0b0b10", marginBottom: 6 }}>Connect your wallet</div>
            <div style={{ fontSize: 14, color: "#6b7280", maxWidth: 380 }}>
              Connect an authorized admin wallet to manage pools, update parameters, and create new markets.
            </div>
          </div>
          <WalletMultiButton style={{ fontSize: "14px", height: "42px", borderRadius: "10px", padding: "0 24px", background: "#0b0b10", color: "white", border: "none", fontWeight: 700 }} />
        </div>
      )}

      {connected && loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontSize: 14 }}>
          checking allowlist…
        </div>
      )}

      {connected && !loading && !isAuthorized && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 40 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#fef2f2", border: "1px solid #fecaca", display: "grid", placeItems: "center" }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
            </svg>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0b0b10", marginBottom: 6 }}>Access denied</div>
            <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 12, maxWidth: 460 }}>
              Your wallet is not on the pool admin allowlist. Contact a super-admin to be added,
              then refresh.
            </div>
            <div style={{ fontSize: 12, fontFamily: "var(--font-mono),monospace", color: "#dc2626", background: "#fef2f2", padding: "6px 14px", borderRadius: 8, display: "inline-block" }}>
              {publicKey?.toBase58().slice(0, 8)}…{publicKey?.toBase58().slice(-8)}
            </div>
          </div>
        </div>
      )}

      {connected && !loading && isAuthorized && (
        <div style={{ flex: 1, maxWidth: 1100, margin: "0 auto", width: "100%", padding: "24px 24px 48px" }}>
          <TabBar tab={tab} setTab={setTab} isSuperAdmin={isSuperAdmin} />
          {tab === "pools"     && <PoolsView />}
          {tab === "init"      && <InitPoolPanel />}
          {tab === "allowlist" && isSuperAdmin && <AllowlistPanel />}
          {tab === "audit"     && <AuditLogPanel />}
        </div>
      )}
    </div>
  );
}
