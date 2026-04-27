"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/* ════════════════════════════════════════════════════════════════════════════
   VEIL PROTOCOL · WHITEPAPER (technical spec — Stellaray-style chassis)

   Standalone route — does not inherit Nextra docs chrome. Uses local fonts
   and inline styles for visual independence. Every formula and parameter
   below is cited line-for-line against `programs/src/`.
   ════════════════════════════════════════════════════════════════════════════ */

// ─── Tokens (paper, ink, hairlines, monospace-first) ────────────────────────

const t = {
  paper:     "#f6f5ee",
  paperEdge: "#ecebde",
  card:      "#fbfaf3",
  ink:       "#0b0b10",
  ink2:      "#1c1d23",
  text:      "#26272d",
  mute:      "#6c6f78",
  fade:      "#9da0a8",
  hair:      "#d2cfc1",
  hairSoft:  "#e2dfd0",
  hairFaint: "#ecead9",
  line:      "#0b0b10",
  cream:     "#efedda",
  cite:      "#5b5e66",
  cyan:      "#005e6b", // RFC-style accent
  sun:       "#a05a00",
  ok:        "#0b6b3a",
  warn:      "#a04200",
  err:       "#9b1e1e",
};

const fSans  = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const fSerif = "'Iowan Old Style', 'Apple Garamond', Georgia, 'Times New Roman', serif";
const fMono  = "ui-monospace, SFMono-Regular, 'JetBrains Mono', 'Menlo', 'Consolas', monospace";

// ─── TOC structure ──────────────────────────────────────────────────────────

type TocItem = { id: string; n: string; title: string };
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
  { id: "api",                 n: "12", title: "HTTP API" },
  { id: "threat-model",        n: "13", title: "Threat Model · Ultrathink" },
  { id: "comparison",          n: "14", title: "Comparison: Aave V3" },
  { id: "roadmap",             n: "15", title: "Roadmap & Open Items" },
  { id: "errors",              n: "16", title: "Appendix A · Error Codes" },
  { id: "external-ids",        n: "17", title: "Appendix B · External IDs" },
  { id: "references",          n: "18", title: "References" },
];

// ─── Reading-progress + active section hooks ────────────────────────────────

const useReadingProgress = (): number => {
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
};

const useActiveSection = (ids: string[]): string => {
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
};

const useIsMobile = (breakpoint = 768): boolean => {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return mobile;
};

const MobileCtx = createContext(false);
const useMobile = () => useContext(MobileCtx);

// ─── Atoms ──────────────────────────────────────────────────────────────────

const Mono = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => {
  return <span style={{ fontFamily: fMono, ...style }}>{children}</span>;
};

const SectionLabel = ({ n, tag }: { n: string; tag?: string }) => {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      fontFamily: fMono, fontSize: 11, letterSpacing: ".22em",
      color: t.mute, textTransform: "uppercase", marginBottom: 12,
    }}>
      <span>§&nbsp;{n}</span>
      {tag && <span style={{
        padding: "2px 7px", border: `1px solid ${t.hair}`,
        background: t.cream, color: t.ink, fontSize: 10, letterSpacing: ".18em",
      }}>{tag}</span>}
      <span style={{ flex: 1, height: 1, background: t.hair }} />
      <span style={{ color: t.fade, fontSize: 10 }}>{n}.0</span>
    </div>
  );
};

const H2 = ({ id, n, children, tag }: { id: string; n: string; children: ReactNode; tag?: string }) => {
  const m = useMobile();

  return (
    <section id={id} style={{ scrollMarginTop: 90, marginTop: m ? 40 : 64 }}>
      <SectionLabel n={n} tag={tag} />
      <h2 style={{
        fontFamily: fSerif, fontWeight: 400,
        fontSize: m ? 26 : 38, lineHeight: 1.1, letterSpacing: "-0.022em",
        color: t.ink, margin: "0 0 22px",
      }}>
        {children}
      </h2>
    </section>
  );
};

const H3 = ({ children, n }: { children: ReactNode; n?: string }) => {
  return (
    <h3 style={{
      fontFamily: fSans, fontWeight: 600,
      fontSize: 16.5, letterSpacing: "-0.005em",
      color: t.ink, margin: "32px 0 10px",
    }}>
      {n && <span style={{ fontFamily: fMono, color: t.mute, marginRight: 8, fontWeight: 400 }}>{n}</span>}
      {children}
    </h3>
  );
};

const P = ({ children }: { children: ReactNode }) => {
  return (
    <p style={{
      fontFamily: fSans, fontSize: 15, lineHeight: 1.75,
      color: t.text, margin: "0 0 16px", textWrap: "pretty" as const,
    }}>{children}</p>
  );
};

const Em = ({ children }: { children: ReactNode }) => {
  return <em style={{ fontFamily: fSerif, fontStyle: "italic", color: t.ink2 }}>{children}</em>;
};

const Code = ({ children }: { children: ReactNode }) => {
  return (
    <code style={{
      fontFamily: fMono, fontSize: 12.5,
      background: t.cream, padding: "1px 7px",
      color: t.ink, border: `1px solid ${t.hairSoft}`,
    }}>{children}</code>
  );
};

const Pre = ({ children, label }: { children: ReactNode; label?: string }) => {
  return (
    <div style={{ margin: "16px 0" }}>
      {label && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          fontFamily: fMono, fontSize: 10, letterSpacing: ".2em",
          color: t.mute, textTransform: "uppercase", marginBottom: 4,
        }}>
          <span style={{ background: t.line, color: t.paper, padding: "2px 8px" }}>{label}</span>
          <span style={{ flex: 1, height: 1, background: t.hairSoft }} />
        </div>
      )}
      <pre style={{
        fontFamily: fMono, fontSize: 12.5, lineHeight: 1.7,
        background: t.cream, border: `1px solid ${t.hairSoft}`,
        padding: "16px 18px", margin: 0,
        overflowX: "auto", whiteSpace: "pre" as const, color: t.ink,
      }}>{children}</pre>
    </div>
  );
};

const Note = ({ kind = "note", children }: { kind?: "note" | "warn" | "secure" | "open"; children: ReactNode }) => {
  const m = useMobile();
  const tone = {
    note:   { fg: t.ink,  border: t.line, label: "NOTE" },
    warn:   { fg: t.warn, border: t.warn, label: "ATTN" },
    secure: { fg: t.ok,   border: t.ok,   label: "SAFE" },
    open:   { fg: t.err,  border: t.err,  label: "OPEN" },
  }[kind];
  return (
    <div style={{
      borderLeft: `3px solid ${tone.border}`, padding: m ? "10px 12px" : "10px 16px",
      margin: "20px 0", background: t.card,
      fontFamily: fSans, fontSize: 14, lineHeight: 1.7, color: t.text,
      display: m ? "block" : "grid", gridTemplateColumns: "60px 1fr", gap: 10,
    }}>
      <span style={{
        fontFamily: fMono, fontSize: 10, letterSpacing: ".18em",
        color: tone.fg, fontWeight: 700, textTransform: "uppercase",
        paddingTop: 2, display: "block", marginBottom: m ? 6 : 0,
      }}>[{tone.label}]</span>
      <div>{children}</div>
    </div>
  );
};

const Numbered = ({ no, title, children }: { no: string; title: string; children: ReactNode }) => {
  const m = useMobile();

  return (
    <div style={{
      display: m ? "block" : "grid", gridTemplateColumns: "70px 1fr", gap: m ? 6 : 18,
      padding: "18px 0", borderBottom: `1px solid ${t.hairSoft}`,
    }}>
      <div style={{
        fontFamily: fMono, fontSize: m ? 20 : 30, fontWeight: 600,
        color: t.ink, lineHeight: 1, paddingTop: 4,
        letterSpacing: "-0.01em", marginBottom: m ? 6 : 0,
      }}>{no}</div>
      <div>
        <div style={{
          fontFamily: fSans, fontSize: m ? 15 : 16, fontWeight: 600,
          color: t.ink, marginBottom: 4, letterSpacing: "-0.005em",
        }}>{title}</div>
        <div style={{
          fontFamily: fSans, fontSize: 14, lineHeight: 1.7, color: t.text,
        }}>{children}</div>
      </div>
    </div>
  );
};

