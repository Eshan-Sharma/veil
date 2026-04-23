"use client";

import { useEffect, useState } from "react";

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  details: unknown;
  created_at: string;
}

const ACTION_TONE: Record<string, { fg: string; bg: string }> = {
  add_admin:    { fg: "#065f46", bg: "#d1fae5" },
  revoke_admin: { fg: "#991b1b", bg: "#fee2e2" },
  init_pool:    { fg: "#1e40af", bg: "#dbeafe" },
};

export function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/admin/audit?limit=200", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { entries: AuditEntry[] };
      setEntries(data.entries ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b0b10" }}>Audit Log</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              All allowlist mutations and pool registrations. Server-side, append-only.
            </div>
          </div>
          <button onClick={() => void refresh()} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>refresh</button>
        </div>

        {loading ? (
          <div style={{ padding: 32, fontSize: 12, color: "#9ca3af" }}>loading…</div>
        ) : err ? (
          <div style={{ padding: 32, fontSize: 13, color: "#991b1b" }}>{err}</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 32, fontSize: 12.5, color: "#6b7280" }}>
            No audit entries yet. Admin allowlist edits and pool initializations appear here.
          </div>
        ) : (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "150px 130px 1fr 1fr", padding: "9px 18px", borderBottom: "1px solid #e5e7eb", fontFamily: "var(--font-mono),monospace", fontSize: 10, letterSpacing: ".18em", color: "#9ca3af", textTransform: "uppercase" }}>
              <span>WHEN</span>
              <span>ACTION</span>
              <span>ACTOR</span>
              <span>TARGET</span>
            </div>
            {entries.map((e) => {
              const tone = ACTION_TONE[e.action] ?? { fg: "#374151", bg: "#f3f4f6" };
              return (
                <div key={e.id} style={{ display: "grid", gridTemplateColumns: "150px 130px 1fr 1fr", padding: "10px 18px", borderBottom: "1px solid #f3f4f6", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11, color: "#9ca3af" }}>
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                  <span style={{
                    fontFamily: "var(--font-mono),monospace", fontSize: 10, padding: "2px 7px",
                    borderRadius: 999, background: tone.bg, color: tone.fg,
                    fontWeight: 700, letterSpacing: ".05em", width: "fit-content",
                  }}>
                    {e.action}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, color: "#374151" }}>
                    {e.actor.slice(0, 6)}…{e.actor.slice(-4)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 11.5, color: "#374151" }}>
                    {e.target ? `${e.target.slice(0, 6)}…${e.target.slice(-4)}` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
