import Link from "next/link";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="relative grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white shadow-[0_6px_20px_-8px_rgba(109,40,217,0.6)]"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 5c4 6 12 6 16 0" />
          <path d="M4 12c4 6 12 6 16 0" opacity="0.55" />
          <path d="M4 19c4 6 12 6 16 0" opacity="0.28" />
        </svg>
      </span>
      <span className="text-[17px] font-semibold tracking-tight text-zinc-900">
        Veil
      </span>
    </Link>
  );
}

const links = [
  { href: "#problem", label: "Why Veil" },
  { href: "#how", label: "How it works" },
  { href: "#architecture", label: "Architecture" },
  { href: "#privacy", label: "Privacy" },
  { href: "#personas", label: "For" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 w-full">
      <div className="mx-auto mt-3 max-w-7xl px-4">
        <nav className="flex h-14 items-center justify-between rounded-full border border-zinc-200/70 bg-white/70 px-3 pl-5 pr-2 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_10px_30px_-12px_rgba(76,29,149,0.12)]">
          <Logo />
          <div className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-full px-3.5 py-1.5 text-[13.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                {l.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href="https://github.com/eshan-sharma/veil"
              target="_blank"
              rel="noreferrer"
              className="hidden rounded-full px-3 py-1.5 text-[13.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 sm:block"
            >
              GitHub
            </a>
            <Link
              href="/dapp"
              className="hidden rounded-full bg-violet-600 px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-violet-700 sm:block"
            >
              Launch App
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}
