"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import { getRpcLabel, type SolanaRpcPreset } from "@/lib/solana/rpc";

const presets: SolanaRpcPreset[] = ["devnet", "mainnet", "localnet", "custom"];

interface RpcSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export const RpcSwitcher = ({ open, onClose }: RpcSwitcherProps) => {
  const { preset, customRpc, endpoint, setPreset, setCustomRpc } = useSolanaRpc();
  const [draft, setDraft] = useState(customRpc);

  useEffect(() => {
    setDraft(customRpc);
  }, [customRpc]);

  if (!open) return null;

  const applyCustomRpc = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setCustomRpc(trimmed);
    setPreset("custom");
  };

  return (
    <>
      <button aria-label="Close RPC settings" onClick={onClose} style={backdrop} />
      <aside style={shell}>
        <div style={header}>
          <div>
            <div style={eyebrow}>RPC Settings</div>
            <div style={title}>Choose network</div>
          </div>
          <button onClick={onClose} style={closeButton}>
            ✕
          </button>
        </div>

        <label style={label}>
          <span style={labelText}>Network</span>
          <select
            value={preset}
            onChange={(event) => setPreset(event.target.value as SolanaRpcPreset)}
            style={select}
          >
            {presets.map((item) => (
              <option key={item} value={item}>
                {getRpcLabel(item)}
              </option>
            ))}
          </select>
        </label>

        {preset === "custom" && (
          <div style={{ display: "grid", gap: 8 }}>
            <label style={label}>
              <span style={labelText}>Custom RPC URL</span>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={applyCustomRpc}
                placeholder="http://127.0.0.1:8899"
                spellCheck={false}
                style={input}
              />
            </label>
            <button onClick={applyCustomRpc} style={button}>
              Apply RPC
            </button>
          </div>
        )}

        <div style={meta}>
          <div style={metaLabel}>Active endpoint</div>
          <div style={endpointText}>{endpoint}</div>
        </div>
      </aside>
    </>
  );
}

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 69,
  border: "none",
  background: "rgba(15,23,42,0.28)",
  cursor: "pointer",
};

const shell: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  zIndex: 70,
  width: 360,
  maxWidth: "calc(100vw - 24px)",
  display: "grid",
  alignContent: "start",
  gap: 14,
  padding: "22px 18px",
  borderLeft: "1px solid rgba(229,231,235,0.95)",
  background: "rgba(255,255,255,0.98)",
  boxShadow: "-20px 0 50px rgba(15,23,42,0.12)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};

const eyebrow: CSSProperties = {
  fontFamily: "var(--font-mono),monospace",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "#9ca3af",
  marginBottom: 4,
};

const title: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#111827",
  letterSpacing: "-0.02em",
};

const closeButton: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 999,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#6b7280",
  fontSize: 14,
  cursor: "pointer",
};

const label: CSSProperties = { display: "grid", gap: 6 };
const labelText: CSSProperties = { fontSize: 11.5, fontWeight: 600, color: "#4b5563" };

const select: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#111827",
  fontSize: 13,
  outline: "none",
};

const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  background: "#f9fafb",
  color: "#111827",
  fontSize: 12.5,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "var(--font-mono),monospace",
};

const button: CSSProperties = {
  border: "1px solid #111827",
  borderRadius: 10,
  background: "#111827",
  color: "#fff",
  fontSize: 12.5,
  fontWeight: 600,
  padding: "9px 12px",
  cursor: "pointer",
};

const meta: CSSProperties = {
  paddingTop: 12,
  borderTop: "1px solid #f3f4f6",
  display: "grid",
  gap: 4,
};

const metaLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#9ca3af",
};

const endpointText: CSSProperties = {
  fontFamily: "var(--font-mono),monospace",
  fontSize: 11,
  color: "#374151",
  wordBreak: "break-all",
};
