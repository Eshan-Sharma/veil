export default function Pinocchio() {
  const rows = [
    { op: "borrow", anchor: 38400, pinocchio: 12100 },
    { op: "repay", anchor: 29800, pinocchio: 9400 },
    { op: "health_check", anchor: 14200, pinocchio: 3900 },
    { op: "liquidate", anchor: 51200, pinocchio: 17400 },
  ];
  const max = Math.max(...rows.map((r) => r.anchor));

  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 py-28 sm:py-36">
        <div className="grid grid-cols-1 items-start gap-14 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/70 bg-white/70 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-violet-800 backdrop-blur">
              Zero-dep · Zero-copy
            </span>
            <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 sm:text-[52px]">
              Built on Pinocchio. <span className="serif-italic text-violet-700">Lower CU, deeper headroom.</span>
            </h2>
            <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-zinc-600">
              The core lending program — pool, kink IRM, health engine, liquidations — is written from scratch on Pinocchio, Solana's zero-dependency, zero-copy framework. That leaves compute units for the things that actually matter at scale: repeated health checks and liquidations under load.
            </p>

            <div className="mt-8 grid grid-cols-3 gap-3">
              <Stat k="~3×" v="lower CU / instruction vs Anchor-equivalent" />
              <Stat k="0" v="external crate deps in the hot path" />
              <Stat k="O(1)" v="per-position health check" />
            </div>

            <div className="mt-7 rounded-2xl border border-zinc-200 bg-zinc-950 p-5 mono text-[12px] leading-5 text-white/85">
              <div className="flex items-center justify-between pb-2 text-white/45">
                <span>veil::health</span>
                <span>no_std · zero-copy</span>
              </div>
              <pre className="whitespace-pre-wrap">{`pub fn health_factor(
  c_ct: &Ct, d_ct: &Ct, px: &Price,
) -> FheBool {
  // compute over ciphertext
  let c_usd = fhe_mul(c_ct, px.collat);
  let d_usd = fhe_mul(d_ct, px.debt);
  fhe_ge(c_usd, fhe_mul(d_usd, LLTV))
}`}</pre>
            </div>
          </div>

          <div className="relative">
            <div className="rounded-3xl border border-zinc-200 bg-white/80 p-6 backdrop-blur">
              <div className="flex items-center justify-between pb-4">
                <div className="text-[11px] font-semibold tracking-[0.14em] text-zinc-500">COMPUTE UNITS · PER IX</div>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-zinc-300" /> Anchor baseline</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-600" /> Pinocchio</span>
                </div>
              </div>
              <ul className="space-y-5">
                {rows.map((r) => (
                  <li key={r.op}>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="mono text-[12.5px] font-semibold text-zinc-900">{r.op}</div>
                      <div className="mono text-[11.5px] text-zinc-500">
                        <span className="text-zinc-400">{r.anchor.toLocaleString()} CU</span>
                        <span className="mx-1.5 text-zinc-300">→</span>
                        <span className="font-semibold text-violet-700">{r.pinocchio.toLocaleString()} CU</span>
                      </div>
                    </div>
                    <div className="relative h-3 overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-zinc-200"
                        style={{ width: `${(r.anchor / max) * 100}%` }}
                      />
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-700 via-fuchsia-600 to-rose-500"
                        style={{ width: `${(r.pinocchio / max) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[11.5px] text-zinc-500">
                Indicative figures for planning. Final numbers pending mainnet benchmark.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white/80 p-4">
      <div className="text-[26px] font-semibold tracking-tight text-zinc-900">{k}</div>
      <div className="mt-1 text-[12px] leading-snug text-zinc-500">{v}</div>
    </div>
  );
}
