"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

// ─── Layout primitives ────────────────────────────────────────────────────────

const palette = {
  ink: "#0b0b10",
  text: "#374151",
  mute: "#6b7280",
  fade: "#9ca3af",
  line: "#e5e7eb",
  panel: "#ffffff",
  bg: "#f8f8fa",
  user: "#2563eb",
  admin: "#7c3aed",
  super: "#db2777",
  liq: "#dc2626",
  ok: "#059669",
  warn: "#d97706",
};

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 36 }}>
      {eyebrow && (
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: palette.fade, marginBottom: 6 }}>
          {eyebrow}
        </div>
      )}
      <h2 style={{ fontSize: 22, fontWeight: 700, color: palette.ink, letterSpacing: "-0.02em", margin: 0, marginBottom: 14 }}>{title}</h2>
      {children}
    </section>
  );
}

function Card({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return (
    <div style={{ background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 14, padding: "18px 20px", ...style }}>
      {children}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 999, background: `${color}1a`, color, fontSize: 11, fontWeight: 700, letterSpacing: ".02em", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{ fontFamily: "var(--font-mono),monospace", fontSize: 12, background: "#f3f4f6", padding: "1px 6px", borderRadius: 4, color: palette.ink }}>
      {children}
    </code>
  );
}

function StepRow({ n, title, who, children }: { n: number; title: string; who: string; children: ReactNode }) {
  const colorMap: Record<string, string> = {
    User: palette.user, Admin: palette.admin, "Super-admin": palette.super, Liquidator: palette.liq, Server: palette.ok, Chain: palette.ink,
  };
  const c = colorMap[who] ?? palette.mute

  return (
    <div style={{ display: "grid", gridTemplateColumns: "32px 1fr", gap: 14, marginBottom: 14 }}>
      <div style={{ width: 28, height: 28, borderRadius: 999, background: `${c}1a`, color: c, display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700 }}>
        {n}
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: palette.ink }}>{title}</div>
          <Pill color={c}>{who}</Pill>
        </div>
        <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

