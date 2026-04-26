export const Footer = () => {

  return (
    <footer className="relative border-t border-zinc-200/80 bg-white/50 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-14 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M4 5c4 6 12 6 16 0"/>
                <path d="M4 12c4 6 12 6 16 0" opacity="0.55"/>
                <path d="M4 19c4 6 12 6 16 0" opacity="0.28"/>
              </svg>
            </span>
            <span className="text-[17px] font-semibold tracking-tight text-zinc-900">Veil</span>
          </div>
          <p className="mt-4 text-[13.5px] leading-relaxed text-zinc-500">
            The first lending protocol on Solana for native BTC, physical gold, or any on-chain asset — with an optional privacy layer. No bridges, no wrapping.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          <Column title="Protocol" items={[
            ["How it works", "#how"],
            ["Architecture", "#architecture"],
            ["Privacy", "#privacy"],
            ["Security", "#security"],
          ]} />
          <Column title="Resources" items={[
            ["GitHub", "https://github.com/eshan-sharma/veil"],
            ["Whitepaper", `${process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docsveil.vercel.app"}/whitepaper`],
            ["Architecture (SVG)", "https://github.com/eshan-sharma/veil/blob/main/docs/veil_architecture.svg"],
            ["Personas", "https://github.com/eshan-sharma/veil/blob/main/docs/user_persona.md"],
          ]} />
          <Column title="Built with" items={[
            ["Solana", "https://solana.com"],
            ["Pinocchio", "https://github.com/anza-xyz/pinocchio"],
            ["Ika dWallet", "https://github.com/dwallet-labs/ika"],
            ["Oro · GRAIL", "https://docs.grail.oro.finance/"],
            ["Encrypt · FHE", "https://docs.encrypt.xyz"],
            ["Pyth", "https://pyth.network"],
          ]} />
        </div>
      </div>

      <div className="border-t border-zinc-200/80">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-[12.5px] text-zinc-500 md:flex-row md:items-center md:justify-between">
          <div>© {new Date().getFullYear()} Veil Labs · MIT · Experimental, not production-ready.</div>
          <div className="mono flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>commit 0x3Fa9…4c12</span>
            <span className="text-zinc-300">·</span>
            <span className="inline-flex items-center gap-1.5"><span className="pulse-dot"/> devnet · slot 287,394,112</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function Column({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <div className="mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-400">{title}</div>
      <ul className="mt-3 space-y-2">
        {items.map(([label, href]) => (
          <li key={label}>
            <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="text-[13.5px] text-zinc-700 transition hover:text-violet-700">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
