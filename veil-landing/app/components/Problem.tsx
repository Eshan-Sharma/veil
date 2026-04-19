export default function Problem() {
  return (
    <section id="problem" className="relative overflow-hidden bg-zinc-950 text-white">
      <div aria-hidden className="absolute inset-0 opacity-[0.18]" style={{
        backgroundImage:
          "radial-gradient(600px 300px at 10% 0%, #7c3aed 0%, transparent 55%), radial-gradient(500px 300px at 90% 100%, #db2777 0%, transparent 60%)",
      }} />
      <div aria-hidden className="absolute inset-0 opacity-[0.06]" style={{
        backgroundImage:
          "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
        backgroundSize: "56px 56px",
      }} />

      <div className="relative mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-white/80 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            Two structural gaps
          </span>
          <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[56px]">
            Solana is the best venue for onchain capital — until you ask{" "}
            <span className="serif-italic text-white/80">why billions still sit still.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-white/65">
            Every position, balance, and liquidation price is published to the world, and any non-Solana asset — including BTC, ETH, and physical gold — has to trust a bridge or custodian to get on-chain. That's a non-starter for funds, market makers, and institutions. Veil closes both gaps with a single protocol.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-widest text-rose-300">
                Gap 01
              </span>
              <span className="mono text-[11px] text-white/40">L I Q U I D I T Y</span>
            </div>
            <h3 className="mt-5 text-[26px] font-semibold tracking-tight">
              The collateral is{" "}
              <span className="serif-italic text-rose-200">on the wrong chain.</span>
            </h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-white/65">
              The world's BTC, ETH, and physical gold can't be pledged on Solana without a bridge or a custodian. Bridges introduce custody risk and trusted third-parties — so institutions keep trillions in capital idle instead of pledging it.
            </p>
            <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4 mono text-[11.5px] leading-5 text-white/70">
              <div className="flex items-center justify-between text-white/40">
                <span>bridge.risk.stack</span>
                <span className="text-rose-300">×</span>
              </div>
              <div className="mt-2 space-y-1">
                <div><span className="text-rose-300">warn</span> custodian_multisig ⟶ 3-of-5 external signers</div>
                <div><span className="text-rose-300">warn</span> wrapped_supply ≠ native_supply</div>
                <div><span className="text-rose-300">warn</span> smart_contract_risk on two chains</div>
                <div><span className="text-rose-300">warn</span> bridge_halt_incident  ×14  last 3y</div>
              </div>
            </div>
          </div>

          <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-fuchsia-500/15 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-widest text-fuchsia-300">
                Gap 02
              </span>
              <span className="mono text-[11px] text-white/40">T R A N S P A R E N C Y</span>
            </div>
            <h3 className="mt-5 text-[26px] font-semibold tracking-tight">
              Your position is a{" "}
              <span className="serif-italic text-fuchsia-200">spreadsheet for your competition.</span>
            </h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-white/65">
              Collateral ratio, liquidation price, strategy — all visible to anyone with an RPC call. That's why a meaningful share of sophisticated capital still stays off-chain.
            </p>
            <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4 mono text-[11.5px] leading-5 text-white/70">
              <div className="flex items-center justify-between text-white/40">
                <span>rpc getAccountInfo(VLT_0x3F…A91)</span>
                <span>200</span>
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-white/80">{`{
  collateral_btc:  1.8421,
  debt_usdc:       84,203,
  health_factor:   1.184,
  liq_price_btc:   46,218,
  owner:           GJf…Nq
}`}</pre>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-white/10 bg-gradient-to-r from-white/[0.04] via-white/[0.02] to-white/[0.04] p-6">
          <p className="text-[15px] text-white/80">
            <span className="serif-italic text-white">Veil closes both at once</span> — native BTC/ETH via Ika dWallet, physical gold via Oro/GRAIL, encrypted state via Encrypt FHE, all coordinated by a Pinocchio program on Solana.
          </p>
          <a href="#how" className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[13px] font-semibold text-zinc-950 transition hover:bg-white/90">
            See how the protocol works
            <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 10h12M11 5l5 5-5 5"/></svg>
          </a>
        </div>
      </div>
    </section>
  );
}
