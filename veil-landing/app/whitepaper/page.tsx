"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// ─── Tokens ──────────────────────────────────────────────────────────────────
// A document-first, Stellaray-style theme:
//   • warm off-white paper background
//   • near-black ink, monospace tags, large serif numerals
//   • generous body line-height (1.75) and 760-px reading column
//   • numbered sections 0-11 with monospace SECTION labels
//   • sticky TOC + reading progress
//   • all-caps for tags / nav / button labels

const t = {
  paper: "#f7f6f1",
  paperEdge: "#efeee6",
  ink: "#0b0b10",
  ink2: "#1f2026",
  text: "#2a2b32",
  mute: "#6b6e78",
  fade: "#9da0aa",
  line: "#1f2026",
  hair: "#dad8cf",
  hairSoft: "#e8e6dc",
  accent: "#0b0b10",
  cream: "#f0eee3",
  cite: "#5b5e68",
  highlight: "#f9d77f33",
};

const fontSans = "var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const fontSerif = "var(--font-serif), 'Iowan Old Style', 'Apple Garamond', Georgia, serif";
const fontMono = "var(--font-mono), ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, monospace";

// ─── TOC structure (must mirror sections rendered below) ─────────────────────

interface TocItem { id: string; n: string; title: string; }
const TOC: TocItem[] = [
  { id: "abstract",            n: "00", title: "Abstract" },
  { id: "introduction",        n: "01", title: "Introduction" },
  { id: "design-principles",   n: "02", title: "Design Principles" },
  { id: "system-overview",     n: "03", title: "System Overview" },
  { id: "on-chain-state",      n: "04", title: "On-Chain State" },
  { id: "math-spec",           n: "05", title: "Mathematical Specification" },
  { id: "instructions",        n: "06", title: "Instruction Specification" },
  { id: "authorization",       n: "07", title: "Authorization Model" },
  { id: "oracle",              n: "08", title: "Oracle Subsystem" },
  { id: "privacy",             n: "09", title: "Privacy Subsystem (FHE)" },
  { id: "cross-chain",         n: "10", title: "Cross-Chain Collateral" },
  { id: "off-chain",           n: "11", title: "Off-Chain Infrastructure" },
  { id: "threat-model",        n: "12", title: "Threat Model" },
  { id: "comparison",          n: "13", title: "Comparison: Aave V3" },
  { id: "roadmap",             n: "14", title: "Roadmap" },
  { id: "references",          n: "15", title: "References" },
];

// ─── Reading progress hook ───────────────────────────────────────────────────

function useReadingProgress(): number {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const total = h.scrollHeight - h.clientHeight;
      const done = total > 0 ? (h.scrollTop / total) * 100 : 0;
      setPct(Math.max(0, Math.min(100, done)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return pct;
}

// ─── Active-section observer ─────────────────────────────────────────────────

function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0]);
  const lock = useRef(false);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => {
      if (lock.current) return;
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => (a.target as HTMLElement).offsetTop - (b.target as HTMLElement).offsetTop);
      if (visible[0]) setActive((visible[0].target as HTMLElement).id);
    }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontFamily: fontMono, ...style }}>{children}</span>;
}

function HR() {
  return <hr style={{ border: "none", borderTop: `1px solid ${t.hair}`, margin: "32px 0" }} />;
}

function SectionLabel({ n }: { n: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      fontFamily: fontMono, fontSize: 11, letterSpacing: ".18em",
      color: t.mute, textTransform: "uppercase", marginBottom: 10,
    }}>
      <span>SECTION&nbsp;{n}</span>
      <span style={{ flex: 1, height: 1, background: t.hair }} />
    </div>
  );
}

function H2({ id, n, children }: { id: string; n: string; children: ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 90, marginTop: 64 }}>
      <SectionLabel n={n} />
      <h2 style={{
        fontFamily: fontSerif, fontWeight: 400,
        fontSize: 40, lineHeight: 1.1, letterSpacing: "-0.02em",
        color: t.ink, margin: "0 0 24px",
      }}>
        {children}
      </h2>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 style={{
      fontFamily: fontSans, fontWeight: 600,
      fontSize: 17, letterSpacing: "-0.01em",
      color: t.ink, margin: "32px 0 10px",
    }}>{children}</h3>
  );
}

function P({ children }: { children: ReactNode }) {
  return (
    <p style={{
      fontFamily: fontSans, fontSize: 15.5, lineHeight: 1.75,
      color: t.text, margin: "0 0 16px", textWrap: "pretty" as const,
    }}>{children}</p>
  );
}

function Em({ children }: { children: ReactNode }) {
  return <em style={{ fontFamily: fontSerif, fontStyle: "italic", color: t.ink2 }}>{children}</em>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{
      fontFamily: fontMono, fontSize: 12.5,
      background: t.cream, padding: "1px 7px", borderRadius: 3,
      color: t.ink, border: `1px solid ${t.hairSoft}`,
    }}>{children}</code>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre style={{
      fontFamily: fontMono, fontSize: 12.5, lineHeight: 1.7,
      background: t.cream, border: `1px solid ${t.hairSoft}`,
      borderRadius: 4, padding: "18px 20px", margin: "16px 0",
      overflowX: "auto", whiteSpace: "pre", color: t.ink,
    }}>{children}</pre>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{
      borderLeft: `2px solid ${t.ink}`, padding: "8px 16px",
      margin: "20px 0", background: "transparent",
      fontFamily: fontSans, fontSize: 14.5, lineHeight: 1.7,
      color: t.text,
    }}>{children}</div>
  );
}

