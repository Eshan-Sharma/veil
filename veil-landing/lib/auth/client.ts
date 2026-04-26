"use client";

import bs58 from "bs58";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export type SignedAuth = {
  actor: string;
  nonce: string;
  signature: string;
};

/**
 * Request a single-use server-issued nonce, ask the connected wallet to sign it,
 * and return the bundle the API expects (`actor`, `nonce`, `signature`).
 *
 * The canonical message is constructed by the server (returned in the
 * `/api/auth/nonce` response) so the client signs the EXACT bytes the server
 * will reconstruct and verify against — including the server's notion of the
 * request origin. This is the SIWE/EIP-4361 anti-phishing pattern.
 *
 * Throws if the wallet does not support signMessage.
 */
export async function requestSignedAuth(
  wallet: WalletContextState,
  action: string
): Promise<SignedAuth> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  if (!wallet.signMessage) throw new Error("wallet does not support signMessage");

  const actor = wallet.publicKey.toBase58();

  const res = await fetch("/api/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: actor, action }),
  });
  if (res.status === 429) {
    throw new Error("rate limited — wait a moment and retry");
  }
  if (!res.ok) throw new Error(`nonce request failed (${res.status})`);
  const { nonce, message } = await res.json() as { nonce: string; message: string };

  const sig = await wallet.signMessage(new TextEncoder().encode(message));
  return { actor, nonce, signature: bs58.encode(sig) };
}

/** Lightweight role lookup for UI gating only (not authoritative). */
export async function fetchMyRole(pubkey: string): Promise<"super_admin" | "pool_admin" | null> {
  const res = await fetch(`/api/admin/me?pubkey=${encodeURIComponent(pubkey)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json() as { role: "super_admin" | "pool_admin" | null };
  return data.role;
}
