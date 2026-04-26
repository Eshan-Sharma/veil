"use client";

import { useEffect, useState } from "react";

const cipherPool = [
  "7fA9·12Ce·88aD",
  "E4b2·9C01·F7dd",
  "A1b3·44Cc·ZzQ9",
  "5D0e·09Bc·4F8a",
  "Q7x2·MmN4·L20p",
  "9cE4·DdE1·0aBb",
];

function useCipher(seed = 0) {
  const [i, setI] = useState(seed);

  useEffect(() => {
    const t = setInterval(() => setI((p) => (p + 1) % cipherPool.length), 2400 + seed * 220);

    return () => clearInterval(t);
  }, [seed]);
  return cipherPool[i];
}

function EncryptedStat({ label, seed, mask }: { label: string; seed: number; mask: string }) {
  const v = useCipher(seed)

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl bg-zinc-50/80 p-3 ring-1 ring-zinc-100">
      <div className="flex items-center gap-1 text-[10px] font-semibold tracking-[0.12em] text-zinc-500">
        <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" className="text-violet-600">
          <path d="M4.5 7V5a3.5 3.5 0 117 0v2h.5a1 1 0 011 1v5a1 1 0 01-1 1h-8a1 1 0 01-1-1V8a1 1 0 011-1h.5zM6 5v2h4V5a2 2 0 10-4 0z" />
        </svg>
        {label}
      </div>
      <div className="truncate text-[15px] font-semibold tabular-nums text-zinc-900">
        <span className="cipher-mask rotate-cipher">{mask}</span>
      </div>
      <div className="mono truncate text-[10px] text-zinc-400">ct: {v}</div>
    </div>
  );
}

const btcRows = [
  { tag: "FHE", k: "health rebase", ref: "0xA4f2·…91ce", t: "now", tone: "violet" },
  { tag: "PYTH", k: "BTC  $63,410", ref: "0x71c9·…02af", t: "1s", tone: "zinc" },
  { tag: "RATE", k: "kink tick 6.2%", ref: "0x9eD1·…77b0", t: "5s", tone: "zinc" },
  { tag: "dWALLET", k: "2-of-3 co-sign", ref: "ika::btc/m/0'", t: "9s", tone: "emerald" },
];

const goldRows = [
  { tag: "FHE", k: "health rebase", ref: "0xB9c1·…33ff", t: "now", tone: "violet" },
  { tag: "PYTH", k: "XAU  $2,940/oz", ref: "0xC2d4·…87ab", t: "1s", tone: "zinc" },
  { tag: "RATE", k: "kink tick 4.1%", ref: "0xA1f3·…55c0", t: "6s", tone: "zinc" },
  { tag: "ORO", k: "gold custody verified", ref: "oro::xau/vault/7", t: "12s", tone: "amber" },
];

