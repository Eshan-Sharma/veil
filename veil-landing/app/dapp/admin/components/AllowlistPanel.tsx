"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { requestSignedAuth } from "@/lib/auth/client";

type AdminEntry = {
  pubkey: string;
  role: "super_admin" | "pool_admin";
  label: string | null;
  added_by: string | null;
  created_at: string;
};

export function AllowlistPanel() {
  const wallet = useWallet();
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pubkey, setPubkey] = useState("");
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<"pool_admin" | "super_admin">("pool_admin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/allowlist", { cache: "no-store" });
      const data = await res.json() as { admins: AdminEntry[] };
      setAdmins(data.admins);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function handleAdd() {
    setErr(null); setOk(null);
    const k = pubkey.trim();
    if (!k) { setErr("pubkey required"); return; }
    try { new PublicKey(k); } catch { setErr("invalid pubkey"); return; }
    setBusy(true);
    try {
      const auth = await requestSignedAuth(wallet, `add_admin:${k}:${role}`);
      const res = await fetch("/api/admin/allowlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...auth, pubkey: k, role, label: label.trim() || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `failed (${res.status})`);
      }
      setOk(`added ${k.slice(0, 6)}…`);
      setPubkey(""); setLabel("");
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(target: string) {
    setErr(null); setOk(null);
    if (!confirm(`Revoke ${target}?`)) return;
    setBusy(true);
    try {
      const auth = await requestSignedAuth(wallet, `revoke_admin:${target}`);
      const res = await fetch("/api/admin/allowlist", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...auth, pubkey: target }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `failed (${res.status})`);
      }
      setOk(`revoked ${target.slice(0, 6)}…`);
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: "18px 22px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10", marginBottom: 4 }}>Add Pool Admin</div>
        <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 16 }}>
          Only wallets in this allowlist can initialize new pools or be issued super-admin
          privileges. Adding requires a signed nonce from your super-admin wallet.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 100px", gap: 8, marginBottom: 8 }}>
          <input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="Wallet pubkey"
                 style={{ padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 12.5, fontFamily: "var(--font-mono),monospace", background: "#f9f9fb", outline: "none" }}/>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)"
                 style={{ padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 12.5, background: "#f9f9fb", outline: "none" }}/>
          <select value={role} onChange={(e) => setRole(e.target.value as "pool_admin" | "super_admin")}
                  style={{ padding: "9px 8px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 12, background: "#f9f9fb", outline: "none" }}>
            <option value="pool_admin">pool_admin</option>
            <option value="super_admin">super_admin</option>
          </select>
        </div>
        <button onClick={handleAdd} disabled={busy || !pubkey.trim()}
                style={{ padding: "9px 16px", borderRadius: 10, background: busy || !pubkey.trim() ? "#e5e7eb" : "#0b0b10", color: busy || !pubkey.trim() ? "#9ca3af" : "white", border: "none", fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
          {busy ? "Working…" : "Add to allowlist"}
        </button>
        {err && <div style={{ marginTop: 10, color: "#991b1b", fontSize: 12 }}>{err}</div>}
        {ok && <div style={{ marginTop: 10, color: "#059669", fontSize: 12 }}>{ok}</div>}
      </div>

      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Active admins ({admins.length})</div>
          <button onClick={() => void refresh()} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>refresh</button>
        </div>
        {loading ? (
          <div style={{ padding: 24, fontSize: 12, color: "#9ca3af" }}>loading…</div>
        ) : admins.length === 0 ? (
          <div style={{ padding: 24, fontSize: 12, color: "#9ca3af" }}>no admins yet</div>
        ) : (
          <div>
            {admins.map((a) => (
              <div key={a.pubkey} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 10, alignItems: "center", padding: "10px 18px", borderBottom: "1px solid #f3f4f6" }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: a.role === "super_admin" ? "#ede9fe" : "#f3f4f6", color: a.role === "super_admin" ? "#6d28d9" : "#374151" }}>
                  {a.role}
                </span>
                <div style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, color: "#374151" }}>
                  {a.pubkey}
                  {a.label && <span style={{ color: "#9ca3af", marginLeft: 8 }}>· {a.label}</span>}
                </div>
                <span style={{ fontSize: 10.5, color: "#9ca3af" }}>
                  {new Date(a.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={() => void handleRevoke(a.pubkey)}
                  disabled={busy || a.pubkey === wallet.publicKey?.toBase58()}
                  title={a.pubkey === wallet.publicKey?.toBase58() ? "cannot revoke yourself" : "revoke"}
                  style={{ fontSize: 11, color: "#dc2626", background: "none", border: "1px solid #fecaca", borderRadius: 8, padding: "3px 10px", cursor: busy || a.pubkey === wallet.publicKey?.toBase58() ? "not-allowed" : "pointer", opacity: a.pubkey === wallet.publicKey?.toBase58() ? 0.4 : 1 }}>
                  revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
