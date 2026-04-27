const rails = [
  {
    side: "Origin chain",
    name: "Bitcoin",
    ticker: "BTC",
    note: "Native UTXO held by dWallet",
    gradient: "from-orange-400 to-amber-500",
    icon: (
      <svg viewBox="0 0 32 32" width="18" height="18" fill="currentColor"><path d="M20.3 13.8c.5-1.4-.6-2.2-2-2.8l.5-1.9-1.2-.3-.4 1.8-1-.2.4-1.8-1.2-.3-.5 1.9-2.3-.6-.3 1.3.9.2c.5.1.6.5.6.7l-1 4c0 .1-.3.3-.7.2l-.9-.2-.6 1.4 2.2.5-.5 1.9 1.2.3.5-1.9 1 .2-.5 1.9 1.2.3.5-1.9c2 .4 3.5.3 4.2-1.6.5-1.5 0-2.4-1.1-2.9 1-.2 1.6-.8 1.9-2zM18 16.9c-.3 1.4-2.7.7-3.5.5l.6-2.5c.7.2 3.3.5 2.9 2zm.3-3.6c-.3 1.3-2.3.7-3 .5l.6-2.2c.6.1 2.7.4 2.4 1.7z"/></svg>
    ),
  },
  {
    side: "Origin chain",
    name: "Ethereum",
    ticker: "ETH",
    note: "Native account held by dWallet",
    gradient: "from-sky-400 to-indigo-500",
    icon: (
      <svg viewBox="0 0 32 32" width="18" height="18" fill="currentColor"><path d="M16 4l7 12-7 4-7-4 7-12zm0 18l7-4-7 10-7-10 7 4z"/></svg>
    ),
  },
  {
    side: "Physical asset",
    name: "Gold · XAU",
    ticker: "XAU",
    note: "Custody via Oro/GRAIL",
    gradient: "from-yellow-400 to-amber-600",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6L12 15l-4.9 2.6.9-5.6-4-4 5.6-.8z"/></svg>
    ),
    badge: "Oro · GRAIL",
  },
];

// Layered architecture data — inspired by the protocol diagram
const layers = [
  {
    id: "ika",
    label: "Ika Layer",
    sublabel: "Cross-chain · MPC",
    borderColor: "border-emerald-200/70",
    bgColor: "bg-emerald-50/40",
    labelColor: "text-emerald-800",
    badgeColor: "bg-emerald-100 text-emerald-800",
    components: [
      { name: "dWallet Registry", desc: "per-asset dWallet map" },
      { name: "Collateral Vault", desc: "BTC · ETH · XAU (Gold)" },
      { name: "Signing Policy", desc: "liquidation-triggered sign" },
      { name: "MPC Network", desc: "2-of-3 co-signer" },
    ],
    external: { name: "BTC / ETH / Gold", desc: "native assets", color: "text-amber-700 bg-amber-50 border-amber-200" },
  },
  {
    id: "core",
    label: "Core Lending",
    sublabel: "Pinocchio · Solana",
    borderColor: "border-violet-200/60",
    bgColor: "bg-violet-50/20",
    labelColor: "text-violet-800",
    badgeColor: "bg-violet-100 text-violet-800",
    components: [
      { name: "Liquidity Pool", desc: "deposits · supply · borrows" },
      { name: "Kink IRM", desc: "utilization rate curve" },
      { name: "lTokens", desc: "receipt mint" },
      { name: "UserPosition", desc: "collateral + debt PDA" },
      { name: "Health Engine", desc: "solvency over ciphertext" },
      { name: "Liquidation Router", desc: "dispatches dWallet sigs" },
    ],
    external: { name: "Pyth Oracle", desc: "price feeds", color: "text-blue-700 bg-blue-50 border-blue-200" },
  },
  {
    id: "encrypt",
    label: "Encrypt Layer",
    sublabel: "FHE · REFHE",
    borderColor: "border-purple-200/70",
    bgColor: "bg-purple-50/30",
    labelColor: "text-purple-800",
    badgeColor: "bg-purple-100 text-purple-800",
    components: [
      { name: "Enc. Position", desc: "FHE ciphertext balances" },
      { name: "FHE Compute", desc: "encrypted health factor" },
      { name: "Plaintext Path", desc: "privacy-off fallback" },
    ],
    external: { name: "FHE Keys", desc: "Encrypt service", color: "text-purple-700 bg-purple-50 border-purple-200" },
  },
];

