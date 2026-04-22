const items = [
  {
    name: "Solana",
    role: "Settlement + coordination",
    body: "Sub-second finality, global liquidity, the only L1 with the throughput profile Veil's compute model is designed for.",
    tag: "L1",
    gradient: "from-[#14F195] to-[#9945FF]",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 6l3-3h13l-3 3H4zm0 6l3-3h13l-3 3H4zm0 6l3-3h13l-3 3H4z"/></svg>
    ),
  },
  {
    name: "Pinocchio",
    role: "Zero-copy program framework",
    body: "Veil's lending core is built from scratch on Pinocchio — fewer deps, lower CU, more headroom for encrypted health checks at scale.",
    tag: "Runtime",
    gradient: "from-amber-500 to-rose-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M5 7l7-4 7 4-7 4-7-4zm0 5l7 4 7-4v5l-7 4-7-4v-5z"/></svg>
    ),
  },
  {
    name: "Ika · dWallet",
    role: "Cross-chain MPC signing",
    body: "Programmable dWallets govern native BTC / ETH. Solana logic requests a co-signed settlement — no bridge, no wrap.",
    tag: "Cross-chain",
    gradient: "from-indigo-500 to-violet-600",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l9 4-9 4-9-4 9-4zm-9 7l9 4 9-4v4l-9 4-9-4V9zm0 6l9 4 9-4v4l-9 4-9-4v-4z"/></svg>
    ),
  },
  {
    name: "Oro · GRAIL",
    role: "Physical gold infrastructure",
    body: "Oro's GRAIL platform handles gold custody, regulatory compliance, KYC, and on-chain settlement — so users can pledge physical gold as DeFi collateral for the first time.",
    tag: "Gold",
    gradient: "from-yellow-400 to-amber-600",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6L12 15l-4.9 2.6.9-5.6-4-4 5.6-.8z"/></svg>
    ),
  },
  {
    name: "Encrypt · REFHE",
    role: "FHE privacy layer",
    body: "Balances and debt stored as ciphertext; health factor computed homomorphically. Invariants are provable without decryption.",
    tag: "Privacy",
    gradient: "from-violet-600 to-fuchsia-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 9V7a6 6 0 1112 0v2h1a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V10a1 1 0 011-1h1zm2 0h8V7a4 4 0 10-8 0v2z"/></svg>
    ),
  },
  {
    name: "Pyth",
    role: "Price oracle",
    body: "Sub-second, first-party prices for BTC, ETH, XAU, and quote assets. Fuels the kink rate curve and liquidation thresholds.",
    tag: "Oracle",
    gradient: "from-blue-500 to-sky-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 13l4-6 4 4 4-8 6 10H3z"/></svg>
    ),
  },
  {
    name: "Kink IRM",
    role: "Interest rate model",
    body: "Utilization-driven rate curve with a kink — cheap under the target, sharply punitive above it to protect lenders.",
    tag: "Econ",
    gradient: "from-emerald-500 to-teal-500",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 20h18v1H3zm1-4l5-5 4 4 7-9v4l-7 9-4-4-5 5v-4z"/></svg>
    ),
  },
  {
    name: "Flash Loans",
    role: "Uncollateralized atomic lending",
    body: "Borrow any amount, execute your strategy, repay in one transaction. Atomic enforcement at the program level — no collateral, no credit risk. 0.09 % fee split 90 / 10 between LPs and protocol.",
    tag: "DeFi",
    gradient: "from-sky-500 to-cyan-400",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13 2L4 14h8l-1 8 9-12h-8l1-8z"/></svg>
    ),
  },
];

export default function TechStack() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
            The stack
          </span>
          <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
            Built on primitives designed to{" "}
            <span className="serif-italic text-violet-700">upgrade in place.</span>
          </h2>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-zinc-600">
            Veil works today as a full lending protocol, and upgrades without migration as Ika and Encrypt reach mainnet. Oro/GRAIL makes physical gold live from day one.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((it) => (
            <div key={it.name} className="group relative overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 p-6 backdrop-blur transition hover:shadow-[0_30px_60px_-30px_rgba(76,29,149,0.35)]">
              <div className="flex items-center justify-between">
                <div className={"grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br " + it.gradient + " text-white"}>
                  {it.icon}
                </div>
                <span className="mono rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{it.tag}</span>
              </div>
              <div className="mt-4">
                <div className="text-[17px] font-semibold tracking-tight text-zinc-900">{it.name}</div>
                <div className="text-[12.5px] text-zinc-500">{it.role}</div>
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-zinc-600">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