const Table = ({ head, rows, monoCol }: { head: string[]; rows: ReactNode[][]; monoCol?: number[] }) => {
  const isMono = (i: number) => monoCol?.includes(i);

  return (
    <div style={{ margin: "18px 0", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fSans, fontSize: 13 }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={i} style={{
              textAlign: "left", padding: "8px 12px",
              borderBottom: `1px solid ${t.line}`,
              fontFamily: fMono, fontSize: 10, letterSpacing: ".18em",
              textTransform: "uppercase", color: t.mute, fontWeight: 600,
              background: t.card,
            }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{
                  padding: "9px 12px", verticalAlign: "top",
                  borderBottom: `1px solid ${t.hair}`,
                  color: t.text, lineHeight: 1.55,
                  fontFamily: isMono(j) ? fMono : fSans,
                  fontSize: isMono(j) ? 12 : 13,
                  whiteSpace: isMono(j) ? "nowrap" as const : "normal" as const,
                }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Pill = ({ tone, children }: { tone: "ok" | "warn" | "err" | "info" | "neutral"; children: ReactNode }) => {
  const c = {
    ok:      { fg: t.ok,   bg: "#dcefde",  bd: "#bdd9be" },
    warn:    { fg: t.warn, bg: "#f3e3cb",  bd: "#e0c693" },
    err:     { fg: t.err,  bg: "#f3d4d4",  bd: "#dba9a9" },
    info:    { fg: t.cyan, bg: "#cce0e3",  bd: "#a3c0c4" },
    neutral: { fg: t.ink,  bg: t.cream,    bd: t.hair },
  }[tone];
  return (
    <span style={{
      fontFamily: fMono, fontSize: 10, letterSpacing: ".15em",
      textTransform: "uppercase", color: c.fg,
      background: c.bg, border: `1px solid ${c.bd}`,
      padding: "2px 7px", whiteSpace: "nowrap",
      fontWeight: 700,
    }}>{children}</span>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────

export const WhitepaperShell = () => {
  const pct = useReadingProgress();
  const active = useActiveSection(TOC.map((x) => x.id));
  const mobile = useIsMobile();
  const [tocOpen, setTocOpen] = useState(false);

  return (
    <MobileCtx.Provider value={mobile}>
    <div style={{
      background: t.paper, minHeight: "100vh", color: t.ink,
      backgroundImage:
        `linear-gradient(${t.hairFaint} 1px, transparent 1px), ` +
        `linear-gradient(90deg, ${t.hairFaint} 1px, transparent 1px)`,
      backgroundSize: "40px 40px",
      backgroundPosition: "-1px -1px",
    }}>
      {/* Top progress bar */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 2, zIndex: 60, background: "transparent" }}>
        <div style={{ height: 2, width: `${pct}%`, background: t.ink, transition: "width 80ms linear" }} />
      </div>

      {/* Sticky nav */}
      <header style={{
        position: "sticky", top: 0, background: `${t.paper}f5`,
        backdropFilter: "saturate(180%) blur(8px)",
        WebkitBackdropFilter: "saturate(180%) blur(8px)",
        borderBottom: `1px solid ${t.hair}`, zIndex: 50,
      }}>
        <div style={{
          maxWidth: 1180, margin: "0 auto", padding: mobile ? "0 16px" : "0 28px",
          height: 56, display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: mobile ? 12 : 24 }}>
            <Link href="/" style={navLinkStyle}>← DOCS</Link>
            {!mobile && <span style={{ width: 1, height: 14, background: t.hair }} />}
            {!mobile && <span style={{ ...navLinkStyle, fontWeight: 700, letterSpacing: ".30em" }}>VEIL · SPEC</span>}
            {!mobile && <Pill tone="info">RFC&nbsp;v0.1</Pill>}
          </div>
          <nav style={{ display: "flex", alignItems: "center", gap: mobile ? 14 : 22 }}>
            {!mobile && <>
              <a href="#abstract" style={navLinkStyle}>ABSTRACT</a>
              <a href="#math-spec" style={navLinkStyle}>MATH</a>
              <a href="#instructions" style={navLinkStyle}>IX</a>
              <a href="#api" style={navLinkStyle}>API</a>
              <a href="#threat-model" style={navLinkStyle}>SEC</a>
            </>}
            {mobile && (
              <button onClick={() => setTocOpen(!tocOpen)} style={{
                ...navLinkStyle, background: "none", border: `1px solid ${t.hair}`,
                padding: "4px 10px", cursor: "pointer",
              }}>{tocOpen ? "CLOSE" : "TOC"}</button>
            )}
            <span style={{ ...navLinkStyle, color: t.fade, fontVariantNumeric: "tabular-nums" }}>
              {pct.toFixed(0)}%
            </span>
          </nav>
        </div>
        {/* Mobile TOC dropdown */}
        {mobile && tocOpen && (
          <div style={{
            maxHeight: "60vh", overflowY: "auto",
            padding: "12px 16px", borderTop: `1px solid ${t.hair}`,
            background: t.card,
          }}>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {TOC.map((item) => (
                <li key={item.id} style={{ margin: "2px 0" }}>
                  <a href={`#${item.id}`} onClick={() => setTocOpen(false)} style={{
                    display: "block", textDecoration: "none", padding: "6px 0",
                    fontFamily: fSans, fontSize: 13, color: active === item.id ? t.ink : t.mute,
                    fontWeight: active === item.id ? 600 : 400,
                  }}>
                    <span style={{ fontFamily: fMono, fontSize: 10.5, color: t.fade, marginRight: 8 }}>{item.n}</span>
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {/* Hero */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: mobile ? "32px 16px 0" : "56px 28px 0" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: mobile ? 8 : 12, flexWrap: "wrap",
          fontFamily: fMono, fontSize: mobile ? 10 : 11, letterSpacing: ".22em",
          color: t.mute, textTransform: "uppercase", marginBottom: mobile ? 18 : 28,
        }}>
          <span>WHITEPAPER</span><span>·</span>
          <span>v0.1</span><span>·</span>
          <span>2026-04-25</span>
          {!mobile && <><span>·</span><span>27 MIN READ</span><span>·</span><span>SOURCE-GROUNDED</span></>}
        </div>
        <div style={{
          display: "flex", alignItems: "flex-start", gap: mobile ? 10 : 18, flexWrap: "wrap",
          marginBottom: 12,
        }}>
          <span style={{
            fontFamily: fMono, fontSize: mobile ? 10 : 12, color: t.cyan,
            border: `1px solid ${t.cyan}`, padding: "3px 10px",
            letterSpacing: ".22em", textTransform: "uppercase",
          }}>PROTOCOL SPEC</span>
          <span style={{
            fontFamily: fMono, fontSize: mobile ? 10 : 12, color: t.ink,
            border: `1px solid ${t.line}`, padding: "3px 10px",
            letterSpacing: ".22em", textTransform: "uppercase",
            background: t.card,
          }}>VEIL · v0.1</span>
        </div>
        <h1 style={{
          fontFamily: fSerif, fontSize: mobile ? 34 : 68, lineHeight: mobile ? 1.08 : 0.98,
          letterSpacing: "-0.034em", fontWeight: 400, color: t.ink,
          margin: 0, maxWidth: 980,
        }}>
          A privacy-first cross-chain{!mobile && <br />}{mobile ? " " : ""}lending protocol on Solana.
        </h1>
        <div style={{
          marginTop: mobile ? 16 : 24, fontFamily: fSans, fontSize: mobile ? 15 : 17, lineHeight: 1.7,
          color: t.text, maxWidth: 760,
        }}>
          Native Bitcoin, Ethereum, and physical-gold collateral via MPC dWallets and Oro/GRAIL settlement. Optional per-position fully-homomorphic privacy. Two-slope kink interest-rate model and Aave-style liquidation engine, implemented in <Code>Pinocchio 0.11.1</Code> for low compute-unit overhead. This document is the canonical engineering specification.
        </div>
        <div style={{
          marginTop: mobile ? 28 : 44,
          display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(5, 1fr)",
          borderTop: `1px solid ${t.line}`, borderBottom: `1px solid ${t.hair}`,
        }}>
          <Meta label="AUTHOR"     value="Veil Labs" />
          <Meta label="STATUS"     value="DEVNET · PRE-AUDIT" />
          <Meta label="LICENSE"    value="BSL 1.1" />
          <Meta label="REV"        value="0x0001" />
          <Meta label="SHA"        value="GROUND-TRUTHED" last />
        </div>
      </div>

      {/* Body */}
      <div style={{
        maxWidth: 1180, margin: "0 auto", padding: mobile ? "28px 16px 64px" : "44px 28px 96px",
        display: mobile ? "block" : "grid", gridTemplateColumns: "240px 1fr", gap: 56,
      }}>
        {/* TOC sidebar — hidden on mobile (use dropdown instead) */}
        {!mobile && (
        <aside style={{ position: "sticky", top: 76, alignSelf: "start" }}>
          <div style={{
            fontFamily: fMono, fontSize: 10.5, letterSpacing: ".22em",
            color: t.mute, textTransform: "uppercase", marginBottom: 14,
            paddingBottom: 8, borderBottom: `1px solid ${t.line}`,
            display: "flex", justifyContent: "space-between",
          }}>
            <span>CONTENTS</span>
            <span style={{ color: t.fade }}>{TOC.length}</span>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {TOC.map((item) => {
              const isActive = active === item.id;
              return (
                <li key={item.id} style={{ margin: "3px 0" }}>
                  <a href={`#${item.id}`} style={{
                    display: "grid", gridTemplateColumns: "26px 1fr", gap: 8,
                    textDecoration: "none", padding: "4px 0",
                    fontFamily: fSans, fontSize: 12.5, lineHeight: 1.4,
                    color: isActive ? t.ink : t.mute,
                    fontWeight: isActive ? 600 : 400,
                    borderLeft: isActive ? `2px solid ${t.ink}` : "2px solid transparent",
                    paddingLeft: 10,
                    transition: "color 0.15s",
                  }}>
                    <span style={{ fontFamily: fMono, fontSize: 10.5, color: t.fade }}>{item.n}</span>
                    <span>{item.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          <div style={{ marginTop: 22, padding: "12px 14px", border: `1px solid ${t.hair}`, background: t.card }}>
            <div style={{ fontFamily: fMono, fontSize: 9.5, letterSpacing: ".22em", color: t.mute, textTransform: "uppercase", marginBottom: 6 }}>NAV</div>
            <Link href="/" style={navLinkStyleSmall}>↩ DOCS HOME</Link><br/>
            <Link href="/program-reference" style={navLinkStyleSmall}>PROGRAM REF</Link><br/>
            <Link href="/integration" style={navLinkStyleSmall}>INTEGRATION</Link><br/>
            <Link href="/security" style={navLinkStyleSmall}>SECURITY</Link>
          </div>
        </aside>
        )}

        {/* Content column */}
        <main style={{ maxWidth: 760 }}>

          {/* ── 00 Abstract ── */}
          <H2 id="abstract" n="00" tag="ABSTRACT">Abstract</H2>
          <P>
            Veil is an over-collateralised lending protocol on Solana. It accepts SPL tokens as collateral natively and is designed to extend, without bridging, to native Bitcoin and Ethereum via Ika MPC <Em>dWallets</Em>, and to physical gold via Oro&apos;s GRAIL settlement layer. Each position can opt into amount-private accounting backed by Encrypt&apos;s REFHE construction; plaintext health checks remain the authoritative solvency rule.
          </P>
          <P>
            The on-chain program is implemented in <Code>Pinocchio 0.11.1</Code>. A two-slope kink interest-rate model, index-based share accounting, and an Aave-style liquidation engine (50 % close factor, 5 % liquidation bonus, 10 % protocol fee) provide the economic backbone. An off-chain allowlist on Neon Postgres curates which wallets are permitted to act as <Em>pool administrators</Em> for new markets; on-chain administrative authority is independently bound to <Code>LendingPool.authority</Code>.
          </P>
          <Note>
            This document is the canonical source-grounded specification. Every formula, parameter, and PDA seed appears in <Code>programs/src/</Code> with the cited path. Nothing is paraphrased without source. Defensive findings are surfaced with severity tags.
          </Note>

          {/* ── 01 Introduction ── */}
          <H2 id="introduction" n="01" tag="MOTIVATION">Introduction</H2>
          <H3 n="1.1">Two structural blockers in DeFi lending</H3>
          <P>
            Two forces keep institutional and high-net-worth capital out of on-chain credit markets. <Em>Liquidity fragmentation across chains</Em>: the largest pools of value sit in native Bitcoin, native Ethereum, and physical gold. Bringing any of these into a Solana lending market today requires bridging or wrapping — introducing custody risk, smart-contract risk, and trusted multi-sigs. <Em>Position transparency</Em>: Aave and Compound disclose every user&apos;s collateral, debt, liquidation price, and strategy on a public ledger. For market makers, treasuries, and funds, this leaks inventory and invites front-running.
          </P>
          <H3 n="1.2">Veil&apos;s response</H3>
          <Numbered no="01" title="Native collateral via MPC dWallets">
            Ika dwallet accounts can be placed under the joint signing authority of a Solana program PDA and the Ika MPC committee. Veil is the Solana side of that pairing — a borrow on Solana is simultaneously authorised against native Bitcoin or Ethereum collateral. No bridge contract holds the underlying asset.
          </Numbered>
          <Numbered no="02" title="Per-position privacy via FHE">
            When a user enables privacy, balances become ciphertext handles and arithmetic happens homomorphically. The program receives a plaintext boolean <Code>healthy?</Code> from the FHE evaluator, never the underlying amounts.
          </Numbered>
          <Numbered no="03" title="Pinocchio for predictable compute">
            Borrow checks, liquidation math, and oracle reads run in a few thousand compute units. Pinocchio&apos;s zero-copy account access avoids Anchor&apos;s deserialisation overhead.
          </Numbered>
          <Numbered no="04" title="Curated, not gated">
            Liquidation, oracle refresh, and all user state mutations are permissionless. Pool initialisation is curated through an off-chain allowlist (§7); on-chain authority is independently bound at Initialize time.
          </Numbered>

          {/* ── 02 Design principles ── */}
          <H2 id="design-principles" n="02" tag="PRINCIPLES">Design Principles</H2>
          <Table head={["Principle", "Concretely"]} rows={[
            [<Em key="1">Native, not synthetic, collateral</Em>, <span key="2">Ika dWallets remain the user&apos;s; Veil controls signing while the position is open. Source: <Code>programs/src/instructions/ika_register.rs</Code>.</span>],
            [<Em key="1">Plaintext solvency, optional opacity</Em>, <span key="2"><Code>UserPosition</Code> is always authoritative. <Code>EncryptedPosition</Code> is a parallel mirror. Health checks never depend on encrypted state being decryptable.</span>],
            [<Em key="1">Compute-bounded</Em>, "Hot paths accrue interest, do at most one HF check, transfer tokens, and update u128 fields — no per-position storage walks."],
            [<Em key="1">Permissionless where it can be, gated where it must be</Em>, "Liquidation, oracle refresh, and all user state mutations are permissionless. Pool initialisation is curated through an off-chain allowlist."],
            [<Em key="1">Atomic state machines for risky primitives</Em>, "Flash loans use a single-tx in-flight counter; missing repay reverts everything."],
            [<Em key="1">Source-grounded documentation</Em>, "Every claim cites the on-chain Rust file. Drift between code and docs is a bug."],
          ]} />

          {/* ── 03 System overview ── */}
          <H2 id="system-overview" n="03" tag="SCHEMATIC">System Overview</H2>
          <H3 n="3.1">Components</H3>
          <Pre label="FIG. 1 · COMPONENT TOPOLOGY">{`┌──────────────────────────────────────────────────────────────────────┐
│                            Veil Program                              │
│                       (Pinocchio 0.11.1, no_std)                     │
│                                                                      │
│   LendingPool ←─→ UserPosition         EncryptedPosition (optional)  │
│   (1 / mint)      (1 / user / pool)    (1 / user / pool)             │
│         │                                                            │
│         │  oracle_price, oracle_conf cached on every UpdateOracle    │
│         ▼                                                            │
│   Pyth legacy push-oracle account (per pool, address-anchored)       │
│                                                                      │
│   Cross-chain collateral                                             │
│   IkaDwalletPosition ───CPI──→ Ika dWallet program                   │
└──────────────────────────────────────────────────────────────────────┘
              ▲                                  ▲
              │ tx submission (web3.js)          │ permissionless reads
              │                                  │
   Next.js dApp + admin panel ────────────→  Neon Postgres
   (/dapp, /dapp/admin, /dapp/liquidate)    (allowlist · tx_log · cache
                                             positions · auth_nonces)`}</Pre>
          <H3 n="3.2">Roles</H3>
          <Table head={["Role", "What they can do", "Enforcement"]} rows={[
            ["User",        "Deposit, withdraw, borrow, repay, enable privacy",                                "On-chain: signer == UserPosition.owner"],
            ["Liquidator",  "Repay debt of unhealthy positions and seize collateral",                          "Permissionless on-chain (only HF condition)"],
            ["Pool Admin",  "Initialize a new pool; update params, pause/resume, collect fees on pools they authorise", "On-chain: signer == pool.authority. Off-chain: must be in pool_admins to use the curated UI for Initialize."],
            ["Super-admin", "Curate the off-chain allowlist (add/revoke pool admins)",                         "Off-chain only: pool_admins.role == 'super_admin', signed nonce verified server-side."],
          ]} />
          <Note kind="warn">
            An attacker who bypasses the curated UI can still call <Code>Initialize</Code> directly with their own wallet as <Code>authority</Code>. The pool that results is not registered in Veil&apos;s index and has no relationship to canonical pools. The off-chain allowlist gates <Em>which pools Veil considers canonical</Em> — not the on-chain instruction itself. See §13.5 for first-mover squatting risk.
          </Note>

          {/* ── 04 On-chain state ── */}
          <H2 id="on-chain-state" n="04" tag="STATE">On-Chain State</H2>
          <P>
            All accounts are <Code>#[repr(C)]</Code> zero-copy structs. They are read by direct raw pointer cast (Pinocchio idiom). The first eight bytes are an ASCII discriminator; subsequent fields are little-endian on Solana&apos;s BPF target.
          </P>
          <H3 n="4.1">LendingPool — 416 bytes</H3>
          <P>One per token market. PDA seeds: <Code>[b&quot;pool&quot;, token_mint]</Code>. Source: <Code>programs/src/state/lending_pool.rs</Code>; <Code>SIZE = 416</Code> at line 114.</P>
          <Table monoCol={[0, 1]} head={["OFF", "SZ", "FIELD", "TYPE / NOTES"]} rows={[
            ["0x000", "8",  "discriminator",              <Mono key="1">b&quot;VEILPOOL&quot;</Mono>],
            ["0x008", "32", "authority",                  "Address — admin set at Initialize"],
            ["0x028", "32", "token_mint",                 "Address"],
            ["0x048", "32", "vault",                      "SPL ATA owned by PoolAuthority PDA"],
            ["0x068", "8",  "total_deposits",             "u64; virtual; grows with depositor interest"],
            ["0x070", "8",  "total_borrows",              "u64; virtual; grows with borrower interest"],
            ["0x078", "8",  "accumulated_fees",           "u64; protocol reserves owed to authority"],
            ["0x080", "8",  "last_update_timestamp",      "i64; Unix seconds"],
            ["0x088", "1",  "authority_bump",             "u8"],
            ["0x089", "1",  "pool_bump",                  "u8"],
            ["0x08A", "1",  "vault_bump",                 "u8"],
            ["0x08B", "1",  "paused",                     "u8 — 0 active, 1 paused"],
            ["0x090", "16", "borrow_index",               "u128 WAD; init = WAD"],
            ["0x0A0", "16", "supply_index",               "u128 WAD; init = WAD"],
            ["0x0B0..0x140", "16×9", "rate + risk params", "base_rate, optimal_util, slope1/2, reserve_factor, ltv, liq_threshold, liq_bonus, protocol_liq_fee, close_factor"],
            ["0x150", "8",  "flash_loan_amount",          "u64; non-zero ⇔ flash in flight"],
            ["0x158", "8",  "flash_fee_bps",              "u64; default 9 bps"],
            ["0x160", "32", "pyth_price_feed",            "Address; anchored on first update"],
            ["0x180..0x190", "20", "oracle_price · oracle_conf · oracle_expo", "Last validated price snapshot"],
          ]} />

          <H3 n="4.2">UserPosition — 144 bytes</H3>
          <P>One per (user, pool). PDA seeds: <Code>[b&quot;position&quot;, pool, user]</Code>. Source: <Code>programs/src/instructions/deposit.rs:82,94</Code>.</P>
          <Table monoCol={[0, 1]} head={["OFF", "SZ", "FIELD"]} rows={[
            ["0x00", "8",  <span key="1"><Code>discriminator</Code> = <Mono>b&quot;VEILPOS!&quot;</Mono></span>],
            ["0x08", "32", <Code key="2">owner</Code>],
            ["0x28", "32", <Code key="2">pool</Code>],
            ["0x48", "8",  <Code key="2">deposit_shares</Code>],
            ["0x50", "8",  <Code key="2">borrow_principal</Code>],
            ["0x60", "16", <Code key="2">deposit_index_snapshot</Code>],
            ["0x70", "16", <Code key="2">borrow_index_snapshot</Code>],
            ["0x80", "1",  <Code key="2">bump</Code>],
          ]} />

          <H3 n="4.3">EncryptedPosition — 144 bytes</H3>
          <P>Optional, created by <Code>EnablePrivacy</Code>. Seeds: <Code>[b&quot;enc_pos&quot;, owner, pool]</Code>. Holds two ciphertext-account pubkeys (<Code>enc_deposit</Code>, <Code>enc_debt</Code>) on the Encrypt program.</P>

          <H3 n="4.4">IkaDwalletPosition — 128 bytes</H3>
          <P>Tracks a registered Ika dWallet pledged as collateral. Seeds: <Code>[b&quot;ika_pos&quot;, pool, user]</Code>. Status field tracks <Code>ACTIVE | RELEASED | LIQUIDATED</Code>.</P>

          {/* ── 05 Math spec ── */}
          <H2 id="math-spec" n="05" tag="FORMAL">Mathematical Specification</H2>
          <P>
            All rates and indices live in <Em>WAD</Em> space, where <Code>WAD = 10¹⁸ = 1.0</Code>. Token amounts are <Code>u64</Code> in their native units; they are widened to <Code>u128</Code> only inside arithmetic and narrowed back at the boundary. All formulas appear verbatim in <Code>programs/src/math.rs</Code>.
          </P>
          <H3 n="5.1">Constants</H3>
          <Pre label="programs/src/math.rs">{`WAD               = 1_000_000_000_000_000_000      // line 16
SECONDS_PER_YEAR  = 31_536_000                     // line 19

BASE_RATE         = WAD / 100         ≈  1 % apr   // line 23
OPTIMAL_UTIL      = WAD * 80 / 100    =  80 %      // line 24
SLOPE1            = WAD *  4 / 100    =   4 % apr  // line 25
SLOPE2            = WAD * 75 / 100    =  75 % apr  // line 26
RESERVE_FACTOR    = WAD / 10          =  10 %      // line 27
LTV               = WAD * 75 / 100    =  75 %      // line 28
LIQ_THRESHOLD     = WAD * 80 / 100    =  80 %      // line 29
LIQ_BONUS         = WAD *  5 / 100    =   5 %      // line 30
PROTOCOL_LIQ_FEE  = WAD / 10          =  10 % of bonus
CLOSE_FACTOR      = WAD / 2           =  50 %
FLASH_FEE_BPS     = 9                 ≈ 0.09 %     // line 35
FLASH_PROTOCOL_SHARE_BPS = 10                     // line 37
FLASH_LP_SHARE_BPS       = 90                     // line 39`}</Pre>

          <H3 n="5.2">Borrow rate (two-slope kink)</H3>
          <Pre label="programs/src/math.rs:76-102">{`             ⎧ R₀ + (U / U_opt) × S₁                          if U ≤ U_opt
borrow_rate =⎨
             ⎩ R₀ + S₁ + ((U − U_opt) / (1 − U_opt)) × S₂      if U > U_opt`}</Pre>
          <P>Verified by tests <Code>borrow_rate_at_kink</Code>, <Code>borrow_rate_above_kink_full</Code>, <Code>borrow_rate_monotonically_increasing</Code> (math.rs:374-417).</P>
          <Table monoCol={[0, 1]} head={["UTIL", "BORROW RATE (DEFAULT)"]} rows={[
            ["0 %",   "1 %"], ["40 %",  "3 %"], ["80 % (kink)", "5 %"],
            ["90 %",  "42.5 %"], ["100 %", "80 %"],
          ]} />

          <H3 n="5.3">Supply rate</H3>
          <Pre label="programs/src/math.rs:104-115">{`supply_rate = borrow_rate × U × (1 − reserve_factor)`}</Pre>

          <H3 n="5.4">Index accrual</H3>
          <P>Simple interest within a single accrual call; calls compose into compound interest across blocks. Per call, with elapsed <Code>Δt</Code> seconds:</P>
          <Pre label="programs/src/math.rs:124-159">{`borrow_index_new = borrow_index × (1 + borrow_rate × Δt / SECONDS_PER_YEAR)
supply_index_new = supply_index × (1 + supply_rate × Δt / SECONDS_PER_YEAR)`}</Pre>

          <H3 n="5.5">Health factor</H3>
          <Pre label="programs/src/math.rs:201-211">{`HF = (deposit_balance × liquidation_threshold) / debt_balance     (WAD)
HF = u128::MAX                if debt_balance == 0`}</Pre>
          <P>A position is liquidatable iff <Code>HF &lt; WAD</Code>. The boundary is exact: <Code>HF == WAD</Code> is <Em>not</Em> liquidatable.</P>

          <H3 n="5.6">Liquidation</H3>
          <Pre label="programs/src/instructions/liquidate.rs">{`repay_amount      = current_debt × close_factor                ≤ 50 %
seized_collateral = repay_amount × (1 + liquidation_bonus)     +5 % bonus
protocol_fee      = seized_collateral × protocol_liq_fee       10 % cut
liquidator_gets   = seized_collateral − protocol_fee`}</Pre>

          <H3 n="5.7">Flash-loan economics</H3>
          <Pre label="programs/src/math.rs:223-238">{`fee = amount × flash_fee_bps / 10_000
(lp_portion, protocol_portion) = (fee − fee/10,  fee/10)`}</Pre>
          <P>The 10 % protocol cut is integer-divided first; the LP portion takes the remainder. <Code>total_deposits</Code> grows by <Code>lp_portion</Code>; <Code>accumulated_fees</Code> grows by <Code>protocol_portion</Code>.</P>

          {/* ── 06 Instructions ── */}
          <H2 id="instructions" n="06" tag="OPCODES">Instruction Specification</H2>
          <P>The dispatcher is a single-byte switch on <Code>data[0]</Code>: <Code>programs/src/entrypoint.rs:28-50</Code>. There is no Anchor 8-byte hash. All <Code>u64</Code> fields are little-endian; all <Code>u128</Code> fields are little-endian (low 8 bytes followed by high 8 bytes).</P>
          <Table monoCol={[0]} head={["DISC", "INSTRUCTION", "SIGNER", "ON-CHAIN AUTH CHECK"]} rows={[
            ["0x00", "Initialize",      "payer + authority", "none — caller becomes pool authority"],
            ["0x01", "Deposit",         "user",       "user == position.owner; pool.paused == 0"],
            ["0x02", "Withdraw",        "user",       "user == position.owner; HF ≥ 1 if debt > 0"],
            ["0x03", "Borrow",          "user",       "owner; LTV cap; HF ≥ 1; not paused"],
            ["0x04", "Repay",           "user",       "owner"],
            ["0x05", "Liquidate",       "liquidator", "borrower HF < 1"],
            ["0x06", "FlashBorrow",     "borrower",   "not paused; no active flash"],
            ["0x07", "FlashRepay",      "borrower",   "active flash; repay ≥ amount + fee"],
            ["0x08", "EnablePrivacy",   "user",       "user == position.owner"],
            ["0x09", "PrivateDeposit",  "user",       "as plaintext + binding"],
            ["0x0A", "PrivateBorrow",   "user",       "as plaintext + binding"],
            ["0x0B", "PrivateRepay",    "user",       "as plaintext + binding"],
            ["0x0C", "PrivateWithdraw", "user",       "as plaintext + binding"],
            ["0x0D", "UpdatePool",      "authority",  "signer == pool.authority"],
            ["0x0E", "PausePool",       "authority",  "ditto"],
            ["0x0F", "ResumePool",      "authority",  "ditto"],
            ["0x10", "CollectFees",     "authority",  "ditto"],
            ["0x11", "IkaRegister",     "user",       "dwallet.authority == Veil CPI PDA"],
            ["0x12", "IkaRelease",      "user",       "signer == ika_position.owner"],
            ["0x13", "IkaSign",         "user",       "owner; status == Active"],
            ["0x14", "UpdateOraclePrice", "—",        "feed match if anchored"],
          ]} />

          {/* ── 07 Authorization ── */}
          <H2 id="authorization" n="07" tag="AUTH">Authorization Model</H2>
          <P>Veil splits authorization into <Em>two independent layers</Em> that must both be satisfied to administer a canonical pool through the curated UI.</P>
          <Numbered no="01" title="On-chain authority">
            Encoded in <Code>LendingPool.authority</Code> at offset <Mono>0x008</Mono>. Set once by <Code>Initialize</Code> to the second signer. Update / Pause / Resume / CollectFees enforce <Code>signer == pool.authority</Code> on every call, returning <Code>Unauthorized</Code> (6021) otherwise. Citations: <Code>programs/src/instructions/update_pool.rs:102-105</Code>, <Code>pause_pool.rs:31</Code>, <Code>resume_pool.rs:30</Code>, <Code>collect_fees.rs:44</Code>.
          </Numbered>
          <Numbered no="02" title="Off-chain pool-creation allowlist">
            Stored in Neon Postgres in <Code>pool_admins</Code>. Gates which wallets the canonical UI permits to start the on-chain Initialize flow, and which wallets can manage the allowlist itself.
          </Numbered>
          <H3 n="7.1">Signed-nonce handshake</H3>
          <Pre label="lib/auth/admin.ts:21-66">{`1.  UI POSTs /api/auth/nonce {pubkey, action}
    Server returns a 16-byte hex nonce + canonical message:
       "Veil admin auth\\nAction: <action>\\nNonce: <nonce>"
    TTL: 5 minutes. Stored in auth_nonces.
2.  Wallet signs the exact bytes (ed25519 detached signature).
3.  UI POSTs the protected endpoint with {actor, nonce, signature, …}.
4.  Server, in this order:
    a. verifies ed25519 signature over canonical message     (TweetNaCl)
    b. atomically DELETE … RETURNING the nonce row          (single use)
    c. checks pool_admins membership and revoked_at         (registry)
    d. if requireRole == 'super_admin', enforces role       (privilege)
5.  On any failure, returns 401 with redacted reason. Nonce
    consumption is idempotent; replay produces "nonce invalid".`}</Pre>
          <Note kind="secure">
            Each property below is required for the handshake to succeed:
            (a) signature over the <Em>exact</Em> canonical message bytes — prevents reuse from other contexts;
            (b) nonce single-use via atomic DELETE — prevents replay;
            (c) per-wallet nonce — A&apos;s nonce cannot be used by B;
            (d) action encoded into the message — sig for <Mono>add_admin:X:role</Mono> cannot be replayed as <Mono>revoke_admin:X</Mono>;
            (e) allowlist re-check on every request — revocation is immediate.
          </Note>

          {/* ── 08 Oracle ── */}
          <H2 id="oracle" n="08" tag="ORACLE">Oracle Subsystem</H2>
          <P>Veil reads Pyth legacy push-oracle accounts directly without the Pyth SDK. The per-call validation pipeline:</P>
          <Pre label="programs/src/pyth/mod.rs">{`1. data.len() ≥ 228         → else OracleInvalid       (6024)
2. magic == 0xa1b2c3d4      → else OracleInvalid
3. atype == 3 (Price)       → else OracleInvalid
4. agg.price > 0            → else OracleInvalid
5. agg.status == 1          → else OraclePriceStale   (6025)
6. agg.conf ≤ price / 50    → else OracleConfTooWide  (6027)`}</Pre>
          <P>After the first successful update, <Code>pool.pyth_price_feed</Code> records the feed account address; subsequent calls with a different feed return <Code>OraclePriceFeedMismatch</Code> (6026). The 2 % confidence cap is the load-bearing defence against flash-loan-driven oracle manipulation: during such an attack Pyth&apos;s aggregation widens the confidence interval before the aggregate price is fully deflected.</P>
          <Note kind="open">
            <strong>Open issue · O-01 · feed first-call hijack.</strong> The address of the Pyth feed is anchored on the <Em>first</Em> successful <Code>UpdateOraclePrice</Code> call. On a freshly-initialised pool, an attacker who is first to call this instruction can anchor the pool to a feed account they crafted (any account whose first 228 bytes pass magic/atype/conf). Mitigation: pool deployment scripts must atomically initialize and anchor in a single tx; or accept the canonical Pyth feed address as part of <Code>Initialize</Code> data.
          </Note>

          {/* ── 09 Privacy ── */}
          <H2 id="privacy" n="09" tag="FHE">Privacy Subsystem (FHE)</H2>
          <P>Privacy is opt-in per (user, pool). <Code>EnablePrivacy</Code> creates an <Code>EncryptedPosition</Code> PDA and two ciphertext accounts on the Encrypt program, seeded with the user&apos;s current plaintext deposit and debt. The four <Code>Private*</Code> instructions (<Mono>0x09-0x0C</Mono>) replicate the plaintext flow and emit Encrypt CPIs that update ciphertexts homomorphically.</P>
          <Table head={["Hidden", "Not hidden"]} rows={[
            ["Post-EnablePrivacy deposit / borrow / repay / withdraw amounts", "That an EncryptedPosition PDA exists"],
            ["Current encrypted balances", "That a private instruction was called"],
            ["", "The pool, the wallet address, the timing"],
          ]} />
          <P><Em>Solvency under FHE.</Em> Health checks run homomorphically. The Encrypt evaluator returns a plaintext boolean (<Code>healthy?</Code>) to Veil, which decides whether to allow the borrow or withdraw. Underlying balances are never decrypted on-chain.</P>
          <Note kind="warn">
            Implementation status (v0.1): all five private instructions compile and route correctly. The Encrypt SDK currently targets Pinocchio 0.10.x while Veil targets 0.11.x — <Code>execute_graph</Code> CPIs are stubbed pending the SDK update. The plaintext path is fully functional today.
          </Note>

          {/* ── 10 Cross-chain ── */}
          <H2 id="cross-chain" n="10" tag="DWALLET">Cross-Chain Collateral (Ika dWallet)</H2>
          <P>An Ika dWallet is a programmable signing primitive: an MPC-managed key governed by a programmable authority address. Veil registers a dWallet by verifying that its on-chain authority field equals Veil&apos;s CPI authority PDA (<Code>[b&quot;__ika_cpi_authority&quot;]</Code> on Veil&apos;s program ID, <Code>programs/src/ika/mod.rs:67</Code>). While registered, the dWallet can only sign when Veil approves the message via <Code>IkaSign</Code>.</P>
          <Table monoCol={[1]} head={["CURVE", "VAL", "USE"]} rows={[
            ["SECP256K1",  "0", "Bitcoin, Ethereum"],
            ["SECP256R1",  "1", "WebAuthn"],
            ["CURVE25519", "2", "Solana, Ed25519"],
            ["RISTRETTO",  "3", "Substrate / sr25519"],
          ]} />
          <P><Code>IkaRelease</Code> returns the dWallet to the user iff the position is <Code>ACTIVE</Code> (not <Code>LIQUIDATED</Code>). A liquidated dWallet remains under Veil&apos;s control for recovery.</P>
          <Note kind="open">
            <strong>Open issue · X-01 · liquidation settlement path.</strong> A position with status <Code>LIQUIDATED</Code> is bricked by <Code>IkaRelease</Code> (status check rejects it) and by <Code>IkaSign</Code> (status must be Active). The intended recovery — liquidator claims the dWallet&apos;s native chain assets — is not yet wired in v0.1. A dedicated <Code>IkaLiquidate</Code> instruction or an ownership-transfer pathway is required.
          </Note>

          {/* ── 11 Off-chain ── */}
          <H2 id="off-chain" n="11" tag="STACK">Off-Chain Infrastructure</H2>
          <H3 n="11.1">Web stack</H3>
          <Table head={["Route", "Purpose"]} rows={[
            ["/", "Marketing landing"],
            ["/dapp", "Markets — deposit / borrow / repay / withdraw / flash"],
            ["/dapp/liquidate", "Permissionless liquidation UI"],
            ["/dapp/admin", "Allowlisted admin panel (Manage / Initialize / Allowlist)"],
            ["/workflow", "End-to-end actor & instruction overview"],
            ["/whitepaper", "Visual whitepaper (marketing / docs)"],
            ["/api/*", "HTTP API — see §12"],
          ]} />
          <H3 n="11.2">Postgres tables (Neon)</H3>
          <Table monoCol={[0]} head={["TABLE", "PURPOSE"]} rows={[
            ["pool_admins", "Off-chain allowlist (pool_admin, super_admin)"],
            ["pools",       "Cached on-chain LendingPool state"],
            ["positions",   "Cached UserPosition snapshots with derived health_factor_wad"],
            ["tx_log",      "Append-only signature log keyed on Solana tx signature"],
            ["audit_log",   "Admin actions (allowlist edits, pool inits, fee collections)"],
            ["auth_nonces", "Single-use ed25519 nonces, 5-min TTL"],
          ]} />

          {/* ── 12 API ── */}
          <H2 id="api" n="12" tag="HTTP">HTTP API</H2>
          <P>
            Eleven endpoints, all in <Code>veil-landing/app/api/**/route.ts</Code>, running on the Node runtime. The Neon HTTP driver is used for DB access; no per-request WebSocket pool. Numeric on-chain quantities are returned as strings to preserve <Code>u64</Code>/<Code>u128</Code> fidelity.
          </P>
          <H3 n="12.1">Endpoint surface</H3>
          <Table monoCol={[0, 1]} head={["VERB", "PATH", "PURPOSE", "AUTH"]} rows={[
            ["GET",    "/api/admin/me?pubkey=…",  "Role lookup for UI gating",                                <Pill key="1" tone="neutral">none</Pill>],
            ["POST",   "/api/auth/nonce",         "Issue single-use signed-message nonce (5 min TTL)",         <Pill key="1" tone="neutral">none</Pill>],
            ["GET",    "/api/admin/allowlist",    "List active admins",                                        <Pill key="1" tone="neutral">none</Pill>],
            ["POST",   "/api/admin/allowlist",    "Add admin",                                                 <Pill key="1" tone="warn">super-admin</Pill>],
            ["DELETE", "/api/admin/allowlist",    "Revoke admin (cannot revoke self)",                         <Pill key="1" tone="warn">super-admin</Pill>],
            ["GET",    "/api/pools",              "Cached pool index",                                         <Pill key="1" tone="neutral">none</Pill>],
            ["POST",   "/api/pools/init",         "Register a freshly initialised pool",                       <Pill key="1" tone="warn">allowlisted</Pill>],
            ["POST",   "/api/pools/sync",         "Refresh a pool's cache from chain",                         <Pill key="1" tone="neutral">none</Pill>],
            ["GET",    "/api/positions/[user]",   "Cached positions for a wallet",                             <Pill key="1" tone="neutral">none</Pill>],
            ["GET",    "/api/transactions",       "Tx log (filter by wallet or pool, max 200)",                <Pill key="1" tone="neutral">none</Pill>],
            ["POST",   "/api/transactions",       "Append confirmed/failed tx (idempotent on signature)",      <Pill key="1" tone="neutral">none</Pill>],
          ]} />

          <H3 n="12.2">Authenticated request envelope</H3>
          <P>Authenticated endpoints take a common preamble plus an action-specific payload:</P>
          <Pre label="REQ · authenticated">{`POST /api/admin/allowlist
Content-Type: application/json

{
  "actor":     "<base58 super-admin pubkey>",
  "nonce":     "<32-hex-char nonce from /api/auth/nonce>",
  "signature": "<base58 ed25519 sig over the canonical message>",
  "pubkey":    "<wallet to add>",
  "role":      "pool_admin" | "super_admin",
  "label":     "<optional human label>"
}`}</Pre>
          <P>The canonical message the wallet signs:</P>
          <Pre>{`Veil admin auth
Action: add_admin:<pubkey>:<role>
Nonce: <nonce>`}</Pre>
          <P>Wire format: UTF-8 bytes, two LF separators. The signature must be valid ed25519 detached over those exact bytes.</P>

          <H3 n="12.3">Response shape · /api/pools</H3>
          <Pre label="RES · GET /api/pools">{`{
  "pools": [
    {
      "pool_address": "...",
      "token_mint":   "...",
      "symbol":       "USDC" | null,
      "authority":    "...",
      "vault":        "...",
      "pool_bump":    254,
      "authority_bump": 255,
      "vault_bump":   0,
      "paused":       false,
      "total_deposits":   "0",
      "total_borrows":    "0",
      "accumulated_fees": "0",
      "ltv_wad":                    "750000000000000000",
      "liquidation_threshold_wad":  "800000000000000000",
      "liquidation_bonus_wad":      "50000000000000000",
      "protocol_liq_fee_wad":       "100000000000000000",
      "reserve_factor_wad":         "100000000000000000",
      "close_factor_wad":           "500000000000000000",
      "base_rate_wad":              "10000000000000000",
      "optimal_util_wad":           "800000000000000000",
      "slope1_wad":                 "40000000000000000",
      "slope2_wad":                 "750000000000000000",
      "flash_fee_bps":              9,
      "oracle_price":               null,
      "oracle_conf":                null,
      "oracle_expo":                null,
      "pyth_price_feed":            null,
      "created_by":     "...",
      "init_signature": "...",
      "last_synced_at": "...",
      "created_at":     "..."
    }
  ]
}`}</Pre>

          <H3 n="12.4">Error code mapping</H3>
          <P>API errors map to short, redacted strings to avoid leaking implementation detail. The set is closed:</P>
          <Table monoCol={[0, 1]} head={["HTTP", "ERROR", "WHERE"]} rows={[
            ["400", "bad json",                      "req.json() rejected"],
            ["400", "missing fields",                "required fields absent"],
            ["400", "pubkey and action required",    "/api/auth/nonce"],
            ["400", "invalid pubkey",                "length / charset"],
            ["400", "invalid role",                  "role validation"],
            ["400", "bad pubkey: <reason>",          "new PublicKey() threw"],
            ["400", "cannot revoke yourself",        "self-lockout guard"],
            ["404", "pool account not found",        "getAccountInfo returned null"],
            ["400", "pool_address required",         "/api/pools/sync"],
            ["400", "signature, wallet, action required", "/api/transactions"],
            ["401", "bad signature",                 "TweetNaCl verify failed"],
            ["401", "nonce invalid or expired",      "auth_nonces row absent / stale"],
            ["401", "not authorized",                "actor not in pool_admins"],
            ["401", "super_admin required",          "role mismatch"],
          ]} />

          {/* ── 13 Threat model · ULTRATHINK ── */}
          <H2 id="threat-model" n="13" tag="ULTRATHINK">Threat Model</H2>
          <P>
            A defence-in-depth survey of the protocol&apos;s attack surface. Each finding is tagged with a status: <Pill tone="ok">SAFE</Pill> (mitigated by current code), <Pill tone="warn">DEFENSE</Pill> (recommended hardening before mainnet), or <Pill tone="err">OPEN</Pill> (a known gap that must be addressed). Findings cite source where applicable.
          </P>

          <H3 n="13.1">On-chain · economic vectors</H3>

          <Threat id="A-01" status="ok" title="Flash-loan reentrancy">
            <Code>pool.flash_loan_amount</Code> at offset <Mono>0x150</Mono> is set non-zero by <Code>FlashBorrow</Code> and zeroed by <Code>FlashRepay</Code>. A second <Code>FlashBorrow</Code> on the same pool while a loan is in flight returns <Code>FlashLoanActive</Code> (6018); a <Code>FlashRepay</Code> without an active loan returns <Code>FlashLoanNotActive</Code> (6019); insufficient repay returns <Code>FlashLoanRepayInsufficient</Code> (6020). Solana transaction atomicity guarantees that a missed <Code>FlashRepay</Code> reverts the entire transaction including the <Code>FlashBorrow</Code> that incremented the counter — so the flag is always consistent with the realised state at tx end.
          </Threat>

          <Threat id="A-02" status="ok" title="Oracle confidence-interval guard">
            Pyth aggregation widens the <Code>agg.conf</Code> interval before the published price moves materially during a flash-loan-driven manipulation. The 2 % cap (<Code>conf ≤ price / 50</Code>) rejects prices during the attack window. Source: <Code>programs/src/pyth/mod.rs</Code>.
          </Threat>

          <Threat id="A-03" status="ok" title="Oracle feed substitution after anchor">
            The <Code>pyth_price_feed</Code> address is recorded on the <Em>first</Em> successful update; subsequent calls require an exact match or return <Code>OraclePriceFeedMismatch</Code> (6026). Once anchored, the feed cannot be silently swapped.
          </Threat>

          <Threat id="A-04" status="err" title="Oracle feed first-call hijack">
            Before the first <Code>UpdateOraclePrice</Code> call, no feed is anchored. Any caller can anchor the pool to any account whose first 228 bytes pass the magic / atype / conf / status / price-positive checks. An attacker who races the canonical anchor can pin the pool to a feed they crafted. <strong>Mitigation</strong>: deployment scripts must atomically initialize and anchor in a single tx, OR <Code>Initialize</Code> data should accept the expected feed address and the program should reject any other on first <Code>UpdateOraclePrice</Code>.
          </Threat>

          <Threat id="A-05" status="ok" title="LTV / health-factor enforcement at borrow time">
            <Code>Borrow</Code> enforces both the LTV cap (<Code>debt + amount ≤ deposit_balance × LTV</Code>) and the post-borrow health factor (<Code>HF ≥ WAD</Code>). <Code>Withdraw</Code> enforces a post-withdraw HF check identical to the borrow case when the user has open debt. Both checks consult the cached oracle price; for sensitive operations, callers should atomically refresh the oracle in the same transaction.
          </Threat>

          <Threat id="A-06" status="ok" title="Liquidation grief / front-run">
            Liquidations are explicitly permissionless. The 50 % close factor prevents a single liquidator from sweeping an entire underwater position; multiple liquidators compete for the residual debt. The 5 % bonus is a public auction parameter; competition tightens spreads and is healthy.
          </Threat>

          <Threat id="A-07" status="warn" title="Oracle-price staleness between refreshes">
            <Code>UpdateOraclePrice</Code> is permissionless but explicit. Between calls, the cached price is used — even if hours old. The program does not check a Pyth <Code>publishTime</Code>. <strong>Defence</strong>: keepers must atomically refresh the oracle in the same transaction as <Code>Borrow</Code>, <Code>Withdraw</Code>, and <Code>Liquidate</Code>. Document this requirement clearly to integrators; consider a minimum-staleness check before mainnet.
          </Threat>

          <Threat id="A-08" status="warn" title="Liquidation-parameter race (no timelock)">
            <Code>UpdatePool</Code> takes effect on the next interest accrual. A malicious authority could collapse <Code>liquidation_threshold</Code> just before the next block and make every borrower instantly liquidatable. <strong>Defence</strong>: production deployments must place a Squads multisig + timelocked governance program in front of <Code>pool.authority</Code>. The program should additionally cap per-block parameter deltas in v1.
          </Threat>

          <Threat id="A-09" status="err" title="Initialize squatting">
            <Code>Initialize</Code> is permissionless on chain (the off-chain allowlist gates only the canonical UI). PDAs are deterministic per <Code>[b&quot;pool&quot;, token_mint]</Code> — there is exactly one possible pool per mint. An attacker who initializes first claims <Code>pool.authority</Code> for that mint, locking out the canonical operator. <strong>Mitigation</strong>: deployment script atomically initializes all expected pools first; OR add a <Code>SetExpectedAuthority</Code> upgradeable governor; OR require an initialization signature from a known root key in <Code>Initialize</Code> data.
          </Threat>

          <Threat id="A-10" status="ok" title="Math overflow">
            Every multiplication uses <Code>checked_mul</Code> and returns <Code>MathOverflow</Code> on overflow. Indices grow at a bounded rate; even at 80 % apr, <Code>borrow_index</Code> reaches <Code>u128::MAX</Code> only on geological timescales. Tests <Code>wad_mul_overflow_returns_err</Code>, <Code>accrue_full_utilization_maximum_rate</Code>, and the index-progression suite (<Code>math.rs:286-466</Code>) validate boundary behaviour.
          </Threat>

          <Threat id="A-11" status="ok" title="PDA collision / owner spoofing">
            Every state-mutating instruction either (a) derives the PDA and compares to the supplied address, or (b) calls <Code>verify_binding(owner, pool)</Code> after discriminator + size validation. Discriminator + PDA-derivation together imply program ownership — a non-Veil-owned account at the derived PDA is impossible because PDA accounts can only be created with the program as signer.
          </Threat>

          <Threat id="A-12" status="warn" title="Token-program hardening (defense in depth)">
            Veil&apos;s SPL transfers go through <Code>pinocchio_token::Transfer</Code>, which uses a hardcoded SPL Token program ID for the CPI target. The runtime then requires that program ID to be present in the transaction&apos;s account list. This means a malicious caller cannot redirect transfers — a fake account at index <Mono>[token_program]</Mono> would simply not be the SPL Token program, so the CPI would fail when the runtime cannot find SPL Token in the tx. <strong>Defence</strong>: add an explicit <Code>accounts[token_program].address() == TOKEN_PROGRAM_ID</Code> check up front so failures are surfaced as <Code>InvalidAccountOwner</Code> instead of an opaque CPI error, and guard against future pinocchio_token API changes.
          </Threat>

          <Threat id="A-13" status="warn" title="Account aliasing on identical positions">
            If a user supplies the same token account for both <Code>user_token</Code> and <Code>vault</Code>, an SPL self-transfer occurs (a no-op for normal token programs). The program would then mutate <Code>total_deposits</Code> as if a real deposit had happened. <strong>Defence</strong>: assert <Code>accounts[user_token].address() != accounts[vault].address()</Code> in deposit/withdraw/borrow/repay/liquidate. SPL token program currently rejects mismatched authority on self-transfers, but defence in depth is cheap.
          </Threat>

          <Threat id="A-14" status="warn" title="Decimal-mismatch in cross-asset HF">
            Single-asset positions (current design) sidestep this entirely — deposits and debts are denominated in the same token. If v1 introduces multi-asset positions, the HF formula needs decimal normalisation against the oracle-USD value, not raw token amounts. <strong>Defence</strong>: explicit assertion now that all instructions enforce single-asset denomination via the pool binding check; document the cross-asset extension before implementing it.
          </Threat>

          <H3 n="13.2">On-chain · cross-program vectors</H3>

          <Threat id="X-01" status="err" title="dWallet liquidation settlement">
            A position with status <Code>LIQUIDATED</Code> is bricked: <Code>IkaRelease</Code> (status check rejects) and <Code>IkaSign</Code> (status must be Active). The intended recovery — liquidator claims the dWallet&apos;s native chain assets — is not yet wired in v0.1. <strong>Required for cross-chain mainnet</strong>: a dedicated <Code>IkaLiquidate</Code> instruction or an ownership-transfer pathway.
          </Threat>

          <Threat id="X-02" status="ok" title="dWallet authority binding">
            <Code>IkaRegister</Code> verifies <Code>dwallet.discriminator == 2</Code>, <Code>dwallet.state == 1</Code> (DKG complete), and <Code>dwallet.authority == cpi_authority</Code> (Veil controls signing). The CPI authority PDA is at <Code>[b&quot;__ika_cpi_authority&quot;]</Code>. Only Veil can therefore approve signing while the position is open.
          </Threat>

          <Threat id="X-03" status="warn" title="Veil approves signing, not transaction content">
            <Code>IkaSign</Code> CPIs <Code>approve_message</Code> on the Ika program. Veil does not parse the underlying Bitcoin script or Ethereum calldata. The user is expected to construct and broadcast the transaction themselves. A malicious owner can obtain a signature for any valid message digest. <strong>Defence</strong>: this is the documented model — the protocol authorises signing, not a specific transaction. Front-ends should display the message digest so users review what they sign.
          </Threat>

          <H3 n="13.3">Off-chain · API and database vectors</H3>

          <Threat id="O-01" status="ok" title="SQL injection">
            All queries use parameterised tagged-template literals via Neon&apos;s driver. No string concatenation builds SQL.
          </Threat>

          <Threat id="O-02" status="ok" title="Replay / cross-action / cross-pubkey signature reuse">
            Nonces are 16 random bytes (128-bit), single-use via atomic <Code>DELETE … RETURNING</Code>, scoped per <Code>(pubkey, action)</Code>, and TTL-expired after 5 minutes. The signed canonical message bakes in <Em>both</Em> the nonce and the action, so a sig produced for <Mono>add_admin:X:role</Mono> cannot be replayed as <Mono>revoke_admin:X</Mono>.
          </Threat>

          <Threat id="O-03" status="warn" title="Phishing / domain binding (SIWE-style)">
            The current canonical message does not include a domain or origin. A phishing site could ask the wallet to sign <Mono>Veil admin auth ...</Mono> indistinguishable from the real one. <strong>Defence</strong>: add an <Code>Origin: https://veil.xyz</Code> line to the canonical message (EIP-4361 / SIWE pattern). Reject signatures whose canonical message omits or mismatches the expected origin server-side.
          </Threat>

          <Threat id="O-04" status="warn" title="Database compromise leverage">
            If <Code>DATABASE_URL</Code> leaks: an attacker can <Mono>INSERT</Mono> themselves into <Code>pool_admins</Code> and bypass the signed-nonce flow entirely. The on-chain <Code>pool.authority</Code> is independent — existing pools remain governed by their on-chain authorities — but the attacker can register new pools into the canonical index. <strong>Defence</strong>: rotate <Code>DATABASE_URL</Code> on team membership changes; treat as Stripe-key-grade secret. <strong>Stronger</strong>: separate Postgres roles — read-only user for read endpoints, writer that cannot touch <Code>pool_admins</Code> for writes, dedicated super-admin role for allowlist ops, with column-level ACLs. <strong>Strongest</strong>: require 2-of-N signed nonces from distinct super-admins for allowlist mutations.
          </Threat>

          <Threat id="O-05" status="open" title="Rate limiting · DoS surface">
            No rate limiting on <Code>/api/auth/nonce</Code>. An attacker can pump the <Code>auth_nonces</Code> table arbitrarily. The opportunistic GC (<Code>DELETE WHERE expires_at &lt; now()</Code> on every nonce issuance) caps growth, but the attack still consumes DB resources. <strong>Required for mainnet</strong>: per-IP and per-pubkey rate limits at the edge (Vercel Edge Config / Cloudflare WAF). Enforce a cap on rows per <Code>pubkey</Code> in <Code>auth_nonces</Code>.
          </Threat>

          <Threat id="O-06" status="warn" title="Time-of-check / time-of-use on role">
            Within a single auth handler the sequence is: (1) verify signature, (2) consume nonce, (3) read role. An admin revoked between steps 2 and 3 is still admitted for that one request. The window is microseconds in practice but exists. <strong>Defence</strong>: combine the nonce consume and role check into a single SQL statement (<Code>DELETE … WHERE EXISTS (SELECT 1 FROM pool_admins …)</Code>) — atomic both-or-neither.
          </Threat>

          <Threat id="O-07" status="ok" title="React XSS surface">
            The dApp renders pubkeys, labels, and tx signatures from the API. React escapes by default. No usage of <Code>dangerouslySetInnerHTML</Code> in rendered admin lists.
          </Threat>

          <Threat id="O-08" status="ok" title="CORS / cross-origin misuse">
            All <Code>/api/*</Code> routes are same-origin in the Next.js deployment. No cross-origin CORS headers are set. A malicious site cannot trigger a privileged write because (a) the wallet&apos;s signMessage requires user approval, (b) the canonical message is unique per call, (c) the nonce is single-use. Domain binding (O-03) closes the remaining vector.
          </Threat>

          <Threat id="O-09" status="warn" title="Logging / observability hygiene">
            Server logs may contain pubkeys, nonces, and signatures. None are private secrets, but logging signatures is bad hygiene. <strong>Defence</strong>: redact <Code>signature</Code> from logs; never log <Code>DATABASE_URL</Code>; forward errors to a typed sink (Sentry) rather than stdout.
          </Threat>

          <Threat id="O-10" status="warn" title="Secret exposure in client bundle">
            <Code>DATABASE_URL</Code> is server-only; it must never be prefixed with <Code>NEXT_PUBLIC_</Code>. <strong>Defence</strong>: a CI lint rule that fails the build if any <Code>NEXT_PUBLIC_*</Code> var contains the substring <Code>postgres</Code> or <Code>password</Code>.
          </Threat>

          <H3 n="13.4">Cryptographic / privacy vectors</H3>

          <Threat id="P-01" status="ok" title="FHE solvency soundness">
            The user holds the FHE private key off-chain and could encrypt arbitrary values, but the program only acts on encrypted balances that <Em>it</Em> has updated homomorphically — starting from the user&apos;s own (publicly recorded) plaintext seed at <Code>EnablePrivacy</Code>. The user cannot unilaterally inflate.
          </Threat>

          <Threat id="P-02" status="warn" title="FHE timing side-channels">
            Private operations produce transactions with sizes proportional to FHE ciphertext sizes, which leak operation type. Network observers can fingerprint <Mono>PrivateBorrow</Mono> versus <Mono>PrivateRepay</Mono> by tx size and account count. <strong>Defence</strong>: pad ciphertext payloads to a uniform size; document this is amount privacy, not behaviour privacy.
          </Threat>

          <Threat id="P-03" status="ok" title="Nonce entropy">
            16 random bytes from <Code>nacl.randomBytes</Code>. Brute force infeasible.
          </Threat>

          <Threat id="P-04" status="ok" title="ed25519 signature verification">
            TweetNaCl <Code>sign.detached.verify</Code> over the canonical message bytes. The verifier rejects 32-byte pubkeys and 64-byte signatures of incorrect length before calling into the curve library.
          </Threat>

          <H3 n="13.5">Hardening checklist before mainnet</H3>
          <Pre label="MAINNET CHECKLIST">{`[ ]  pool.authority is a Squads multisig vault PDA
[ ]  Squads is fronted by a governance program with timelock
[ ]  UpdatePool deltas capped per block at the program level
[ ]  Initialize takes expected-pyth-feed in data (closes A-04, A-09)
[ ]  IkaLiquidate / dWallet ownership-transfer instruction shipped (X-01)
[ ]  Per-IP and per-pubkey rate limit on /api/auth/nonce (O-05)
[ ]  Origin baked into canonical signed message (O-03)
[ ]  Postgres least-privilege roles for read / write / super-admin (O-04)
[ ]  Signature redaction in server logs (O-09)
[ ]  CI guard rejecting NEXT_PUBLIC_*postgres* variables (O-10)
[ ]  Atomic role check + nonce consume in one SQL statement (O-06)
[ ]  Token-program-id explicit assertion in every transfer instruction (A-12)
[ ]  user_token != vault assertion in deposit/withdraw/borrow/repay (A-13)
[ ]  Oracle keeper: refresh atomically with sensitive ix (A-07)
[ ]  Audit (third-party, scope: full program + API)`}</Pre>

          {/* ── 14 Comparison ── */}
          <H2 id="comparison" n="14" tag="DELTA">Comparison: Aave V3</H2>
          <Table head={["Property", "Aave V3", "Veil v0.1"]} rows={[
            ["Chain",                 "EVM",                                    "Solana (Pinocchio)"],
            ["Account model",         "One Pool contract w/ many reserves",     "One PDA per token"],
            ["Discriminator",         "4-byte function selector",               "1-byte instruction tag"],
            ["Interest model",        "Two-slope kink",                         "Two-slope kink (identical math)"],
            ["Index basis",           <Mono key="1">RAY (1e27)</Mono>,            <Mono key="1">WAD (1e18)</Mono>],
            ["Health factor",         "Σ collateral × LT / Σ debt",             "collateral × LT / debt, single-asset position"],
            ["Close factor",          "50 % default",                           "50 % default"],
            ["Liquidation bonus",     "Per-asset config",                       "Per-pool config (default 5 %)"],
            ["Flash loans",           "flashLoan / Simple, 5 bps",              "Single primitive, 9 bps default"],
            ["Cross-chain collateral", "Wrapped tokens",                        "Native via Ika dWallet"],
            ["Privacy",               "None",                                   "Optional FHE (REFHE)"],
            ["Admin",                 "PoolAdmin / RiskAdmin / governance",     "pool.authority + optional off-chain allowlist"],
          ]} />
          <P>
            Two structural differences are worth highlighting. <Em>Single-asset positions</Em>: a Veil <Code>UserPosition</Code> is bound to one pool — you can deposit USDC and borrow USDC against it, but not deposit BTC and borrow USDC. Cross-asset positions are a v1 design item. <Em>Native vs wrapped cross-chain</Em>: Aave-on-Solana via wrapped BTC requires a bridge custody assumption. Veil-via-Ika requires an MPC committee honesty assumption with the user as a co-signer. The trust profile is different in kind, not just degree.
          </P>

          {/* ── 15 Roadmap ── */}
          <H2 id="roadmap" n="15" tag="ROADMAP">Roadmap & Open Items</H2>
          <Table monoCol={[1]} head={["ITEM", "STATUS"]} rows={[
            ["Pinocchio core (21 ix)",                       <Pill key="1" tone="ok">DONE</Pill>],
            ["TypeScript SDK",                               <Pill key="1" tone="ok">DONE</Pill>],
            ["Off-chain allowlist + signed-nonce auth",      <Pill key="1" tone="ok">DONE</Pill>],
            ["Neon-backed pool/position cache",              <Pill key="1" tone="ok">DONE</Pill>],
            ["Liquidation UI",                               <Pill key="1" tone="ok">DONE</Pill>],
            ["Encrypt SDK pinocchio 0.11 wiring",            <Pill key="1" tone="warn">PEND</Pill>],
            ["Pyth pull-oracle migration",                   <Pill key="1" tone="warn">ROAD</Pill>],
            ["Ika dWallet mainnet integration",              <Pill key="1" tone="warn">PEND</Pill>],
            ["IkaLiquidate / dWallet liq settlement (X-01)", <Pill key="1" tone="err">OPEN</Pill>],
            ["Initialize squat / first-call hijack mitigation (A-04, A-09)", <Pill key="1" tone="err">OPEN</Pill>],
            ["Origin-bound canonical signing (O-03)",        <Pill key="1" tone="warn">v1</Pill>],
            ["Rate limiting · /api/auth/nonce (O-05)",       <Pill key="1" tone="err">PRE-MAINNET</Pill>],
            ["Cross-asset (multi-collateral) positions",     <Pill key="1" tone="warn">v1</Pill>],
            ["Audit",                                        <Pill key="1" tone="err">PRE-MAINNET</Pill>],
            ["Mainnet deploy",                               <Pill key="1" tone="err">PRE-MAINNET</Pill>],
          ]} />

          {/* ── 16 Errors ── */}
          <H2 id="errors" n="16" tag="APPENDIX A">Error Codes</H2>
          <P>All 28 error variants. Source: <Code>programs/src/errors.rs:5-62</Code>.</P>
          <Table monoCol={[0, 1]} head={["CODE", "VARIANT", "MEANING"]} rows={[
            ["6000", "MissingSignature",            "Caller is not a signer when required"],
            ["6001", "AccountNotWritable",          "Account is not writable when required"],
            ["6002", "InvalidAccountOwner",         "Account owner is not this program"],
            ["6003", "InvalidDiscriminator",        "Account discriminator does not match"],
            ["6004", "InvalidPda",                  "PDA derivation mismatch"],
            ["6005", "InvalidInstructionData",      "Instruction data is malformed"],
            ["6006", "ZeroAmount",                  "Amount is zero"],
            ["6007", "InsufficientLiquidity",       "Pool has insufficient liquidity"],
            ["6008", "ExceedsCollateralFactor",     "Borrow would exceed LTV"],
            ["6009", "Undercollateralised",         "HF would drop below 1.0"],
            ["6010", "PositionHealthy",             "HF ≥ 1.0; liquidation refused"],
            ["6011", "ExceedsCloseFactor",          "Liquidation repay > close-factor cap"],
            ["6012", "ExceedsDepositBalance",       "Withdraw > deposit_shares' balance"],
            ["6013", "ExceedsDebtBalance",          "Repay > current debt"],
            ["6014", "NoBorrow",                    "No debt to act on"],
            ["6015", "MathOverflow",                "Arithmetic overflow"],
            ["6016", "TransferFailed",              "SPL transfer CPI failed"],
            ["6017", "InvalidTimestamp",            "Clock went backwards"],
            ["6018", "FlashLoanActive",             "Flash already in flight"],
            ["6019", "FlashLoanNotActive",          "FlashRepay without active flash"],
            ["6020", "FlashLoanRepayInsufficient",  "Repay < amount + fee"],
            ["6021", "Unauthorized",                "Signer ≠ pool.authority"],
            ["6022", "PoolPaused",                  "Deposit/Borrow/FlashBorrow blocked"],
            ["6023", "NoFeesToCollect",             "accumulated_fees == 0"],
            ["6024", "OracleInvalid",               "Pyth account malformed"],
            ["6025", "OraclePriceStale",            "Pyth status ≠ Trading"],
            ["6026", "OraclePriceFeedMismatch",     "Anchored feed mismatch"],
            ["6027", "OracleConfTooWide",           "Pyth conf > 2 % of price"],
          ]} />

          {/* ── 17 External IDs ── */}
          <H2 id="external-ids" n="17" tag="APPENDIX B">External Program IDs</H2>
          <Table monoCol={[1]} head={["PROGRAM", "ID", "USED BY"]} rows={[
            ["Ika dWallet",     "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY", "IkaRegister/Sign/Release"],
            ["Encrypt",         "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8", "EnablePrivacy + Private*"],
            ["SPL Token",       "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "All token transfers"],
            ["Associated Token","ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn", "Vault ATA derivation"],
            ["System",          "11111111111111111111111111111111",             "Account creation"],
          ]} />

          {/* ── 18 References ── */}
          <H2 id="references" n="18" tag="REFS">References</H2>
          <ol style={{
            listStyle: "none", padding: 0, margin: 0,
            fontFamily: fSans, fontSize: 13, lineHeight: 1.7, color: t.cite,
          }}>
            {[
              ["Aave V3", "Whitepaper. Two-slope kink interest model, close-factor and liquidation-bonus design."],
              ["Compound V2", "Earliest production deployment of the index-based share-accounting model."],
              ["Pinocchio", <span key="1">Solana zero-copy program framework. <Mono>github.com/febo/pinocchio</Mono></span>],
              ["Pyth Network", <span key="1">Push-oracle aggregation across publishers. <Mono>pyth.network</Mono></span>],
              ["Ika dWallet protocol", <span key="1">Programmable MPC signing for cross-chain assets. <Mono>github.com/dwallet-labs/ika</Mono></span>],
              ["Encrypt FHE / REFHE", <span key="1">Fully-homomorphic-encryption construction used for amount privacy. <Mono>docs.encrypt.xyz</Mono></span>],
              ["Oro / GRAIL", <span key="1">Physical-gold settlement layer. <Mono>docs.grail.oro.finance</Mono></span>],
              ["EIP-4361 (SIWE)", "Sign-In with Ethereum — domain-bound canonical message format. Referenced as model for O-03."],
              ["Veil program source", <Mono key="1">programs/src/</Mono>],
              ["Veil dApp + API",     <Mono key="1">veil-landing/</Mono>],
              ["Veil docs site",      <Mono key="1">docs/content/</Mono>],
            ].map(([title, body], i) => (
              <li key={i} style={{
                display: "grid", gridTemplateColumns: "44px 1fr", gap: 12,
                padding: "8px 0", borderBottom: `1px solid ${t.hairSoft}`,
              }}>
                <span style={{ fontFamily: fMono, color: t.fade, fontSize: 12 }}>
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

          {/* ── Footer CTA ── */}
          <div style={{ marginTop: 80, paddingTop: 32, borderTop: `1px solid ${t.line}` }}>
            <div style={{
              fontFamily: fMono, fontSize: 11, letterSpacing: ".22em",
              color: t.mute, textTransform: "uppercase", marginBottom: 14,
            }}>END OF DOCUMENT</div>
            <h3 style={{
              fontFamily: fSerif, fontSize: 30, lineHeight: 1.1,
              letterSpacing: "-0.025em", fontWeight: 400, color: t.ink,
              margin: "0 0 22px",
            }}>From spec to chain.</h3>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <CTA href="/program-reference" primary>PROGRAM REF →</CTA>
              <CTA href="/integration">INTEGRATION GUIDE</CTA>
              <CTA href="/security">SECURITY</CTA>
              <CTA href="/">DOCS HOME</CTA>
            </div>
          </div>
        </main>
      </div>

      {/* Page footer */}
      <footer style={{ borderTop: `1px solid ${t.hair}`, padding: "28px 28px", marginTop: 56, background: t.paperEdge }}>
        <div style={{
          maxWidth: 1180, margin: "0 auto", display: "flex",
          alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16,
        }}>
          <div style={{ fontFamily: fMono, fontSize: 11, letterSpacing: ".22em",
            color: t.mute, textTransform: "uppercase" }}>
            VEIL · WHITEPAPER · v0.1 · 2026 · §§ 0–18 · EOD
          </div>
          <div style={{ fontFamily: fMono, fontSize: 11, letterSpacing: ".18em",
            color: t.fade, textTransform: "uppercase" }}>
            SOURCE-GROUNDED · PRE-AUDIT · DEVNET
          </div>
        </div>
      </footer>
    </div>
    </MobileCtx.Provider>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const Meta = ({ label, value, last }: { label: string; value: string; last?: boolean }) => {
  const m = useMobile();

  return (
    <div style={{
      padding: m ? "10px 12px" : "16px 18px",
      borderRight: last || m ? "none" : `1px solid ${t.hair}`,
      borderBottom: m && !last ? `1px solid ${t.hairSoft}` : "none",
    }}>
      <div style={{
        fontFamily: fMono, fontSize: 9.5, letterSpacing: ".22em",
        textTransform: "uppercase", color: t.mute, marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontFamily: fMono, fontSize: m ? 11 : 12, letterSpacing: ".05em",
        color: t.ink, fontWeight: 600,
      }}>{value}</div>
    </div>
  );
};

const navLinkStyle: CSSProperties = {
  fontFamily: fMono, fontSize: 11, letterSpacing: ".22em",
  textTransform: "uppercase", color: t.text, textDecoration: "none",
};
const navLinkStyleSmall: CSSProperties = {
  fontFamily: fMono, fontSize: 10.5, letterSpacing: ".18em",
  textTransform: "uppercase", color: t.text, textDecoration: "none",
  lineHeight: 1.9,
};

const CTA = ({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) => {
  return (
    <Link href={href} style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "10px 18px",
      fontFamily: fMono, fontSize: 11.5, letterSpacing: ".22em",
      textTransform: "uppercase", fontWeight: 600,
      textDecoration: "none",
      border: `1px solid ${t.line}`,
      background: primary ? t.ink : "transparent",
      color: primary ? t.paper : t.ink,
      borderRadius: 0,
      transition: "background 120ms, color 120ms",
    }}>{children}</Link>
  );
};

// ─── Threat row ─────────────────────────────────────────────────────────────

const Threat = ({
  id, status, title, children,
}: {
  id: string;
  status: "ok" | "warn" | "err" | "open";
  title: string;
  children: ReactNode;
}) => {
  const m = useMobile();
  const statusToTone: Record<string, "ok" | "warn" | "err"> = {
    ok: "ok", warn: "warn", err: "err", open: "err",
  };
  const tone = statusToTone[status];
  const label = { ok: "SAFE", warn: "DEFENSE", err: "OPEN", open: "OPEN" }[status];

  return (
    <div style={{
      display: m ? "block" : "grid", gridTemplateColumns: "auto 1fr", gap: 16,
      padding: "16px 0", borderBottom: `1px solid ${t.hairSoft}`,
    }}>
      <div style={{
        display: "flex", flexDirection: m ? "row" : "column", gap: 6,
        alignItems: m ? "center" : "flex-start", minWidth: m ? undefined : 88,
        marginBottom: m ? 10 : 0,
      }}>
        <Pill tone={tone}>{label}</Pill>
        <Mono style={{ fontSize: 11, color: t.mute, letterSpacing: ".15em" }}>{id}</Mono>
      </div>
      <div>
        <div style={{
          fontFamily: fSans, fontSize: 15, fontWeight: 600,
          color: t.ink, marginBottom: 6, letterSpacing: "-0.005em",
        }}>{title}</div>
        <div style={{
          fontFamily: fSans, fontSize: 14, lineHeight: 1.7, color: t.text,
        }}>{children}</div>
      </div>
    </div>
  );
};
