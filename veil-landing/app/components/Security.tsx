const pillars = [
  {
    title: "Non-custodial by construction",
    body: "Your BTC / ETH stay in an Ika dWallet — jointly signed by you and the MPC network. No protocol admin key ever holds your collateral.",
    tag: "Custody",
  },
  {
    title: "Privacy without opt-out invariants",
    body: "The protocol still enforces solvency, health factor and utilization caps over ciphertext. Privacy never weakens public guarantees.",
    tag: "Privacy",
  },
  {
    title: "Oracle-first risk",
    body: "Pyth feeds drive the kink curve and liquidation thresholds. Rate limits and circuit-breakers protect against stale or anomalous prints.",
    tag: "Risk",
  },
  {
    title: "Atomic cross-chain settlement",
    body: "Liquidation is a single Solana ix that dispatches a dWallet signature on the origin chain. Either the native transfer settles or the debt remains.",
    tag: "Liquidation",
  },
];

export default function Security() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.2fr] lg:items-start">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
              Security model
            </span>
            <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[52px]">
              Private is only useful if{" "}
              <span className="serif-italic text-violet-700">solvent.</span>
            </h2>
            <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-zinc-600">
              Veil treats privacy and solvency as a joint property. Ciphertext hides amounts; the program proves the pool is always backed.
            </p>

            <div className="mt-8 rounded-3xl border border-zinc-200 bg-white/80 p-5">
              <div className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Current status</div>
              <ul className="mt-3 space-y-2 text-[13.5px] text-zinc-700">
                <li className="flex items-center gap-2"><Dot /> Core protocol design frozen</li>
                <li className="flex items-center gap-2"><Dot /> Architecture + invariants documented</li>
                <li className="flex items-center gap-2"><Dot /> Pinocchio implementation underway</li>
                <li className="flex items-center gap-2"><Dot /> FHE layer implemented — EncryptedPosition, 5 private instructions, graph definitions</li>
                <li className="flex items-center gap-2"><Dot /> Ika integration scaffolded; Encrypt CPI activates when SDK reaches pinocchio 0.11</li>
                <li className="flex items-start gap-2 text-amber-700"><DotWarn /> Not audited — experimental; do not deploy mainnet capital without review.</li>
              </ul>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {pillars.map((p) => (
              <div key={p.title} className="rounded-3xl border border-zinc-200 bg-white/80 p-6 backdrop-blur">
                <div className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-violet-700">{p.tag}</div>
                <div className="mt-2 text-[17px] font-semibold tracking-tight text-zinc-900">{p.title}</div>
                <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-600">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Dot() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
      <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6l2.5 2.5L10 3"/></svg>
    </span>
  );
}

function DotWarn() {
  return (
    <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-amber-50 text-amber-600 ring-1 ring-amber-100">
      <svg viewBox="0 0 12 12" width="8" height="8" fill="currentColor"><path d="M6 1l5 9H1zM5 5v3h2V5zm0 4v2h2V9z"/></svg>
    </span>
  );
}