function Numbered({ no, title, children }: { no: string; title: string; children: ReactNode }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "76px 1fr", gap: 20,
      padding: "20px 0", borderBottom: `1px solid ${t.hairSoft}`,
    }}>
      <div style={{
        fontFamily: fontSerif, fontSize: 38, fontWeight: 400,
        color: t.ink, lineHeight: 1, paddingTop: 4,
      }}>{no}</div>
      <div>
        <div style={{
          fontFamily: fontSans, fontSize: 16, fontWeight: 600,
          color: t.ink, marginBottom: 4, letterSpacing: "-0.01em",
        }}>{title}</div>
        <div style={{
          fontFamily: fontSans, fontSize: 14.5, lineHeight: 1.7, color: t.text,
        }}>{children}</div>
      </div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div style={{ margin: "20px 0", overflowX: "auto" }}>
      <table style={{
        width: "100%", borderCollapse: "collapse",
        fontFamily: fontSans, fontSize: 13.5,
      }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={i} style={{
              textAlign: "left", padding: "10px 12px",
              borderBottom: `1px solid ${t.line}`,
              fontFamily: fontMono, fontSize: 10.5,
              letterSpacing: ".14em", textTransform: "uppercase",
              color: t.mute, fontWeight: 600,
            }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{
                  padding: "10px 12px", verticalAlign: "top",
                  borderBottom: `1px solid ${t.hair}`,
                  color: t.text, lineHeight: 1.55,
                }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WhitepaperPage() {
  const pct = useReadingProgress();
  const active = useActiveSection(TOC.map((x) => x.id));

  return (
    <div style={{ background: t.paper, minHeight: "100vh", color: t.ink }}>
      {/* ── Top progress bar ──────────────────────────────────────────── */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 2, zIndex: 60, background: "transparent" }}>
        <div style={{ height: 2, width: `${pct}%`, background: t.ink, transition: "width 80ms linear" }} />
      </div>

      {/* ── Top nav ───────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, background: `${t.paper}f0`,
        backdropFilter: "saturate(180%) blur(8px)",
        WebkitBackdropFilter: "saturate(180%) blur(8px)",
        borderBottom: `1px solid ${t.hair}`, zIndex: 50,
      }}>
        <div style={{
          maxWidth: 1180, margin: "0 auto", padding: "0 28px",
          height: 56, display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <Link href="/" style={{
              fontFamily: fontMono, fontSize: 11, letterSpacing: ".22em",
              textTransform: "uppercase", color: t.ink, textDecoration: "none",
            }}>← HOME</Link>
            <span style={{ width: 1, height: 14, background: t.hair }} />
            <Link href="/" style={{
              fontFamily: fontMono, fontSize: 11, letterSpacing: ".28em",
              textTransform: "uppercase", color: t.ink, textDecoration: "none", fontWeight: 700,
            }}>VEIL</Link>
          </div>
          <nav style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <Link href="/dapp" style={navLinkStyle}>APP</Link>
            <Link href="/workflow" style={navLinkStyle}>WORKFLOW</Link>
            <Link href="/dapp/admin" style={navLinkStyle}>ADMIN</Link>
            <span style={{ ...navLinkStyle, color: t.fade, fontVariantNumeric: "tabular-nums" }}>
              {pct.toFixed(0)}%
            </span>
          </nav>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "56px 28px 0" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 16,
          fontFamily: fontMono, fontSize: 11, letterSpacing: ".22em",
          color: t.mute, textTransform: "uppercase", marginBottom: 32,
        }}>
          <span>WHITEPAPER</span>
          <span>·</span>
          <span>v0.1</span>
          <span>·</span>
          <span>2026·04·25</span>
          <span>·</span>
          <span>21 MIN READ</span>
        </div>
        <h1 style={{
          fontFamily: fontSerif, fontSize: 72, lineHeight: 0.98,
          letterSpacing: "-0.035em", fontWeight: 400, color: t.ink,
          margin: 0, maxWidth: 980,
        }}>
          A privacy-first cross-chain<br />
          lending protocol on Solana.
        </h1>
        <div style={{
          marginTop: 28, fontFamily: fontSans, fontSize: 17, lineHeight: 1.7,
          color: t.text, maxWidth: 760,
        }}>
          Native Bitcoin, Ethereum, and physical-gold collateral via MPC dWallets and Oro/GRAIL settlement. Optional per-position fully-homomorphic privacy. A two-slope kink interest-rate model and Aave-style liquidation engine, implemented in Pinocchio for low compute-unit overhead.
        </div>
        <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0,
          borderTop: `1px solid ${t.line}`, borderBottom: `1px solid ${t.hair}` }}>
          <Meta label="AUTHOR"   value="Veil Labs" />
          <Meta label="STATUS"   value="DEVNET · PRE-AUDIT" />
          <Meta label="LICENSE"  value="OPEN" />
          <Meta label="REVISION" value="v0.1" />
        </div>
      </div>

      {/* ── Body grid: TOC sidebar + content ──────────────────────────── */}
      <div style={{
        maxWidth: 1180, margin: "0 auto", padding: "48px 28px 96px",
        display: "grid", gridTemplateColumns: "240px 1fr", gap: 56,
      }}>
        {/* ── TOC ───────────────────────────────────────────────────── */}
        <aside style={{ position: "sticky", top: 76, alignSelf: "start" }}>
          <div style={{
            fontFamily: fontMono, fontSize: 10.5, letterSpacing: ".22em",
            color: t.mute, textTransform: "uppercase", marginBottom: 18,
            paddingBottom: 10, borderBottom: `1px solid ${t.line}`,
          }}>CONTENTS</div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {TOC.map((item) => {
              const isActive = active === item.id;
              return (
                <li key={item.id} style={{ margin: "5px 0" }}>
                  <a href={`#${item.id}`} style={{
                    display: "grid", gridTemplateColumns: "32px 1fr", gap: 8,
                    textDecoration: "none", padding: "5px 0",
                    fontFamily: fontSans, fontSize: 13.5, lineHeight: 1.4,
                    color: isActive ? t.ink : t.mute,
                    fontWeight: isActive ? 600 : 400,
                    borderLeft: isActive ? `2px solid ${t.ink}` : "2px solid transparent",
                    paddingLeft: 10,
                    transition: "color 0.15s",
                  }}>
                    <span style={{ fontFamily: fontMono, fontSize: 11, color: t.fade }}>{item.n}</span>
                    <span>{item.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* ── Content column ─────────────────────────────────────────── */}
        <main style={{ maxWidth: 760 }}>

          {/* ─ 00 Abstract ─ */}
          <H2 id="abstract" n="00">Abstract</H2>
          <P>
            Veil is an over-collateralised lending protocol on Solana. It accepts SPL tokens as collateral natively and is designed to extend, without bridging, to native Bitcoin and Ethereum via Ika MPC <Em>dWallets</Em>, and to physical gold via Oro&apos;s GRAIL settlement layer. Each position can opt into amount-private accounting backed by Encrypt&apos;s REFHE construction; plaintext health checks remain the authoritative solvency rule. The on-chain program is implemented in <Code>Pinocchio 0.11.1</Code> for low compute-unit overhead. A two-slope kink interest-rate model, index-based share accounting, and an Aave-style liquidation engine (close factor, liquidation bonus, protocol fee) provide the economic backbone. An off-chain allowlist on Neon Postgres curates which wallets are permitted to act as <Em>pool administrators</Em> for new markets; on-chain administrative authority is independently bound to <Code>LendingPool.authority</Code>.
          </P>
          <Note>
            This document is the canonical source-grounded specification.
            Every formula, parameter, and PDA seed appears in
            <Code>programs/src/</Code> with the cited path.
            Nothing is paraphrased without source.
          </Note>

          {/* ─ 01 Introduction ─ */}
          <H2 id="introduction" n="01">Introduction</H2>
          <H3>1.1 Two structural blockers in DeFi lending</H3>
          <P>
            Two forces keep institutional and high-net-worth capital out of on-chain credit markets. <Em>Liquidity fragmentation across chains</Em>: the largest pools of value sit in native Bitcoin, native Ethereum, and physical gold. Bringing any of these into a Solana lending market today requires bridging or wrapping — introducing custody risk, smart-contract risk, and trusted multi-sigs. <Em>Position transparency</Em>: Aave and Compound disclose every user&apos;s collateral, debt, liquidation price, and strategy on a public ledger. For market makers, treasuries, and funds, this leaks inventory and invites front-running.
          </P>
          <H3>1.2 Veil&apos;s response</H3>
          <P>Veil tackles both at the protocol layer rather than the wrapper layer:</P>
          <Numbered no="01" title="Native collateral via MPC dWallets">
            Ika&apos;s dwallet accounts can be placed under the joint signing authority of a Solana program PDA and the Ika MPC committee. Veil is the Solana side of that pairing — a borrow on Solana is simultaneously authorised against native Bitcoin or Ethereum collateral. No bridge contract holds the underlying asset.
          </Numbered>
          <Numbered no="02" title="Per-position privacy via FHE">
            When a user enables privacy, balances are stored as ciphertext handles and arithmetic happens homomorphically. Solvency is still enforced — the program receives a plaintext boolean <Code>healthy?</Code> from the FHE evaluator, never the underlying amounts.
          </Numbered>
          <Numbered no="03" title="Pinocchio core for predictable compute">
            Borrow checks, liquidation math, and oracle reads run in a few thousand compute units. Pinocchio&apos;s zero-copy account access avoids Anchor&apos;s deserialisation overhead.
          </Numbered>
          <Numbered no="04" title="Curated, not gated">
            Liquidation, oracle refresh, and all user state mutations are permissionless. Pool initialisation is curated through an off-chain allowlist (Section 7); on-chain authority is independently bound at Initialize time.
          </Numbered>

          {/* ─ 02 Design principles ─ */}
          <H2 id="design-principles" n="02">Design Principles</H2>
          <Table head={["Principle", "Concretely"]} rows={[
            [<Em key="1">Native, not synthetic, collateral</Em>, <span key="2">Ika dWallets remain the user&apos;s; Veil controls signing while the position is open. Source: <Code>programs/src/instructions/ika_register.rs</Code>.</span>],
            [<Em key="1">Plaintext solvency, optional opacity</Em>, <span key="2"><Code>UserPosition</Code> is always authoritative. <Code>EncryptedPosition</Code> is a parallel mirror. Health checks never depend on encrypted state being decryptable.</span>],
            [<Em key="1">Compute-bounded</Em>, <span key="2">The hot paths (deposit / withdraw / borrow / repay) accrue interest, do at most one HF check, transfer tokens, and update u128 fields — no per-position storage walks.</span>],
            [<Em key="1">Permissionless where it can be, gated where it must be</Em>, <span key="2">Liquidation, oracle refresh, and all user state mutations are permissionless. Pool initialisation is curated through an off-chain allowlist.</span>],
            [<Em key="1">Atomic state machines for risky primitives</Em>, <span key="2">Flash loans use a single-tx in-flight counter; missing repay reverts everything.</span>],
          ]} />

          {/* ─ 03 System overview ─ */}
          <H2 id="system-overview" n="03">System Overview</H2>
          <H3>3.1 Components</H3>
          <Pre>{`┌──────────────────────────────────────────────────────────────────────┐
│                            Veil Program                              │
│                       (Pinocchio 0.11.1, no_std)                     │
│                                                                      │
│   LendingPool ←→ UserPosition         EncryptedPosition (optional)   │
│   (1 / mint)    (1/user/pool)         (1/user/pool)                  │
│       │                                                              │
│       │   oracle_price, oracle_conf cached on every UpdateOracle     │
│       ▼                                                              │
│   Pyth legacy push-oracle account (per pool, address-anchored)       │
│                                                                      │
│   Cross-chain collateral                                             │
│   IkaDwalletPosition ───CPI──→ Ika dWallet program                   │
└──────────────────────────────────────────────────────────────────────┘
              ▲                                  ▲
              │ tx submission (web3.js)          │ permissionless reads
              │                                  │
   Next.js dApp + admin panel ────────────→  Neon Postgres
   (/dapp, /dapp/admin, /dapp/liquidate)    (allowlist, tx_log, cache,
                                             positions, auth_nonces)`}</Pre>
          <H3>3.2 Roles</H3>
          <Table head={["Role", "What they can do", "Enforcement"]} rows={[
            ["User", "Deposit, withdraw, borrow, repay, enable privacy", <Mono key="1">signer == UserPosition.owner</Mono>],
            ["Liquidator", "Repay debt of unhealthy positions and seize collateral", "Permissionless on-chain (no role check, only HF condition)"],
            ["Pool Admin", "Initialize a pool; update params, pause/resume, collect fees on pools they authorise", <span key="1"><Mono>signer == pool.authority</Mono> on chain · in <Code>pool_admins</Code> off chain</span>],
            ["Super-admin", "Curate the off-chain allowlist", <Mono key="1">role == &apos;super_admin&apos;</Mono>],
          ]} />
          <Note>
            An attacker who bypasses the curated UI can still call <Code>Initialize</Code> directly with their own wallet as <Code>authority</Code>. The pool that results is not registered in Veil&apos;s index and has no relationship to canonical pools. The off-chain allowlist gates <Em>which pools Veil considers canonical</Em> — not the on-chain instruction itself.
          </Note>

          {/* ─ 04 On-chain state ─ */}
          <H2 id="on-chain-state" n="04">On-Chain State</H2>
          <P>
            All accounts are <Code>#[repr(C)]</Code> zero-copy structs. They are read by direct raw pointer cast (Pinocchio idiom). The first eight bytes are an ASCII discriminator; subsequent fields are little-endian on Solana&apos;s BPF target.
          </P>
          <H3>4.1 LendingPool — 416 bytes</H3>
          <P>One per token market. PDA seeds: <Code>[b&quot;pool&quot;, token_mint]</Code>.</P>
          <Table head={["Off", "Sz", "Field", "Notes"]} rows={[
            [<Mono key="1">0</Mono>, "8",  <Code key="2">discriminator</Code>, <Mono key="3">b&quot;VEILPOOL&quot;</Mono>],
            [<Mono key="1">8</Mono>, "32", <Code key="2">authority</Code>, "Admin set at Initialize"],
            [<Mono key="1">40</Mono>, "32", <Code key="2">token_mint</Code>, "—"],
            [<Mono key="1">72</Mono>, "32", <Code key="2">vault</Code>, "ATA owned by PoolAuthority PDA"],
            [<Mono key="1">104</Mono>, "8", <Code key="2">total_deposits</Code>, "Virtual; grows with depositor interest"],
            [<Mono key="1">112</Mono>, "8", <Code key="2">total_borrows</Code>, "Virtual; grows with borrower interest"],
            [<Mono key="1">120</Mono>, "8", <Code key="2">accumulated_fees</Code>, "Protocol reserves owed to authority"],
            [<Mono key="1">128</Mono>, "8", <Code key="2">last_update_timestamp</Code>, "Unix seconds"],
            [<Mono key="1">139</Mono>, "1", <Code key="2">paused</Code>, "0 active · 1 paused"],
            [<Mono key="1">144</Mono>, "16", <Code key="2">borrow_index</Code>, "u128 WAD; init = WAD"],
            [<Mono key="1">160</Mono>, "16", <Code key="2">supply_index</Code>, "u128 WAD; init = WAD"],
            [<Mono key="1">176-320</Mono>, "16×9", "rate + risk params", "base_rate, opt_util, slope1/2, reserve_factor, ltv, liq_threshold, liq_bonus, protocol_liq_fee, close_factor"],
            [<Mono key="1">336</Mono>, "8", <Code key="2">flash_loan_amount</Code>, "Non-zero ⇔ flash in flight"],
            [<Mono key="1">344</Mono>, "8", <Code key="2">flash_fee_bps</Code>, "Default 9 bps"],
            [<Mono key="1">352</Mono>, "32", <Code key="2">pyth_price_feed</Code>, "Anchored on first update"],
            [<Mono key="1">384-400</Mono>, "20", "oracle_price · oracle_conf · oracle_expo", "Last validated price snapshot"],
          ]} />
          <P>Source: <Code>programs/src/state/lending_pool.rs:46-100</Code>; <Code>SIZE = 416</Code> at line 114.</P>

          <H3>4.2 UserPosition — 144 bytes</H3>
          <P>One per (user, pool). PDA seeds: <Code>[b&quot;position&quot;, pool, user]</Code>. Source: <Code>programs/src/instructions/deposit.rs:82,94</Code>.</P>
          <Table head={["Off", "Sz", "Field"]} rows={[
            [<Mono key="1">0</Mono>, "8", <span key="2"><Code>discriminator</Code> = <Mono>b&quot;VEILPOS!&quot;</Mono></span>],
            [<Mono key="1">8</Mono>, "32", <Code key="2">owner</Code>],
            [<Mono key="1">40</Mono>, "32", <Code key="2">pool</Code>],
            [<Mono key="1">72</Mono>, "8", <Code key="2">deposit_shares</Code>],
            [<Mono key="1">80</Mono>, "8", <Code key="2">borrow_principal</Code>],
            [<Mono key="1">96</Mono>, "16", <Code key="2">deposit_index_snapshot</Code>],
            [<Mono key="1">112</Mono>, "16", <Code key="2">borrow_index_snapshot</Code>],
          ]} />

          <H3>4.3 EncryptedPosition — 144 bytes</H3>
          <P>Optional, created by <Code>EnablePrivacy</Code>. Seeds: <Code>[b&quot;enc_pos&quot;, owner, pool]</Code>. Holds two ciphertext-account pubkeys (<Code>enc_deposit</Code>, <Code>enc_debt</Code>) on the Encrypt program.</P>

          <H3>4.4 IkaDwalletPosition — 128 bytes</H3>
          <P>Tracks a registered Ika dWallet pledged as collateral. Seeds: <Code>[b&quot;ika_pos&quot;, pool, user]</Code>. Status field tracks <Code>ACTIVE | RELEASED | LIQUIDATED</Code>.</P>

          {/* ─ 05 Math spec ─ */}
          <H2 id="math-spec" n="05">Mathematical Specification</H2>
          <P>
            All rates and indices live in <Em>WAD</Em> space, where <Code>WAD = 10¹⁸ = 1.0</Code>. Token amounts are <Code>u64</Code> in their native units; they are widened to <Code>u128</Code> only inside arithmetic and narrowed back at the boundary. All formulas in this section appear verbatim in <Code>programs/src/math.rs</Code>.
          </P>
          <H3>5.1 Constants</H3>
          <Pre>{`WAD               = 1_000_000_000_000_000_000      // math.rs:16
SECONDS_PER_YEAR  = 31_536_000                     // math.rs:19

BASE_RATE         = WAD / 100         ≈  1 % apr   // math.rs:23
OPTIMAL_UTIL      = WAD * 80 / 100    =  80 %      // math.rs:24
SLOPE1            = WAD *  4 / 100    =   4 % apr  // math.rs:25
SLOPE2            = WAD * 75 / 100    =  75 % apr  // math.rs:26
RESERVE_FACTOR    = WAD / 10          =  10 %      // math.rs:27
LTV               = WAD * 75 / 100    =  75 %      // math.rs:28
LIQ_THRESHOLD     = WAD * 80 / 100    =  80 %      // math.rs:29
LIQ_BONUS         = WAD *  5 / 100    =   5 %      // math.rs:30
PROTOCOL_LIQ_FEE  = WAD / 10          =  10 % of bonus
CLOSE_FACTOR      = WAD / 2           =  50 %
FLASH_FEE_BPS     = 9                 ≈ 0.09 %     // math.rs:35
FLASH_PROTOCOL_SHARE_BPS = 10
FLASH_LP_SHARE_BPS       = 90`}</Pre>

          <H3>5.2 Borrow rate (two-slope kink)</H3>
          <Pre>{`             ⎧ R₀ + (U / U_opt) × S₁                          if U ≤ U_opt
borrow_rate =⎨
             ⎩ R₀ + S₁ + ((U − U_opt) / (1 − U_opt)) × S₂      if U > U_opt`}</Pre>
          <P>Source: <Code>programs/src/math.rs:76-102</Code>. Properties verified by tests <Code>borrow_rate_at_kink</Code>, <Code>borrow_rate_above_kink_full</Code>, <Code>borrow_rate_monotonically_increasing</Code> (math.rs:374-417).</P>
          <Table head={["Utilisation", "Borrow rate (default)"]} rows={[
            ["0 %", "1 %"], ["40 %", "3 %"], ["80 % (kink)", "5 %"],
            ["90 %", "42.5 %"], ["100 %", "80 %"],
          ]} />

          <H3>5.3 Supply rate</H3>
          <Pre>{`supply_rate = borrow_rate × U × (1 − reserve_factor)   // math.rs:104-115`}</Pre>

          <H3>5.4 Index accrual</H3>
          <P>
            Simple interest within a single accrual call; calls compose into compound interest across blocks. Per call, with elapsed <Code>Δt</Code> seconds:
          </P>
          <Pre>{`borrow_index_new = borrow_index × (1 + borrow_rate × Δt / SECONDS_PER_YEAR)
supply_index_new = supply_index × (1 + supply_rate × Δt / SECONDS_PER_YEAR)`}</Pre>

          <H3>5.5 Health factor</H3>
          <Pre>{`HF = (deposit_balance × liquidation_threshold) / debt_balance     (WAD)
HF = u128::MAX                if debt_balance == 0                // math.rs:201-211`}</Pre>
          <P>A position is liquidatable iff <Code>HF &lt; WAD</Code>. The boundary is exact: <Code>HF == WAD</Code> is <Em>not</Em> liquidatable.</P>

          <H3>5.6 Liquidation</H3>
          <Pre>{`repay_amount      = current_debt × close_factor                ≤ 50 %
seized_collateral = repay_amount × (1 + liquidation_bonus)     +5 % bonus
protocol_fee      = seized_collateral × protocol_liq_fee       10 % cut
liquidator_gets   = seized_collateral − protocol_fee`}</Pre>

          <H3>5.7 Flash-loan economics</H3>
          <Pre>{`fee = amount × flash_fee_bps / 10_000                            // math.rs:223-230
(lp_portion, protocol_portion) = (fee − fee/10,  fee/10)         // math.rs:234-238`}</Pre>
          <P>The 10 % protocol cut is integer-divided first; the LP portion takes the remainder. <Code>total_deposits</Code> grows by <Code>lp_portion</Code>; <Code>accumulated_fees</Code> grows by <Code>protocol_portion</Code>.</P>

          {/* ─ 06 Instructions ─ */}
          <H2 id="instructions" n="06">Instruction Specification</H2>
          <P>The dispatcher is a single-byte switch on <Code>data[0]</Code>: <Code>programs/src/entrypoint.rs:28-50</Code>. There is no Anchor 8-byte hash. All <Code>u64</Code> fields are little-endian; all <Code>u128</Code> fields are little-endian (low 8 bytes followed by high 8 bytes).</P>
          <Table head={["Disc", "Instruction", "Signer", "On-chain auth check"]} rows={[
            [<Mono key="1">0x00</Mono>, "Initialize", "payer + authority", "none — caller becomes pool authority"],
            [<Mono key="1">0x01</Mono>, "Deposit", "user", <Mono key="2">user == position.owner</Mono>],
            [<Mono key="1">0x02</Mono>, "Withdraw", "user", "+ HF ≥ 1 if debt > 0"],
            [<Mono key="1">0x03</Mono>, "Borrow", "user", "LTV; HF ≥ 1; not paused"],
            [<Mono key="1">0x04</Mono>, "Repay", "user", "—"],
            [<Mono key="1">0x05</Mono>, "Liquidate", "liquidator", "borrower HF < 1"],
            [<Mono key="1">0x06</Mono>, "FlashBorrow", "borrower", "not paused; no active flash"],
            [<Mono key="1">0x07</Mono>, "FlashRepay", "borrower", "active flash; repay ≥ amount + fee"],
            [<Mono key="1">0x08</Mono>, "EnablePrivacy", "user", "user == position.owner"],
            [<Mono key="1">0x09–0x0C</Mono>, "Private*", "user", "as plaintext + binding"],
            [<Mono key="1">0x0D</Mono>, "UpdatePool", "authority", <Mono key="2">signer == pool.authority</Mono>],
            [<Mono key="1">0x0E</Mono>, "PausePool", "authority", "ditto"],
            [<Mono key="1">0x0F</Mono>, "ResumePool", "authority", "ditto"],
            [<Mono key="1">0x10</Mono>, "CollectFees", "authority", "ditto"],
            [<Mono key="1">0x11</Mono>, "IkaRegister", "user", "dwallet authority == Veil CPI PDA"],
            [<Mono key="1">0x12</Mono>, "IkaRelease", "user", "signer == ika_position.owner"],
            [<Mono key="1">0x13</Mono>, "IkaSign", "user", "owner; status == Active"],
            [<Mono key="1">0x14</Mono>, "UpdateOraclePrice", "—", "feed match if anchored"],
          ]} />

          {/* ─ 07 Authorization ─ */}
          <H2 id="authorization" n="07">Authorization Model</H2>
          <P>Veil splits authorization into <Em>two independent layers</Em> that must both be satisfied to administer a canonical pool through the curated UI:</P>
          <Numbered no="01" title="On-chain authority">
            Encoded in <Code>LendingPool.authority</Code> at offset 8 of every pool account. Set once by <Code>Initialize</Code> to the second signer. Update / Pause / Resume / CollectFees enforce <Code>signer == pool.authority</Code> on every call, returning <Code>Unauthorized</Code> (6021) otherwise.
          </Numbered>
          <Numbered no="02" title="Off-chain pool-creation allowlist">
            Stored in Neon Postgres in <Code>pool_admins</Code>. Gates which wallets the canonical UI permits to start the on-chain Initialize flow, and which wallets can manage the allowlist itself.
          </Numbered>
          <H3>7.1 Signed-nonce handshake</H3>
          <Pre>{`1.  UI POSTs /api/auth/nonce {pubkey, action}
    Server returns a 16-byte hex nonce + canonical message:
       "Veil admin auth\\nAction: <action>\\nNonce: <nonce>"
    TTL: 5 minutes. Stored in auth_nonces.
2.  Wallet signs the exact bytes (ed25519 detached signature).
3.  UI POSTs the protected endpoint with {actor, nonce, signature, …}.
4.  Server:
    a. verifies signature over the canonical message     (TweetNaCl)
    b. atomically DELETE … RETURNING the nonce row       (single use)
    c. checks pool_admins membership and revoked_at      (registry)
    d. if requireRole == 'super_admin', enforces role    (privilege)`}</Pre>
          <P>Source: <Code>veil-landing/lib/auth/admin.ts:21-66</Code>.</P>

          {/* ─ 08 Oracle ─ */}
          <H2 id="oracle" n="08">Oracle Subsystem</H2>
          <P>Veil reads Pyth legacy push-oracle accounts directly without the Pyth SDK. The per-call validation pipeline:</P>
          <Pre>{`1. data.len() ≥ 228         → else OracleInvalid       (6024)
2. magic == 0xa1b2c3d4      → else OracleInvalid
3. atype == 3 (Price)       → else OracleInvalid
4. agg.price > 0            → else OracleInvalid
5. agg.status == 1          → else OraclePriceStale   (6025)
6. agg.conf ≤ price / 50    → else OracleConfTooWide  (6027)`}</Pre>
          <P>After the first successful update, <Code>pool.pyth_price_feed</Code> records the feed account address; subsequent calls with a different feed return <Code>OraclePriceFeedMismatch</Code> (6026). The 2 % confidence cap is the load-bearing defence against flash-loan-driven oracle manipulation: during such an attack Pyth&apos;s aggregation widens the confidence interval before the aggregate price is fully deflected.</P>

          {/* ─ 09 Privacy ─ */}
          <H2 id="privacy" n="09">Privacy Subsystem (FHE)</H2>
          <P>Privacy is opt-in per (user, pool). <Code>EnablePrivacy</Code> creates an <Code>EncryptedPosition</Code> PDA and two ciphertext accounts on the Encrypt program, seeded with the user&apos;s current plaintext deposit and debt. The four <Code>Private*</Code> instructions (<Mono>0x09–0x0C</Mono>) replicate the plaintext flow and emit Encrypt CPIs that update ciphertexts homomorphically.</P>
          <Table head={["Hidden", "Not hidden"]} rows={[
            ["Post-EnablePrivacy deposit / borrow / repay / withdraw amounts", "That an EncryptedPosition PDA exists"],
            ["Current encrypted balances", "That a private instruction was called"],
            ["", "The pool, the wallet address, the timing"],
          ]} />
          <P><Em>Solvency under FHE.</Em> Health checks run homomorphically. The Encrypt evaluator returns a plaintext boolean (<Code>healthy?</Code>) to Veil, which decides whether to allow the borrow or withdraw. Underlying balances are never decrypted on-chain.</P>
          <Note>
            Implementation status (v0.1): all five private instructions compile and route correctly. The Encrypt SDK currently targets Pinocchio 0.10.x while Veil targets 0.11.x — <Code>execute_graph</Code> CPIs are stubbed pending the SDK update. The plaintext path is fully functional today.
          </Note>

          {/* ─ 10 Cross-chain ─ */}
          <H2 id="cross-chain" n="10">Cross-Chain Collateral (Ika dWallet)</H2>
          <P>An Ika dWallet is a programmable signing primitive: an MPC-managed key governed by a programmable authority address. Veil registers a dWallet by verifying that its on-chain authority field equals Veil&apos;s CPI authority PDA (<Code>[b&quot;__ika_cpi_authority&quot;]</Code> on Veil&apos;s program ID, <Code>programs/src/ika/mod.rs:67</Code>). While registered, the dWallet can only sign when Veil approves the message via <Code>IkaSign</Code>.</P>
          <Table head={["Curve", "Value", "Use"]} rows={[
            ["SECP256K1", <Mono key="1">0</Mono>, "Bitcoin, Ethereum"],
            ["SECP256R1", <Mono key="1">1</Mono>, "WebAuthn"],
            ["CURVE25519", <Mono key="1">2</Mono>, "Solana, Ed25519"],
            ["RISTRETTO", <Mono key="1">3</Mono>, "Substrate / sr25519"],
          ]} />
          <P><Code>IkaRelease</Code> returns the dWallet to the user iff the position is <Code>ACTIVE</Code> (not <Code>LIQUIDATED</Code>). A liquidated dWallet remains under Veil&apos;s control for recovery by the liquidator.</P>

          {/* ─ 11 Off-chain ─ */}
          <H2 id="off-chain" n="11">Off-Chain Infrastructure</H2>
          <H3>11.1 Web stack</H3>
          <Table head={["Route", "Purpose"]} rows={[
            ["/", "Marketing landing"],
            ["/dapp", "Markets — deposit / borrow / repay / withdraw / flash"],
            ["/dapp/liquidate", "Permissionless liquidation UI"],
            ["/dapp/admin", "Allowlisted admin panel (Manage / Initialize / Allowlist)"],
            ["/workflow", "End-to-end actor & instruction overview"],
            ["/whitepaper", "This document"],
            ["/api/*", "HTTP API"],
          ]} />
          <H3>11.2 Postgres tables</H3>
          <Table head={["Table", "Purpose"]} rows={[
            [<Code key="1">pool_admins</Code>, "Off-chain allowlist (pool_admin, super_admin)"],
            [<Code key="1">pools</Code>, "Cached on-chain LendingPool state"],
            [<Code key="1">positions</Code>, "Cached UserPosition snapshots with derived health_factor_wad"],
            [<Code key="1">tx_log</Code>, "Append-only signature log keyed on Solana tx signature"],
            [<Code key="1">audit_log</Code>, "Admin actions (allowlist edits, pool inits, fee collections)"],
            [<Code key="1">auth_nonces</Code>, "Single-use ed25519 nonces"],
          ]} />

          {/* ─ 12 Threat model ─ */}
          <H2 id="threat-model" n="12">Threat Model</H2>
          <Table head={["Vector", "Mitigation"]} rows={[
            ["Feed substitution", "First update anchors pyth_price_feed; mismatches reject"],
            ["Flash-loan price manipulation", "2 % confidence-interval cap"],
            ["Stale halted feed", "agg.status == 1 enforced"],
            ["Negative / zero price", "Rejected before cache write"],
            ["Crafted non-Pyth account", "magic + atype + length checks"],
            ["Liquidation MEV", "Permissionless; 50 % close factor admits competition"],
            ["Flash reentrancy", "flash_loan_amount counter; tx atomicity"],
            ["dWallet authority compromise", "Veil signs only what owner submits; no inspection"],
            ["Off-chain DB compromise", "On-chain pool.authority is independent"],
            ["FHE side-channels", "Amount privacy only — not address privacy"],
            ["Admin without timelock", "Production must front the authority with multisig + governance"],
          ]} />

          {/* ─ 13 Comparison ─ */}
          <H2 id="comparison" n="13">Comparison: Aave V3</H2>
          <Table head={["Property", "Aave V3", "Veil v0.1"]} rows={[
            ["Chain", "EVM", "Solana (Pinocchio)"],
            ["Account model", "One Pool contract w/ many reserves", "One PDA per token"],
            ["Discriminator", "4-byte function selector", "1-byte instruction tag"],
            ["Interest model", "Two-slope kink", "Two-slope kink (identical math)"],
            ["Index basis", <Mono key="1">RAY (1e27)</Mono>, <Mono key="1">WAD (1e18)</Mono>],
            ["Health factor", "Σ collateral × LT / Σ debt", "collateral × LT / debt, single-asset position"],
            ["Close factor", "50 % default", "50 % default"],
            ["Liquidation bonus", "Per-asset config", "Per-pool config (default 5 %)"],
            ["Flash loans", "flashLoan / Simple, 5 bps", "Single primitive, 9 bps default"],
            ["Cross-chain collateral", "Wrapped tokens", "Native via Ika dWallet"],
            ["Privacy", "None", "Optional FHE (REFHE)"],
            ["Admin", "PoolAdmin / RiskAdmin / governance", "pool.authority + optional off-chain allowlist"],
          ]} />

          {/* ─ 14 Roadmap ─ */}
          <H2 id="roadmap" n="14">Roadmap</H2>
          <Table head={["Item", "Status"]} rows={[
            ["Pinocchio core (21 ix)", "Done"],
            ["TypeScript SDK", "Done"],
            ["Off-chain allowlist + auth", "Done"],
            ["Neon-backed pool/position cache", "Done"],
            ["Liquidation UI", "Done"],
            ["Encrypt SDK pinocchio 0.11 wiring", "Pending Encrypt SDK release"],
            ["Pyth pull-oracle migration", "Roadmapped"],
            ["Ika dWallet mainnet integration", "Pending Ika v1"],
            ["Oro/GRAIL gold pool", "Pending Oro public deployment"],
            ["Cross-asset (multi-collateral) positions", "v1"],
            ["Audit", "Pre-mainnet"],
            ["Mainnet deploy", "Pre-mainnet"],
          ]} />

          {/* ─ 15 References ─ */}
          <H2 id="references" n="15">References</H2>
          <ol style={{
            listStyle: "none", counterReset: "ref", padding: 0, margin: 0,
            fontFamily: fontSans, fontSize: 13.5, lineHeight: 1.7, color: t.cite,
          }}>
            {[
              ["Aave V3", "Whitepaper. Two-slope kink interest model, close-factor and liquidation-bonus design."],
              ["Compound V2", "Earliest production deployment of the index-based share-accounting model."],
              ["Pinocchio", <span key="1">Solana zero-copy program framework. <Mono>github.com/febo/pinocchio</Mono></span>],
              ["Pyth Network", <span key="1">Push-oracle aggregation across publishers. <Mono>pyth.network</Mono></span>],
              ["Ika dWallet protocol", <span key="1">Programmable MPC signing for cross-chain assets. <Mono>github.com/dwallet-labs/ika</Mono></span>],
              ["Encrypt FHE / REFHE", <span key="1">Fully-homomorphic-encryption construction used for amount privacy. <Mono>docs.encrypt.xyz</Mono></span>],
              ["Oro / GRAIL", <span key="1">Physical-gold settlement layer. <Mono>docs.grail.oro.finance</Mono></span>],
              ["Veil program source", <Mono key="1">programs/src/</Mono>],
              ["Veil dApp + API", <Mono key="1">veil-landing/</Mono>],
              ["Veil docs site", <Mono key="1">docs/content/</Mono>],
            ].map(([title, body], i) => (
              <li key={i} style={{
                display: "grid", gridTemplateColumns: "44px 1fr", gap: 12,
                padding: "10px 0", borderBottom: `1px solid ${t.hairSoft}`,
              }}>
                <span style={{ fontFamily: fontMono, color: t.fade, fontSize: 12 }}>
                  [{String(i + 1).padStart(2, "0")}]
                </span>
                <span>
                  <span style={{ color: t.ink, fontWeight: 600 }}>{title}</span>
                  {" — "}
                  <span>{body}</span>
                </span>
              </li>
            ))}
          </ol>

          {/* ─ Footer CTA ─ */}
          <div style={{ marginTop: 80, paddingTop: 32, borderTop: `1px solid ${t.line}` }}>
            <div style={{
              fontFamily: fontMono, fontSize: 11, letterSpacing: ".22em",
              color: t.mute, textTransform: "uppercase", marginBottom: 18,
            }}>END OF DOCUMENT</div>
            <h3 style={{
              fontFamily: fontSerif, fontSize: 32, lineHeight: 1.1,
              letterSpacing: "-0.025em", fontWeight: 400, color: t.ink,
              margin: "0 0 24px",
            }}>Continue from theory to chain.</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <CTA href="/dapp" primary>OPEN THE APP →</CTA>
              <CTA href="/workflow">EXPLORE WORKFLOW</CTA>
              <CTA href="/dapp/admin">ADMIN PANEL</CTA>
              <CTA href="/">BACK HOME</CTA>
            </div>
          </div>
        </main>
      </div>

      {/* ── Page footer ─────────────────────────────────────────────── */}
      <footer style={{ borderTop: `1px solid ${t.hair}`, padding: "32px 28px", marginTop: 64, background: t.paperEdge }}>
        <div style={{
          maxWidth: 1180, margin: "0 auto", display: "flex",
          alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16,
        }}>
          <div style={{ fontFamily: fontMono, fontSize: 11, letterSpacing: ".22em",
            color: t.mute, textTransform: "uppercase" }}>
            VEIL · WHITEPAPER · v0.1 · 2026
          </div>
          <div style={{ fontFamily: fontMono, fontSize: 11, letterSpacing: ".18em",
            color: t.fade, textTransform: "uppercase" }}>
            Source-grounded · Pre-audit · Devnet
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: "16px 18px", borderRight: `1px solid ${t.hair}`,
    }}>
      <div style={{
        fontFamily: fontMono, fontSize: 9.5, letterSpacing: ".22em",
        textTransform: "uppercase", color: t.mute, marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontFamily: fontMono, fontSize: 12.5, letterSpacing: ".05em",
        color: t.ink, fontWeight: 600,
      }}>{value}</div>
    </div>
  );
}

const navLinkStyle: CSSProperties = {
  fontFamily: fontMono, fontSize: 11, letterSpacing: ".22em",
  textTransform: "uppercase", color: t.text, textDecoration: "none",
};

function CTA({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <Link href={href} style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "12px 22px",
      fontFamily: fontMono, fontSize: 11.5, letterSpacing: ".22em",
      textTransform: "uppercase", fontWeight: 600,
      textDecoration: "none",
      border: `1px solid ${t.line}`,
      background: primary ? t.ink : "transparent",
      color: primary ? t.paper : t.ink,
      borderRadius: 0,
      transition: "background 120ms, color 120ms",
    }}>{children}</Link>
  );
}
