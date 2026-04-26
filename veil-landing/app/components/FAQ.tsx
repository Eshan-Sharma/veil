const qs = [
  {
    q: "How does physical gold work as collateral?",
    a: "Veil integrates Oro's GRAIL platform, which is digital gold infrastructure for modern finance. Oro handles the hard parts — physical custody, regulatory compliance, KYC, and on-chain settlement. Users pledge gold-backed assets through Oro's self-custody model; Veil's Solana program tracks the position and enforces collateral logic. This makes Veil the first DeFi lending protocol where physical gold works as productive collateral alongside native crypto.",
  },
  {
    q: "What are flash loans and how do they work on Veil?",
    a: "A flash loan lets you borrow any amount from a Veil pool within a single Solana transaction — no collateral required. The catch: you must return the borrowed amount plus a 0.09 % fee in the same transaction. If the repayment instruction is missing or falls short, the entire transaction reverts atomically and no funds move. This makes flash loans safe for the protocol while unlocking capital-efficient strategies like arbitrage, liquidation bots, and collateral swaps. 90 % of the fee goes to liquidity providers; 10 % to the protocol.",
  },
  {
    q: "How does Veil hold native BTC without bridging?",
    a: "Veil uses an Ika dWallet — a programmable wallet jointly controlled by you and Ika's MPC network. Your Bitcoin stays on Bitcoin as native UTXOs. A Solana program sends signing instructions; the dWallet co-signs. No wrapped token, no custodian.",
  },
  {
    q: "What does \"encrypted position\" actually mean?",
    a: "When you call EnablePrivacy, Veil creates an EncryptedPosition account that holds two on-chain ciphertext handles — one for your deposit balance, one for your debt — managed by the Encrypt program. Every subsequent deposit, borrow, repay, or withdraw submits an FHE computation graph (add_deposit, sub_debt, etc.) to the Encrypt program via CPI. An off-chain executor evaluates the graph using actual FHE and commits updated ciphertext. An RPC observer sees 32-byte opaque handles, not values. Solvency is enforced in plaintext by the standard UserPosition; the encrypted mirror provides observer confidentiality.",
  },
  {
    q: "If positions are encrypted, how does liquidation work?",
    a: "Liquidation is triggered by a homomorphic comparison of your encrypted health factor against 1. When the check fails, a Solana instruction dispatches a dWallet signature on the asset's origin chain — settling against native BTC or ETH. No IOU, no wrapped round-trip.",
  },
  {
    q: "Is privacy optional?",
    a: "Yes. Privacy is a per-position toggle. You can hold a transparent position alongside encrypted ones — useful for demo, or for addresses you want to keep discoverable.",
  },
  {
    q: "Why Pinocchio instead of Anchor?",
    a: "Pinocchio is Solana's zero-dependency, zero-copy program framework. For a lending protocol that does a lot of repeated math (health checks, rate updates, liquidations), a meaningfully lower compute-unit footprint per instruction means more throughput and more headroom under stress.",
  },
  {
    q: "Is the protocol live on mainnet?",
    a: "Veil is experimental. The core protocol design is frozen, the Pinocchio implementation is in progress, and Ika and Encrypt are themselves evolving toward mainnet. Veil is built to upgrade in place as those primitives land.",
  },
];

export const FAQ = () => {
  return (
    <section id="faq" className="relative">
      <div className="mx-auto max-w-5xl px-6 py-28 sm:py-36">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
            FAQ
          </span>
          <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
            The <span className="serif-italic text-violet-700">honest</span> questions.
          </h2>
        </div>

        <div className="mt-12 overflow-hidden rounded-3xl border border-zinc-200 bg-white/70 backdrop-blur">
          {qs.map((item, i) => (
            <details
              key={i}
              className="group border-b border-zinc-200 last:border-b-0 open:bg-zinc-50/60"
            >
              <summary className="flex cursor-pointer items-start justify-between gap-6 px-6 py-5 md:px-8">
                <span className="text-[16px] font-semibold tracking-tight text-zinc-900 md:text-[17.5px]">
                  {item.q}
                </span>
                <span className="faq-caret mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-zinc-600 ring-1 ring-zinc-200 transition">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </span>
              </summary>
              <div className="px-6 pb-6 text-[14.5px] leading-relaxed text-zinc-600 md:px-8">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
