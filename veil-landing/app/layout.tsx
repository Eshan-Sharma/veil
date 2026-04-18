import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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
  title: "Veil — Private, cross-chain lending on Solana",
  description:
    "Veil lets you borrow against native BTC and ETH on Solana, without bridges and with fully encrypted positions. Institutional-grade capital, onchain privacy.",
  metadataBase: new URL("https://veil.xyz"),
  openGraph: {
    title: "Veil — Private, cross-chain lending on Solana",
    description:
      "Native BTC/ETH collateral, FHE-encrypted positions, built on Pinocchio, Ika dWallets and Encrypt.",
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
      <body className="min-h-full flex flex-col page-bg">{children}</body>
    </html>
  );
}
