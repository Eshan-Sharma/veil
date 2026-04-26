const steps = [
  {
    n: "01",
    eyebrow: "Pledge collateral",
    title: "Lock BTC, ETH, or physical gold — on its own chain.",
    body: "BTC and ETH stay in an Ika dWallet, jointly controlled by you and Ika's MPC network — no bridge, no custodian. Physical gold is pledged via Oro's GRAIL platform, which handles custody and compliance so you don't have to.",
    accent: "from-amber-400 to-orange-500",
    chips: ["Native BTC", "Native ETH", "Physical Gold via Oro", "MPC 2-of-3"],
  },
  {
    n: "02",
    eyebrow: "Coordinate on Solana",
    title: "A Pinocchio program tracks collateral, debt and rates.",
    body: "Zero-dep, zero-copy. The lending program enforces pool invariants, a kink-curve interest rate, and a health factor engine with compute units that scale with liquidation load.",
    accent: "from-violet-600 to-fuchsia-500",
    chips: ["Pinocchio", "Kink IRM", "Pool invariants", "Pyth oracle"],
  },
  {
    n: "03",
    eyebrow: "Borrow in private",
    title: "Flip the privacy toggle. Balances become ciphertext.",
    body: "Encrypt's REFHE stores amounts and debt as ciphertext on-chain. Health factor and solvency are computed over encrypted data — observers see nothing, the protocol verifies everything.",
    accent: "from-emerald-500 to-teal-500",
    chips: ["FHE / REFHE", "Encrypted balances", "Encrypted HF", "Public invariants"],
  },
  {
    n: "04",
    eyebrow: "Flash loans",
    title: "Borrow without collateral — atomically, in one transaction.",
    body: "Take any amount from the pool with no collateral required. Return it with a 0.09 % fee in the same transaction or it reverts. Useful for arbitrage, on-chain liquidation bots, and collateral swaps. 90 % of fees go to LPs.",
    accent: "from-sky-500 to-cyan-400",
    chips: ["No collateral", "Atomic repayment", "0.09 % fee", "90 % to LPs"],
  },
  {
    n: "05",
    eyebrow: "Liquidate cross-chain",
    title: "When health breaks, the dWallet signs settlement natively.",
    body: "An unhealthy position triggers an on-chain instruction that asks the dWallet's MPC network to co-sign a transaction on the asset's native chain. No wrapped IOU, no bridge round-trip.",
    accent: "from-rose-500 to-fuchsia-500",
    chips: ["Cross-chain settlement", "MPC co-sign", "On-native liquidation", "No wrapped IOU"],
  },
];

export const HowItWorks = () => {
  return (
    <section id="how" className="relative mx-auto max-w-7xl px-6 py-28 sm:py-36">
      <div className="max-w-3xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
          How it works
        </span>
        <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
          Five moves, <span className="serif-italic text-violet-700">one protocol.</span>
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-zinc-600">
          Solana coordinates capital from every chain — native BTC, native ETH, and physical gold. Privacy is a toggle, not an L2 detour.
        </p>
      </div>

      <ol className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2">
        {steps.map((s) => (
          <li key={s.n} className="group relative overflow-hidden rounded-3xl border border-zinc-200/80 bg-white/80 p-7 backdrop-blur transition hover:shadow-[0_30px_80px_-40px_rgba(76,29,149,0.35)]">
            <div className="flex items-start justify-between">
              <div className={"grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br " + s.accent + " text-white shadow-[0_10px_30px_-12px_rgba(109,40,217,0.35)]"}>
                <span className="mono text-[12px] font-bold tracking-widest">{s.n}</span>
              </div>
              <span className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
                {s.eyebrow}
              </span>
            </div>
            <h3 className="mt-5 text-[22px] font-semibold leading-[1.2] tracking-tight text-zinc-900">
              {s.title}
            </h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-zinc-600">{s.body}</p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {s.chips.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700"
                >
                  {c}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
