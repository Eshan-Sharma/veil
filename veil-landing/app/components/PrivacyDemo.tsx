"use client";

import { useState } from "react";

export const PrivacyDemo = () => {
  const [veil, setVeil] = useState(true);

  const row = (label: string, value: string, ct: string) => (
    <div className="flex items-center justify-between border-b border-zinc-100 py-3 last:border-b-0">
      <div className="text-[13px] font-medium text-zinc-500">{label}</div>
      <div className="relative">
        <span
          className={
            "mono text-[13.5px] font-semibold transition-all " +
            (veil ? "cipher-mask rotate-cipher" : "text-zinc-900")
          }
        >
          {veil ? ct : value}
        </span>
      </div>
    </div>
  )

  return (
    <section id="privacy" className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-white/0 to-white" />
      <div className="relative mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
              Privacy, per position
            </span>
            <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
              One toggle. Every number{" "}
              <span className="serif-italic text-violet-700">becomes ciphertext.</span>
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-zinc-600">
              With Encrypt's REFHE scheme, your collateral, debt and health factor are stored on-chain as ciphertext. The lending program proves solvency without ever decrypting — observers see bytes, not dollars.
            </p>

            <ul className="mt-7 space-y-3">
              {[
                "No visible collateral ratio — no liquidation targeting",
                "No visible borrow amount — no strategy leakage",
                "No visible liq price — no front-running your unwind",
                "Invariants like health ≥ 1 still hold, verifiably",
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-[14.5px] text-zinc-700">
                  <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-violet-100 text-violet-700 ring-1 ring-violet-200">
                    <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M2 6l2.5 2.5L10 3"/></svg>
                  </span>
                  {t}
                </li>
              ))}
            </ul>

            <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-zinc-200 bg-white p-1.5 shadow-sm">
              <span className="px-3 text-[12.5px] font-semibold text-zinc-900">Privacy</span>
              <button
                onClick={() => setVeil((v) => !v)}
                aria-pressed={veil}
                className={
                  "relative h-8 w-16 rounded-full transition " +
                  (veil ? "bg-gradient-to-r from-violet-700 via-fuchsia-600 to-rose-500" : "bg-zinc-200")
                }
              >
                <span
                  className={
                    "absolute top-1 h-6 w-6 rounded-full bg-white shadow transition " +
                    (veil ? "left-9" : "left-1")
                  }
                />
              </button>
              <span className={"px-3 text-[12.5px] font-semibold " + (veil ? "text-violet-800" : "text-zinc-400")}>
                {veil ? "ON" : "OFF"}
              </span>
            </div>
          </div>

          <div className="relative">
            <div className="glass-card relative rounded-[28px] p-6">
              <div className="flex items-center justify-between pb-3">
                <div className="text-[11px] font-semibold tracking-[0.14em] text-zinc-500">
                  POSITION · VLT_0x3F…A91
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-semibold text-zinc-600">
                  <span className={"h-1.5 w-1.5 rounded-full " + (veil ? "bg-violet-600" : "bg-amber-500")} />
                  {veil ? "encrypted" : "public"}
                </span>
              </div>

              <div className="rounded-2xl border border-zinc-100 bg-white/80 p-4">
                {row("Collateral", "1.8421 BTC", "◉◉◉.◉◉◉◉ BTC")}
                {row("Borrowed", "$84,203 USDC", "$◉◉,◉◉◉ USDC")}
                {row("Liq. price", "$46,218", "$◉◉,◉◉◉")}
                {row("Health factor", "1.18×", "◉.◉◉×")}
                {row("Utilization", "62.4%", "◉◉.◉%")}
              </div>

              <div className="mt-4 flex items-center gap-2 rounded-2xl bg-zinc-50 px-3 py-2.5 text-[12px] text-zinc-600">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="text-violet-600"><path d="M8 1l2 5 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1z"/></svg>
                <span className="mono">
                  {veil ? "getAccount() → ct:  7fA9·E4b2·88aD" : "getAccount() → plaintext visible"}
                </span>
              </div>
            </div>
            <div aria-hidden className="pointer-events-none absolute -inset-12 -z-10 bg-gradient-to-br from-violet-200/50 via-fuchsia-200/40 to-rose-200/40 blur-3xl" />
          </div>
        </div>
      </div>
    </section>
  );
}
