import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * The exact bytes the wallet must sign.
 *
 * Origin is baked into the canonical message in SIWE / EIP-4361 fashion:
 * a signature produced by phishing site `evil.example` with origin
 * `evil.example` cannot be replayed against the real Veil server which
 * enforces its own expected origin server-side. Without an origin line
 * the signed bytes are domain-agnostic and a phishing site could request
 * the user to sign a message that is identical to a legitimate request.
 */
export function buildAuthMessage(nonce: string, action: string, origin: string): string {
  return `Veil admin auth\nOrigin: ${origin}\nAction: ${action}\nNonce: ${nonce}`;
}

/** Verify a base58-encoded ed25519 signature over `message` made by `pubkey` (base58). */
export function verifyEd25519Signature(
  pubkey: string,
  message: string,
  signatureBase58: string
): boolean {
  try {
    const pk = bs58.decode(pubkey);
    const sig = bs58.decode(signatureBase58);
    const msg = new TextEncoder().encode(message);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

/** Generate a 16-byte random nonce as hex. */
export function newNonce(): string {
  const bytes = nacl.randomBytes(16);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Server-side: the canonical origin a request claims to come from. */
export function expectedOrigin(req: Request): string {
  // Prefer request Origin header; fall back to a configured default.
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const fallback = process.env.PUBLIC_ORIGIN ?? "http://localhost:4321";
  return fallback;
}
