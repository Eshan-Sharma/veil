"use client";

import { useState, useEffect } from "react";
import { fetchPythPrices, PythPrices } from "../../../lib/pyth/prices";

const STALE_PRICES: PythPrices = { usdc: 1.0 };

/**
 * React hook that polls Pyth Hermes every `intervalMs` milliseconds.
 * Returns a map of poolId → USD price (null while loading or on error).
 */
export function usePythPrices(intervalMs = 10_000): PythPrices {
  const [prices, setPrices] = useState<PythPrices>(STALE_PRICES);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const p = await fetchPythPrices();
        if (!cancelled) setPrices(p);
      } catch {
        // Keep stale prices on failure — don't blank the UI.
      }
    };

    load();
    const timer = setInterval(load, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return prices;
}
