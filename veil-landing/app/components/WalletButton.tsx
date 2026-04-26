"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

/**
 * Hydration-safe wrapper around WalletMultiButton.
 *
 * The Solana wallet adapter reads from localStorage on mount (autoConnect),
 * which causes Next.js to flag a hydration mismatch when the SSR snapshot's
 * "no wallet" state is replaced by the client's "wallet known" state.
 *
 * Render a sized placeholder during SSR + first client render, then swap to
 * the real button on mount — the second render is post-hydration so React
 * doesn't compare it against the server output.
 */
export function WalletButton({ style }: { style?: CSSProperties }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Match the typical button footprint so layout doesn't shift.
    return (
      <div
        aria-hidden
        style={{
          height: style?.height ?? 38,
          minWidth: 130,
          borderRadius: style?.borderRadius ?? 10,
          background: "rgba(11,11,16,0.04)",
          ...style,
        }}
      />
    );
  }
  return <WalletMultiButton style={style} />;
}
