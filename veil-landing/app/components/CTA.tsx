export const CTA = () => {

  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 pb-24 sm:pb-32">
        <div className="relative overflow-hidden rounded-[36px] border border-white/10 bg-zinc-950 p-10 text-white sm:p-16">
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60" style={{
            backgroundImage:
              "radial-gradient(500px 260px at 10% 0%, #7c3aed 0%, transparent 55%), radial-gradient(500px 260px at 100% 100%, #db2777 0%, transparent 60%)",
          }} />
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{
            backgroundImage:
              "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
            backgroundSize: "56px 56px",
          }} />

          <div className="relative grid grid-cols-1 items-center gap-8 md:grid-cols-[1.3fr_1fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-white/80 backdrop-blur">
                The veil is up
              </span>
              <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[58px]">
                Be on-chain.{" "}
                <span className="serif-italic text-white/80">Stay off-stage.</span>
              </h2>
              <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-white/65">
                Pledge native BTC, physical gold, or any on-chain asset. Borrow in private. Keep every balance encrypted. Solana coordinates — your capital stays where it belongs.
              </p>
              <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <a href="/dapp" className="group inline-flex h-12 items-center gap-2 rounded-full bg-white pl-6 pr-5 text-[14.5px] font-semibold text-zinc-950 transition hover:bg-white/90">
                  Launch app
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-zinc-950/10">
                    <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 10h10M10 5l5 5-5 5"/></svg>
                  </span>
                </a>
                <a href={`${process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docsveil.vercel.app"}/whitepaper`} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 text-[14.5px] font-medium text-white backdrop-blur transition hover:bg-white/10">
                  Read the whitepaper
                  <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 13l6-6M7 7h6v6"/></svg>
                </a>
              </div>
            </div>

            <div className="relative">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
                <div className="flex items-center justify-between">
                  <span className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/45">ENCRYPTED · VAULT SNAPSHOT</span>
                  <span className="pulse-dot" />
                </div>
                <div className="mt-4 space-y-3 mono text-[12.5px] text-white/80">
                  <div className="flex items-center justify-between"><span className="text-white/40">collateral_ct</span><span className="cipher-mask">7fA9·12Ce·88aD</span></div>
                  <div className="flex items-center justify-between"><span className="text-white/40">debt_ct</span><span className="cipher-mask">E4b2·9C01·F7dd</span></div>
                  <div className="flex items-center justify-between"><span className="text-white/40">health_ct</span><span className="cipher-mask">A1b3·44Cc·ZzQ9</span></div>
                  <div className="flex items-center justify-between"><span className="text-white/40">dwallet_sig</span><span className="text-emerald-300">ok · 2-of-3</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
