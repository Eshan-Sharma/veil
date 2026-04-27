"use client";

import { useEffect, useState } from "react";

import { useWallet } from "@solana/wallet-adapter-react";

import { fetchMyRole } from "@/lib/auth/client";

export type AdminRole = "super_admin" | "pool_admin" | null;

export const useAdminRole = (): { role: AdminRole; loading: boolean; refresh: () => void } => {
  const { publicKey } = useWallet();
  const [role, setRole] = useState<AdminRole>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!publicKey) { setRole(null); return; }
    let cancelled = false;
    setLoading(true);
    fetchMyRole(publicKey.toBase58())
      .then((r) => { if (!cancelled) setRole(r); })
      .catch(() => { if (!cancelled) setRole(null); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [publicKey, tick]);

  return { role, loading, refresh: () => setTick((t) => t + 1) };
};