function Lane({ tone, title, items }: { tone: string; title: string; items: { ix: string; ix_disc: string; desc: string }[] }) {
  return (
    <div style={{ background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 14, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${palette.line}`, background: `${tone}0d` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tone }}>{title}</div>
      </div>
      <div>
        {items.map((it, i) => (
          <div key={it.ix} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "10px 16px", borderBottom: i < items.length - 1 ? `1px solid ${palette.line}` : "none" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: palette.ink, marginBottom: 2 }}>{it.ix}</div>
              <div style={{ fontSize: 12, color: palette.mute, lineHeight: 1.4 }}>{it.desc}</div>
            </div>
            <Code>{it.ix_disc}</Code>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  return (
    <div style={{ minHeight: "100vh", background: palette.bg }}>
      <header style={{ background: palette.panel, borderBottom: `1px solid ${palette.line}`, padding: "0 24px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: palette.mute, fontSize: 13, fontWeight: 500 }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 12L6 8l4-4" /></svg>
              Home
            </Link>
            <div style={{ width: 1, height: 18, background: palette.line }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: palette.ink }}>Veil — Platform Workflow</div>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <Link href="/dapp" style={{ fontSize: 13, color: palette.mute, textDecoration: "none" }}>App →</Link>
            <Link href="/dapp/admin" style={{ fontSize: 13, color: palette.mute, textDecoration: "none" }}>Admin →</Link>
            <Link href="/dapp/liquidate" style={{ fontSize: 13, color: palette.mute, textDecoration: "none" }}>Liquidate →</Link>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 24px 72px" }}>
        {/* ─── Hero ──────────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: palette.fade, marginBottom: 8 }}>End-to-end</div>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: palette.ink, letterSpacing: "-0.03em", margin: 0, marginBottom: 8 }}>
            How the Veil platform works
          </h1>
          <p style={{ fontSize: 15, color: palette.text, lineHeight: 1.6, margin: 0, maxWidth: 720 }}>
            Three actors, one Solana program, one Postgres index, four pages.
            Authority for pool creation is gated by an off-chain allowlist; everything
            else (deposit, borrow, repay, liquidate) is permissionless and on-chain.
          </p>
        </div>

        {/* ─── Roles ──────────────────────────────────────────────────────── */}
        <Section eyebrow="Actors" title="Who can do what">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Card>
              <Pill color={palette.user}>User</Pill>
              <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.55, marginTop: 10 }}>
                Any wallet. Deposits collateral, borrows, repays, withdraws,
                runs flash loans, optionally enables FHE privacy.
              </div>
            </Card>
            <Card>
              <Pill color={palette.liq}>Liquidator</Pill>
              <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.55, marginTop: 10 }}>
                Any wallet with capital. Repays unhealthy debt and seizes collateral
                at a 5% bonus when <Code>HF&lt;1</Code>. Permissionless.
              </div>
            </Card>
            <Card>
              <Pill color={palette.admin}>Pool Admin</Pill>
              <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.55, marginTop: 10 }}>
                Allowlisted wallet. Creates pools, updates risk params,
                pauses/resumes, collects accumulated protocol fees from their pools.
              </div>
            </Card>
            <Card>
              <Pill color={palette.super}>Super-admin</Pill>
              <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.55, marginTop: 10 }}>
                Bootstraps and curates the pool-admin allowlist. Cannot revoke self.
                Stored in <Code>pool_admins</Code> on Neon Postgres.
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Architecture ──────────────────────────────────────────────── */}
        <Section eyebrow="Stack" title="Architecture">
          <Card>
            <pre style={{ fontFamily: "var(--font-mono),monospace", fontSize: 12, lineHeight: 1.7, color: palette.ink, margin: 0, whiteSpace: "pre-wrap" }}>
{` Wallet (Phantom / Solflare)
        │  signs ix bundle
        ▼
 Next.js App Router  ──────────►  Neon Postgres
   /dapp           (tx logs, pool cache, allowlist,
   /dapp/admin     positions cache, audit log,
   /dapp/liquidate auth nonces)
   /workflow                ▲
   /api/*                   │ server-side admin auth
        │  RPC               │ (signed nonce + role check)
        ▼                    │
 Solana devnet ──────────────┘
   ▸ Veil program (Pinocchio)   21 ix
   ▸ Pyth price feeds            permissionless oracle refresh
   ▸ Ika dWallet program          MPC-signed cross-chain collateral`}
            </pre>
          </Card>
        </Section>

        {/* ─── User flow ──────────────────────────────────────────────────── */}
        <Section eyebrow="Flow" title="User: borrow against collateral">
          <Card>
            <StepRow n={1} who="User" title="Connect wallet on /dapp">
              Phantom or Solflare on Solana devnet. The connect button is hydration-safe — placeholder until client mount.
            </StepRow>
            <StepRow n={2} who="User" title="Deposit collateral into a pool">
              Calls <Code>Deposit (0x01)</Code>. Mints supply-shares: <Code>shares = amount × WAD / supply_index</Code>.
              Tokens move from your ATA into the pool vault PDA. Interest accrues automatically every block via index updates.
            </StepRow>
            <StepRow n={3} who="User" title="Borrow against deposits">
              Calls <Code>Borrow (0x03)</Code>. The program enforces both caps before transferring:
              <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                <li>LTV: <Code>debt_after ≤ deposit_balance × ltv</Code> (default 75%)</li>
                <li>Health factor: <Code>HF = collateral × LT / debt ≥ 1.0 (WAD)</Code></li>
                <li>Vault liquidity is sufficient.</li>
              </ul>
            </StepRow>
            <StepRow n={4} who="User" title="Repay debt">
              <Code>Repay (0x04)</Code>. Pass <Code>u64::MAX</Code> to settle in full.
              Repaid interest is credited to suppliers (minus reserve_factor → protocol fees).
            </StepRow>
            <StepRow n={5} who="User" title="Withdraw collateral">
              <Code>Withdraw (0x02)</Code>. Burns shares and pulls tokens from vault. Reverts if it would push HF below 1.0.
            </StepRow>
            <StepRow n={6} who="Server" title="Index">
              Each user tx is logged to <Code>tx_log</Code>; the affected pool is then re-fetched from chain
              and upserted into <Code>pools</Code> via <Code>POST /api/pools/sync</Code>.
            </StepRow>
          </Card>
        </Section>

        {/* ─── Flash loans ────────────────────────────────────────────────── */}
        <Section eyebrow="Flow" title="User: flash loan (no collateral)">
          <Card>
            <StepRow n={1} who="User" title="Build a single transaction with two ix">
              <Code>FlashBorrow (0x06)</Code> followed by your custom logic and finally
              <Code>FlashRepay (0x07)</Code>. Both must be in the same tx; missing repay = atomic revert.
            </StepRow>
            <StepRow n={2} who="Chain" title="Repay = principal + 0.09% fee">
              Fee splits 90% to LPs (added to <Code>total_deposits</Code>), 10% to <Code>accumulated_fees</Code> for the protocol.
              Fee rate is per-pool, configurable up to 100%.
            </StepRow>
          </Card>
        </Section>

        {/* ─── Liquidator flow ────────────────────────────────────────────── */}
        <Section eyebrow="Flow" title="Liquidator: capture undercollateralised positions">
          <Card>
            <StepRow n={1} who="Liquidator" title="Watch for HF < 1.0">
              Query <Code>GET /api/positions/[user]</Code> or scan all positions; the
              cached <Code>health_factor_wad</Code> column is indexed for fast filtering of borrowers in distress.
            </StepRow>
            <StepRow n={2} who="Liquidator" title="Open /dapp/liquidate">
              Pick the market, enter the borrower&apos;s wallet pubkey, click Liquidate.
              The frontend builds and submits <Code>Liquidate (0x05)</Code>.
            </StepRow>
            <StepRow n={3} who="Chain" title="Atomic settlement">
              On-chain math: <br />
              <Code>repay = total_debt × close_factor</Code> (50%)<br />
              <Code>seized = repay × (1 + liquidation_bonus)</Code> (×1.05)<br />
              Liquidator gets <Code>seized × (1 − protocol_liq_fee)</Code> (90%).<br />
              Reverts if borrower is healthy (<Code>HF ≥ 1.0</Code>).
            </StepRow>
          </Card>
        </Section>

        {/* ─── Admin flow ─────────────────────────────────────────────────── */}
        <Section eyebrow="Flow" title="Pool admin: create and govern a pool">
          <Card>
            <StepRow n={1} who="Admin" title="Open /dapp/admin">
              Frontend calls <Code>GET /api/admin/me</Code>. If the wallet isn&apos;t in
              <Code>pool_admins</Code> the access-denied gate shows. Otherwise the admin tabs unlock.
            </StepRow>
            <StepRow n={2} who="Admin" title="Initialize Pool tab">
              Enter the SPL token mint. Frontend builds a 2-ix tx:
              <ul style={{ margin: "6px 0 0 18px" }}>
                <li>Create the pool-authority ATA (vault) for the mint.</li>
                <li>Call <Code>Initialize (0x00)</Code> on the Veil program.</li>
              </ul>
            </StepRow>
            <StepRow n={3} who="Admin" title="Sign auth nonce">
              Wallet signs the message returned by <Code>POST /api/auth/nonce</Code>.
              Frontend calls <Code>POST /api/pools/init</Code>.
              Server verifies signature, single-uses the nonce, checks allowlist, and inserts the pool row.
              Anyone bypassing this can still create a pool on-chain — but it won&apos;t be indexed by Veil.
            </StepRow>
            <StepRow n={4} who="Admin" title="Manage Pools tab — tune risk parameters">
              <Code>UpdatePool (0x0D)</Code>: 168-byte payload of u128 LE WAD values plus the flash fee in bps.
              Validation: <Code>LTV &lt; LiqThreshold &lt; 100%</Code>, reserve factor &lt; 100%, flash fee ≤ 10000 bps.
              Authority is enforced on-chain — only <Code>pool.authority</Code> can update.
            </StepRow>
            <StepRow n={5} who="Admin" title="Pause / Resume">
              <Code>PausePool (0x0E)</Code> blocks Deposit / Borrow / FlashBorrow.
              Withdraw, Repay, Liquidate stay open so users can always exit.
              <Code>ResumePool (0x0F)</Code> clears it.
            </StepRow>
            <StepRow n={6} who="Admin" title="Collect fees">
              <Code>CollectFees (0x10)</Code> sweeps <Code>accumulated_fees</Code> to the supplied treasury ATA.
              Tx logged in <Code>tx_log</Code> + audit entry written.
            </StepRow>
          </Card>
        </Section>

        {/* ─── Super-admin flow ───────────────────────────────────────────── */}
        <Section eyebrow="Flow" title="Super-admin: curate the allowlist">
          <Card>
            <StepRow n={1} who="Super-admin" title="Allowlist tab on /dapp/admin">
              Visible only when <Code>role === &quot;super_admin&quot;</Code>. Lists all active admins,
              who added them, and when.
            </StepRow>
            <StepRow n={2} who="Super-admin" title="Add a wallet">
              Form takes pubkey, role (<Code>pool_admin</Code> | <Code>super_admin</Code>), label.
              Submit signs the nonce, hits <Code>POST /api/admin/allowlist</Code>.
            </StepRow>
            <StepRow n={3} who="Super-admin" title="Revoke">
              Soft-delete via <Code>UPDATE … SET revoked_at = now()</Code>.
              Cannot revoke self — the API rejects the request to prevent lockout.
              All actions appear in <Code>audit_log</Code>.
            </StepRow>
            <StepRow n={4} who="Server" title="CLI bootstrap">
              For first-time setup or emergencies: <Code>npm run db:add-admin -- &lt;pubkey&gt; [role] [label]</Code>.
              Used to bootstrap the initial super-admin from the migration script.
            </StepRow>
          </Card>
        </Section>

        {/* ─── Auth ───────────────────────────────────────────────────────── */}
        <Section eyebrow="Security" title="How admin auth actually works">
          <Card>
            <ol style={{ margin: 0, padding: "0 0 0 18px", color: palette.text, fontSize: 13.5, lineHeight: 1.7 }}>
              <li>UI calls <Code>POST /api/auth/nonce</Code> with <Code>{`{ pubkey, action }`}</Code>; server stores a 16-byte nonce with 5-min TTL in <Code>auth_nonces</Code> and returns the canonical message <Code>Veil admin auth\\nAction: {`{action}`}\\nNonce: {`{nonce}`}</Code>.</li>
              <li>Wallet signs the exact message bytes (ed25519). Frontend posts <Code>{`{ actor, nonce, signature }`}</Code> to the protected endpoint.</li>
              <li>Server (1) verifies signature with TweetNaCl, (2) <Code>DELETE … RETURNING</Code> consumes the nonce — atomic single-use, (3) looks up role in <Code>pool_admins</Code>, (4) checks <Code>requireRole</Code> for super-admin actions.</li>
              <li>On-chain admin authority is independent — the Veil program also enforces <Code>signer == pool.authority</Code>. The off-chain allowlist gates <em>who can become</em> a pool.authority via the curated UI.</li>
            </ol>
          </Card>
        </Section>

        {/* ─── Instruction map ────────────────────────────────────────────── */}
        <Section eyebrow="Reference" title="All 21 program instructions">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Lane tone={palette.user} title="User-facing"
              items={[
                { ix: "Deposit", ix_disc: "0x01", desc: "Mint supply shares for tokens." },
                { ix: "Withdraw", ix_disc: "0x02", desc: "Burn shares for tokens; HF check." },
                { ix: "Borrow", ix_disc: "0x03", desc: "Borrow against collateral; LTV + HF." },
                { ix: "Repay", ix_disc: "0x04", desc: "Settle debt; capped at current debt." },
                { ix: "FlashBorrow", ix_disc: "0x06", desc: "Atomic loan; needs FlashRepay in same tx." },
                { ix: "FlashRepay", ix_disc: "0x07", desc: "Pay back principal + 9 bps fee." },
              ]}/>
            <Lane tone={palette.liq} title="Liquidation & oracle"
              items={[
                { ix: "Liquidate", ix_disc: "0x05", desc: "Repay 50% of debt, seize +5% bonus." },
                { ix: "UpdateOraclePrice", ix_disc: "0x14", desc: "Permissionless Pyth refresh." },
              ]}/>
            <Lane tone={palette.admin} title="Pool admin (signer must = pool.authority)"
              items={[
                { ix: "Initialize", ix_disc: "0x00", desc: "Create pool PDA + claim authority." },
                { ix: "UpdatePool", ix_disc: "0x0D", desc: "All risk params + flash fee bps." },
                { ix: "PausePool", ix_disc: "0x0E", desc: "Block Deposit/Borrow/FlashBorrow." },
                { ix: "ResumePool", ix_disc: "0x0F", desc: "Clear pause flag." },
                { ix: "CollectFees", ix_disc: "0x10", desc: "Sweep accumulated_fees → treasury." },
              ]}/>
            <Lane tone={palette.warn} title="Privacy (FHE — pending Encrypt SDK)"
              items={[
                { ix: "EnablePrivacy", ix_disc: "0x08", desc: "Spawn EncryptedPosition + ciphertexts." },
                { ix: "PrivateDeposit", ix_disc: "0x09", desc: "Plaintext + FHE add_deposit CPI." },
                { ix: "PrivateWithdraw", ix_disc: "0x0C", desc: "Plaintext + FHE sub_deposit CPI." },
                { ix: "PrivateBorrow", ix_disc: "0x0A", desc: "Plaintext + FHE add_debt CPI." },
                { ix: "PrivateRepay", ix_disc: "0x0B", desc: "Plaintext + FHE sub_debt CPI." },
              ]}/>
            <Lane tone={palette.super} title="Cross-chain collateral (Ika dWallet)"
              items={[
                { ix: "IkaRegister", ix_disc: "0x11", desc: "Pledge dWallet authority to Veil PDA." },
                { ix: "IkaSign", ix_disc: "0x13", desc: "Approve a Bitcoin/Ethereum tx via MPC." },
                { ix: "IkaRelease", ix_disc: "0x12", desc: "Return dWallet authority to user." },
              ]}/>
          </div>
        </Section>

        {/* ─── API map ────────────────────────────────────────────────────── */}
        <Section eyebrow="Reference" title="HTTP API">
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "auto auto 1fr", gap: 8, fontSize: 12.5, lineHeight: 1.8 }}>
              <Code>GET</Code><Code>/api/admin/me?pubkey=…</Code><span style={{ color: palette.mute }}>Role lookup for UI gating.</span>
              <Code>POST</Code><Code>/api/auth/nonce</Code><span style={{ color: palette.mute }}>Issue signed-message nonce (TTL 5m, single-use).</span>
              <Code>GET</Code><Code>/api/admin/allowlist</Code><span style={{ color: palette.mute }}>Public list of active admins.</span>
              <Code>POST</Code><Code>/api/admin/allowlist</Code><span style={{ color: palette.mute }}>Add admin. Requires super-admin signed nonce.</span>
              <Code>DELETE</Code><Code>/api/admin/allowlist</Code><span style={{ color: palette.mute }}>Revoke admin. Cannot revoke self.</span>
              <Code>GET</Code><Code>/api/pools</Code><span style={{ color: palette.mute }}>Cached pool index.</span>
              <Code>POST</Code><Code>/api/pools/init</Code><span style={{ color: palette.mute }}>Register a freshly created pool. Allowlist-gated.</span>
              <Code>POST</Code><Code>/api/pools/sync</Code><span style={{ color: palette.mute }}>Refresh a pool from chain into the cache.</span>
              <Code>GET</Code><Code>/api/positions/[user]</Code><span style={{ color: palette.mute }}>Cached positions for a wallet.</span>
              <Code>GET</Code><Code>/api/transactions</Code><span style={{ color: palette.mute }}>Tx log; filter by wallet or pool.</span>
              <Code>POST</Code><Code>/api/transactions</Code><span style={{ color: palette.mute }}>Append a tx (called from useVeilActions on success).</span>
            </div>
          </Card>
        </Section>

        {/* ─── DB shape ───────────────────────────────────────────────────── */}
        <Section eyebrow="Reference" title="Postgres schema (Neon)">
          <Card>
            <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.7 }}>
              <Code>pool_admins</Code> — pubkey, role, label, added_by, created_at, revoked_at<br />
              <Code>pools</Code> — pool_address (PK), token_mint, symbol, authority, vault, bumps, paused, totals, all WAD risk params, oracle snapshot, created_by, init_signature<br />
              <Code>positions</Code> — position_address (PK), pool_address (FK), owner, deposit_shares, borrow_principal, snapshots, health_factor_wad<br />
              <Code>tx_log</Code> — signature (UNIQUE), pool_address, wallet, action, amount, status, error_msg<br />
              <Code>audit_log</Code> — actor, action, target, details JSONB<br />
              <Code>auth_nonces</Code> — (pubkey, nonce) PK, expires_at
            </div>
          </Card>
        </Section>

        {/* ─── Quick links ────────────────────────────────────────────────── */}
        <Section eyebrow="Try it" title="Jump in">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Link href="/dapp" style={{ textDecoration: "none" }}>
              <Card style={{ cursor: "pointer" }}>
                <Pill color={palette.user}>User</Pill>
                <div style={{ fontSize: 14, fontWeight: 700, color: palette.ink, marginTop: 8 }}>Open the app →</div>
                <div style={{ fontSize: 12, color: palette.mute, marginTop: 4 }}>Markets, deposit, borrow, flash loans.</div>
              </Card>
            </Link>
            <Link href="/dapp/liquidate" style={{ textDecoration: "none" }}>
              <Card style={{ cursor: "pointer" }}>
                <Pill color={palette.liq}>Liquidator</Pill>
                <div style={{ fontSize: 14, fontWeight: 700, color: palette.ink, marginTop: 8 }}>Liquidate a position →</div>
                <div style={{ fontSize: 12, color: palette.mute, marginTop: 4 }}>Repay underwater debt, capture bonus.</div>
              </Card>
            </Link>
            <Link href="/dapp/admin" style={{ textDecoration: "none" }}>
              <Card style={{ cursor: "pointer" }}>
                <Pill color={palette.admin}>Admin</Pill>
                <div style={{ fontSize: 14, fontWeight: 700, color: palette.ink, marginTop: 8 }}>Open admin panel →</div>
                <div style={{ fontSize: 12, color: palette.mute, marginTop: 4 }}>Initialize, manage, allowlist.</div>
              </Card>
            </Link>
          </div>
        </Section>
      </div>
    </div>
  );
}