export const Architecture = () => {
  return (
    <section id="architecture" className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-violet-100/40 to-transparent" />
      <div className="relative mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
            Architecture
          </span>
          <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[54px]">
            Solana becomes the <span className="serif-italic text-violet-700">coordination layer</span> for capital from every chain.
          </h2>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-zinc-600">
            Native collateral stays on its origin chain. Physical gold stays in Oro custody. The Solana program governs all invariants, and Encrypt's FHE layer keeps every amount as ciphertext.
          </p>
        </div>

        {/* Collateral rails + Solana core + Privacy layer */}
        <div className="mt-14 grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[1fr_1.4fr_1fr]">
          {/* Origin + gold rails */}
          <div className="flex flex-col gap-4">
            {rails.map((r) => (
              <div key={r.ticker} className="relative overflow-hidden rounded-3xl border border-zinc-200/80 bg-white p-5">
                <div className="flex items-center justify-between">
                  <span className="mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">{r.side}</span>
                  <span className="mono text-[10px] text-zinc-400">
                    {r.ticker === "XAU" ? "oro::grail" : "ika::dWallet"}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className={"grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br " + r.gradient + " text-white"}>
                    {r.icon}
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-zinc-900">{r.name}</div>
                    <div className="text-[12.5px] text-zinc-500">{r.note}</div>
                  </div>
                </div>
                {r.ticker === "XAU" ? (
                  <div className="mt-4 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2 text-[11.5px] mono text-amber-800">
                    <span>Oro/GRAIL custody</span>
                    <span>regulatory compliant</span>
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <span className="pulse-dot" /> verified
                    </span>
                  </div>
                ) : (
                  <div className="mt-4 flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 text-[11.5px] mono text-zinc-600">
                    <span>MPC 2-of-3</span>
                    <span>co-sign ready</span>
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <span className="pulse-dot" /> online
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Center: Solana coordinator */}
          <div className="relative">
            <div className="relative h-full overflow-hidden rounded-3xl border border-violet-200/60 bg-gradient-to-br from-white via-violet-50/60 to-rose-50/40 p-7">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 rounded-full bg-violet-600/10 px-3 py-1 text-[11.5px] font-semibold text-violet-800">
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-violet-600 text-white">
                    <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M3 4l10-2 0 3-10 2zM3 8l10-2 0 3-10 2zM3 12l10-2 0 3-10 2z"/></svg>
                  </span>
                  Solana · Pinocchio Program
                </span>
                <span className="mono text-[10.5px] text-zinc-500">VLT_core_v0.3</span>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3">
                {[
                  { t: "Pool invariants", d: "utilization-capped liquidity" },
                  { t: "Kink IRM", d: "dynamic borrow rate" },
                  { t: "Health engine", d: "solvency over ciphertext" },
                  { t: "Liquidation router", d: "dispatches dWallet sigs" },
                ].map((m) => (
                  <div key={m.t} className="rounded-2xl border border-white/70 bg-white/80 p-3 ring-1 ring-violet-100/70">
                    <div className="text-[12.5px] font-semibold text-zinc-900">{m.t}</div>
                    <div className="text-[11.5px] text-zinc-500">{m.d}</div>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-2xl bg-zinc-950 p-4 mono text-[11px] leading-5 text-white/85">
                <div className="flex items-center justify-between pb-2 text-white/45">
                  <span>instructions</span>
                  <span>ix 4 / CU ~2.1k</span>
                </div>
                <div><span className="text-violet-300">ix</span> deposit_native(vault, proof_of_lock)</div>
                <div><span className="text-amber-300">ix</span> deposit_gold(oro_attestation)</div>
                <div><span className="text-violet-300">ix</span> borrow_encrypted(amount_ct, max_slip)</div>
                <div><span className="text-rose-300">ix</span> liquidate(unhealthy_vault) ⟶ dWallet::sign</div>
              </div>

              <div className="mt-5 flex items-center justify-between rounded-2xl border border-zinc-200 bg-white/80 p-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M8 1L1 6l7 5 7-5zm0 11l-7-5v3l7 5 7-5v-3z"/></svg>
                  </span>
                  <div>
                    <div className="text-[12.5px] font-semibold text-zinc-900">Pyth oracle</div>
                    <div className="text-[11px] text-zinc-500">sub-second price feeds</div>
                  </div>
                </div>
                <span className="mono text-[11px] text-zinc-600">BTC $63,410 · XAU $2,940</span>
              </div>
            </div>

            <div aria-hidden className="pointer-events-none absolute -inset-8 -z-10 bg-gradient-to-br from-violet-300/40 via-fuchsia-200/30 to-rose-200/30 blur-3xl" />
          </div>

          {/* Right: Privacy layer */}
          <div className="flex flex-col gap-4">
            <div className="relative overflow-hidden rounded-3xl border border-zinc-200/80 bg-zinc-950 p-5 text-white">
              <div className="flex items-center justify-between">
                <span className="mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">Privacy layer</span>
                <span className="mono text-[10px] text-white/45">encrypt::refhe</span>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.5 7V5a3.5 3.5 0 117 0v2h.5a1 1 0 011 1v5a1 1 0 01-1 1h-8a1 1 0 01-1-1V8a1 1 0 011-1h.5zM6 5v2h4V5a2 2 0 10-4 0z"/></svg>
                </div>
                <div>
                  <div className="text-[15px] font-semibold">Encrypt · FHE</div>
                  <div className="text-[12px] text-white/55">REFHE computes over ciphertext</div>
                </div>
              </div>
              <div className="mt-4 space-y-1.5 mono text-[11px] text-white/75">
                <div><span className="text-violet-300">ct</span> collateral_enc = enc(1.8421 BTC)</div>
                <div><span className="text-amber-300">ct</span> gold_enc       = enc(42.5 oz XAU)</div>
                <div><span className="text-violet-300">ct</span> debt_enc       = enc(84,203 USDC)</div>
                <div><span className="text-emerald-300">fn</span> health(ct_c, ct_d, px) ≥ 1.0</div>
                <div><span className="text-white/40">//  observer sees: ct bytes only</span></div>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-3xl border border-zinc-200/80 bg-white p-5">
              <div className="mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
                Public invariants
              </div>
              <ul className="mt-3 space-y-2 text-[12.5px] text-zinc-700">
                <li className="flex items-center gap-2"><Dot /> Solvency enforced onchain</li>
                <li className="flex items-center gap-2"><Dot /> Utilization &lt; cap</li>
                <li className="flex items-center gap-2"><Dot /> Rate curve monotonic</li>
                <li className="flex items-center gap-2"><Dot /> Liquidation atomic w/ dWallet</li>
                <li className="flex items-center gap-2"><Dot /> Gold custody verified by Oro</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Protocol layers diagram — inspired by architecture diagram */}
        <div className="mt-16">
          <div className="mb-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-200" />
            <span className="mono text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Protocol layers</span>
            <div className="h-px flex-1 bg-zinc-200" />
          </div>
          <div className="overflow-x-auto rounded-3xl border border-zinc-200 bg-white/60 p-6 backdrop-blur">
            <div className="min-w-[640px] space-y-3">
              {layers.map((layer, li) => (
                <div key={layer.id}>
                  <div className={`rounded-2xl border ${layer.borderColor} ${layer.bgColor} p-4`}>
                    <div className="flex items-start gap-4">
                      {/* Layer label */}
                      <div className="w-28 shrink-0 pt-0.5">
                        <div className={`mono text-[10px] font-bold uppercase tracking-[0.16em] ${layer.labelColor}`}>{layer.label}</div>
                        <div className="mono mt-0.5 text-[9.5px] text-zinc-400">{layer.sublabel}</div>
                      </div>
                      {/* Component chips */}
                      <div className="flex flex-1 flex-wrap gap-2">
                        {layer.components.map((c) => (
                          <div key={c.name} className="rounded-xl border border-white/80 bg-white px-3 py-1.5 shadow-sm">
                            <div className="text-[12px] font-semibold text-zinc-900">{c.name}</div>
                            <div className="text-[10.5px] text-zinc-500">{c.desc}</div>
                          </div>
                        ))}
                      </div>
                      {/* External */}
                      {layer.external && (
                        <div className={`shrink-0 rounded-xl border px-3 py-1.5 ${layer.external.color}`}>
                          <div className="text-[11px] font-semibold">{layer.external.name}</div>
                          <div className="text-[10px] opacity-70">{layer.external.desc}</div>
                        </div>
                      )}
                    </div>
                  </div>
                  {li < layers.length - 1 && (
                    <div className="flex items-center justify-center py-1">
                      <svg viewBox="0 0 20 12" width="20" height="12" fill="none">
                        <path d="M10 0v10M5 6l5 5 5-5" stroke="#d4d4d8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-2">
            <LegendItem color="bg-emerald-400" label="Ika dWallet flow" />
            <LegendItem color="bg-purple-400" label="Encrypt FHE flow" />
            <LegendItem color="bg-rose-400" label="Liquidation cross-layer" />
            <LegendItem color="bg-blue-400" label="Pyth price feed" />
            <LegendItem color="bg-amber-400" label="Oro/GRAIL gold custody" />
          </div>
        </div>
      </div>
    </section>
  );
}

const Dot = () => (
  <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
    <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6l2.5 2.5L10 3"/></svg>
  </span>
);

const LegendItem = ({ color, label }: { color: string; label: string }) => (
  <span className="flex items-center gap-2 text-[12px] text-zinc-500">
    <span className={`h-2.5 w-8 rounded-full ${color} opacity-70`} />
    {label}
  </span>
);
