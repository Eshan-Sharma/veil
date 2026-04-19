const personas = [
  {
    name: "Alex",
    role: "Portfolio Manager",
    quote: "I'm not pledging native BTC to anything I can't walk away from.",
    priorities: ["Custody", "Privacy", "Liquidity", "Simplicity"],
    win: "Native BTC / ETH as collateral without adding a trust layer, positions encrypted end-to-end.",
    gradient: "from-violet-600 to-fuchsia-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm-7 9a7 7 0 0114 0H5z"/></svg>
    ),
  },
  {
    name: "Bob",
    role: "Market Maker",
    quote: "Visible inventory is a subsidy I'm paying my competitors.",
    priorities: ["Execution speed", "Strategy hiding", "Low fees", "Throughput"],
    win: "Borrow on demand, deploy into MM / arb, repay fast — with inventory hidden from mempool watchers.",
    gradient: "from-sky-500 to-indigo-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 17l5-6 4 4 8-9v4l-8 9-4-4-5 6z"/></svg>
    ),
  },
  {
    name: "Charlie",
    role: "DAO Treasury Manager",
    quote: "We need yield without forcing the DAO to vote on a bridge.",
    priorities: ["Governance-friendly", "Conservative risk", "Auditable invariants", "No contentious bridges"],
    win: "Unlock treasury BTC / ETH for yield while keeping positions and strategy off the public feed.",
    gradient: "from-emerald-500 to-teal-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 10l9-6 9 6v2H3v-2zm1 3h16v7H4v-7zm2 2v3h2v-3H6zm4 0v3h2v-3h-2zm4 0v3h2v-3h-2z"/></svg>
    ),
  },
  {
    name: "Diana",
    role: "Family Office · Gold Holder",
    quote: "My gold has sat in custody for a decade earning nothing. That has to change.",
    priorities: ["Gold productivity", "TradFi-grade custody", "No counterparty risk", "Simple integration"],
    win: "Pledge physical gold via Oro/GRAIL as DeFi collateral — the first time gold has ever been productive on-chain.",
    gradient: "from-yellow-400 to-amber-600",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6L12 15l-4.9 2.6.9-5.6-4-4 5.6-.8z"/></svg>
    ),
  },
];

export default function Personas() {
  return (
    <section id="personas" className="relative overflow-hidden">
      <div className="mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
            Who it's for
          </span>
          <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
            Built for capital that{" "}
            <span className="serif-italic text-violet-700">can't be seen moving.</span>
          </h2>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-zinc-600">
            Portfolio managers, market makers, DAO treasuries, and gold holders each get the same primitives — native collateral, encrypted state, cross-chain settlement — with different use cases.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {personas.map((p) => (
            <article key={p.name} className="group relative overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 p-7 backdrop-blur transition hover:shadow-[0_30px_80px_-40px_rgba(76,29,149,0.35)]">
              <div className="flex items-center gap-3">
                <div className={"grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br " + p.gradient + " text-white"}>
                  {p.icon}
                </div>
                <div>
                  <div className="text-[17px] font-semibold tracking-tight text-zinc-900">{p.name}</div>
                  <div className="text-[12.5px] text-zinc-500">{p.role}</div>
                </div>
              </div>
              <blockquote className="mt-5 border-l-2 border-violet-300 pl-4 text-[15px] leading-relaxed">
                <span className="serif-italic text-zinc-800">"{p.quote}"</span>
              </blockquote>
              <div className="mt-5 space-y-2">
                <div className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Cares about</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.priorities.map((pr) => (
                    <span key={pr} className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-700">{pr}</span>
                  ))}
                </div>
              </div>
              <div className="mt-5 rounded-2xl bg-violet-50/60 p-3 text-[12.5px] text-violet-900 ring-1 ring-violet-100">
                <span className="font-semibold">Win with Veil · </span>
                {p.win}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