export const PositionCard = () => {
  const [vault, setVault] = useState<"btc" | "gold">("btc");
  const isBtc = vault === "btc"

  return (
    <div className="relative fade-rise">
      <div className="glass-card relative overflow-hidden rounded-[28px] p-5 sm:p-6">
        {/* Vault switcher */}
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-1">
          <button
            onClick={() => setVault("btc")}
            className={`flex-1 rounded-xl py-2 text-[12.5px] font-semibold transition ${
              isBtc ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px]">₿</span> Native BTC
            </span>
          </button>
          <button
            onClick={() => setVault("gold")}
            className={`flex-1 rounded-xl py-2 text-[12.5px] font-semibold transition ${
              !isBtc ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px]">◈</span> Physical Gold
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2 pb-4">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-300/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-300/80" />
          </div>
          <div className="ml-3 flex-1 text-[11px] font-semibold tracking-[0.12em] text-zinc-500">
            VAULT · VLT_0x3F…A91 · SOLANA
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-1 text-[10.5px] font-semibold tracking-wide text-emerald-700 ring-1 ring-emerald-100">
            <span className="pulse-dot" />
            LIVE
          </span>
        </div>

        <div className="flex items-start gap-3">
          {isBtc ? (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-orange-400 to-amber-500 text-white shadow-inner">
              <svg viewBox="0 0 32 32" width="22" height="22" fill="currentColor">
                <path d="M20.3 13.8c.5-1.4-.6-2.2-2-2.8l.5-1.9-1.2-.3-.4 1.8-1-.2.4-1.8-1.2-.3-.5 1.9-2.3-.6-.3 1.3s.9.2.9.2c.5.1.6.5.6.7l-1 4c-.1.1-.3.3-.7.2 0 0-.9-.2-.9-.2l-.6 1.4 2.2.5-.5 1.9 1.2.3.5-1.9 1 .2-.5 1.9 1.2.3.5-1.9c2 .4 3.5.3 4.2-1.6.5-1.5 0-2.4-1.1-2.9 1-.2 1.6-.8 1.9-2zM18 16.9c-.3 1.4-2.7.7-3.5.5l.6-2.5c.7.2 3.3.5 2.9 2zm.3-3.6c-.3 1.3-2.3.7-3 .5l.6-2.2c.6.1 2.7.4 2.4 1.7z" />
              </svg>
            </div>
          ) : (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-yellow-400 to-amber-600 text-white shadow-inner">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6L12 15l-4.9 2.6.9-5.6-4-4 5.6-.8z"/>
              </svg>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold tracking-tight text-zinc-900">
              {isBtc ? "Native Bitcoin vault" : "Physical gold vault (XAU)"}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-zinc-500">
              {isBtc ? (
                <>
                  <span className="mono">btc::1P…qL9x</span>
                  <span>·</span>
                  <span>signed by Ika dWallet · MPC 2-of-3</span>
                </>
              ) : (
                <>
                  <span className="mono">oro::xau/vault/7</span>
                  <span>·</span>
                  <span>custody via Oro · GRAIL</span>
                </>
              )}
            </div>
          </div>
          <button className="hidden h-8 items-center gap-1.5 rounded-full border border-zinc-200 bg-white/80 px-3 text-[11.5px] font-semibold text-zinc-900 sm:inline-flex">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" className="text-violet-600">
              <path d="M8 1.5a3 3 0 00-3 3V7H4a1 1 0 00-1 1v5.5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3z" />
            </svg>
            Decrypt · owner
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2.5">
          {isBtc ? (
            <>
              <EncryptedStat label="COLLATERAL" seed={0} mask="◉◉◉.◉◉◉◉ BTC" />
              <EncryptedStat label="BORROWED" seed={1} mask="$◉◉,◉◉◉ USDC" />
              <EncryptedStat label="HEALTH" seed={2} mask="◉.◉◉×" />
            </>
          ) : (
            <>
              <EncryptedStat label="COLLATERAL" seed={3} mask="◉◉.◉◉ oz XAU" />
              <EncryptedStat label="BORROWED" seed={4} mask="$◉◉,◉◉◉ USDC" />
              <EncryptedStat label="HEALTH" seed={5} mask="◉.◉◉×" />
            </>
          )}
        </div>

        <div className="mt-5 rounded-2xl border border-zinc-100 bg-white/70 p-4">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.12em] text-zinc-500">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="text-violet-600">
                <path d="M11 1l-6 8h3l-1 6 6-8h-3l1-6z" />
              </svg>
              {isBtc ? "FHE ORACLE STREAM" : "FHE ORACLE STREAM · GOLD"}
            </div>
            <span className="mono text-[10px] text-zinc-400">slot 287,394,112</span>
          </div>
          <ul className="space-y-2">
            {(isBtc ? btcRows : goldRows).map((r, i) => (
              <li key={i} className="flex items-center gap-3 text-[12.5px]">
                <span
                  className={
                    "rounded-md px-1.5 py-0.5 text-[9.5px] font-bold tracking-wider " +
                    (r.tone === "violet"
                      ? "bg-violet-100 text-violet-800"
                      : r.tone === "emerald"
                      ? "bg-emerald-100 text-emerald-800"
                      : r.tone === "amber"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-zinc-100 text-zinc-700")
                  }
                >
                  {r.tag}
                </span>
                <span className="flex-1 truncate text-zinc-800">{r.k}</span>
                <span className="mono hidden text-[10.5px] text-zinc-400 sm:inline">{r.ref}</span>
                <span className="mono text-[10.5px] text-zinc-400">{r.t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-4">
          <div className="flex items-center gap-2 text-[12px] text-zinc-600">
            <span className="inline-grid h-5 w-5 place-items-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8l3 3 7-7" />
              </svg>
            </span>
            Solvency proof verified
            <span className="text-zinc-300">·</span>
            <span className="mono text-[11px] text-zinc-500">REFHE</span>
          </div>
          <button className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-700 via-fuchsia-600 to-rose-500 px-3 text-[11.5px] font-semibold text-white">
            Open position
          </button>
        </div>
      </div>

      <div className="absolute -left-6 top-24 hidden rotate-[-4deg] rounded-2xl border border-zinc-200/70 bg-white/80 px-3 py-2 text-[11.5px] font-medium text-zinc-700 shadow-lg backdrop-blur sm:block">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-orange-100 text-orange-600">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><circle cx="8" cy="8" r="7" /></svg>
          </span>
          <span>{isBtc ? "Native BTC · no bridge" : "Physical gold · Oro custody"}</span>
        </div>
      </div>
      <div className="absolute -right-5 -bottom-3 hidden rotate-[3deg] rounded-2xl border border-zinc-200/70 bg-white/80 px-3 py-2 text-[11.5px] font-medium text-zinc-700 shadow-lg backdrop-blur sm:block">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-violet-100 text-violet-700">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M8 1l2 5 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1z"/></svg>
          </span>
          <span>Encrypted by Encrypt · REFHE</span>
        </div>
      </div>
    </div>
  );
}
