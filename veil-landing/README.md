# veil-landing

Marketing site for [Veil](../README.md) — the first lending protocol on Solana for native BTC, physical gold, and any on-chain asset, with an optional privacy layer.

Built with Next.js 15, Tailwind CSS, and TypeScript.

---

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run build
npm start
```

## Deploy

The site is designed to deploy on [Vercel](https://vercel.com). Push to main and it deploys automatically once the project is connected.

---

## Structure

```
app/
├── page.tsx              # Root page — composes all sections
├── layout.tsx            # Root layout and metadata
├── globals.css           # Global Tailwind styles
└── components/
    ├── Nav.tsx
    ├── Hero.tsx
    ├── Problem.tsx
    ├── HowItWorks.tsx
    ├── Architecture.tsx
    ├── Personas.tsx
    ├── PrivacyDemo.tsx
    ├── TechStack.tsx
    ├── Security.tsx
    ├── PositionCard.tsx
    ├── Pinocchio.tsx
    ├── CTA.tsx
    ├── FAQ.tsx
    └── Footer.tsx
```
