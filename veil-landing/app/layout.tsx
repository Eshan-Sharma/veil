import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import SolanaProvider from "./providers/SolanaProvider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const serif = Instrument_Serif({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Veil — Borrow against native BTC, gold, or any asset on Solana",
  description:
    "Veil is the first lending protocol on Solana where you can borrow against native Bitcoin, physical gold, or any on-chain asset — with an optional privacy layer. No bridges, no wrapping.",
  metadataBase: new URL("https://veil.xyz"),
  openGraph: {
    title: "Veil — Borrow against native BTC, gold, or any asset on Solana",
    description:
      "Native BTC/ETH collateral, physical gold via Oro/GRAIL, FHE-encrypted positions. Built on Pinocchio, Ika dWallets, and Encrypt.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${serif.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col page-bg">
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
