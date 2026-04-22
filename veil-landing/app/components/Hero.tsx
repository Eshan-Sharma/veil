import PositionCard from "./PositionCard";

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-16 px-6 pt-16 pb-24 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pt-24 lg:pb-32">
        <div className="max-w-2xl fade-rise">
          <a
            href="#architecture"
            className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 py-1.5 pl-2.5 pr-3.5 text-[12.5px] font-medium text-violet-900 backdrop-blur"
          >
            <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8z"/></svg>
            </span>
            Solana × Ika × Oro/GRAIL × Encrypt FHE
            <span className="text-violet-400">·</span>
            <span className="text-violet-600">2026</span>
          </a>

          <h1 className="mt-6 text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-zinc-950 sm:text-[64px] md:text-[76px]">
            Borrow against
            <br />
            <span className="serif-italic bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-500 bg-clip-text text-transparent">
              gold,
            </span>{" "}
            <span className="serif-italic bg-gradient-to-r from-violet-700 via-fuchsia-600 to-rose-500 bg-clip-text text-transparent">
              BTC,
            </span>
            <br />
            anything.
          </h1>

          <p className="mt-7 max-w-xl text-[17px] leading-[1.65] text-zinc-600">
            Veil is the <span className="text-zinc-900 font-medium">first lending protocol on Solana</span> where you can borrow against native Bitcoin, physical gold, or any on-chain asset — with an optional privacy layer. No bridges, no wrapping.
          </p>

          <div className="mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a
              id="launch"
              href="/dapp"
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-zinc-950 pl-6 pr-5 text-[14.5px] font-semibold text-white shadow-[0_10px_30px_-12px_rgba(109,40,217,0.5)] transition hover:bg-zinc-800"
            >
              Launch app
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 transition group-hover:bg-white/20">
                <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 10h10M10 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </a>
            <a
              href="#how"
              className="inline-flex h-12 items-center gap-2.5 rounded-full border border-zinc-200 bg-white/70 px-5 text-[14.5px] font-medium text-zinc-900 backdrop-blur transition hover:bg-white"
            >
              <svg viewBox="0 0 20 20" width="14" height="14" className="text-violet-700" fill="currentColor">
                <path d="M6 4.5v11l9-5.5z" />
              </svg>
              See the 60-second walk-through
            </a>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-500">
            <span className="inline-flex items-center gap-2">
              <span className="pulse-dot" /> Devnet live · mainnet on roadmap
            </span>
            <span className="text-zinc-300">·</span>
            <span>Non-custodial</span>
            <span className="text-zinc-300">·</span>
            <span>Open-source · MIT</span>
          </div>
        </div>

        <div className="relative">
          <PositionCard />
          <div aria-hidden className="pointer-events-none absolute -inset-20 -z-10 bg-gradient-to-br from-violet-200/40 via-fuchsia-200/30 to-rose-200/30 blur-3xl" />
        </div>
      </div>
    </section>
  );
}
