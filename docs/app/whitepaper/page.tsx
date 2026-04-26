import type { Metadata } from "next";
import { WhitepaperShell } from "./WhitepaperShell";

export const metadata: Metadata = {
  title: "Whitepaper",
  description:
    "Veil Protocol — formal source-grounded specification of a privacy-first cross-chain lending protocol on Solana. Math, state, instructions, authorization, oracle, FHE, Ika, off-chain stack, threat model.",
};

export default function Page() {
  return <WhitepaperShell />;
}
