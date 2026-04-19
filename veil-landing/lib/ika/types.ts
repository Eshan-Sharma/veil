/** Ika dWallet SDK types for Veil integration. */

export const IKA_PROGRAM_ID = "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY";

/** Seeds for deriving Veil's CPI authority PDA. */
export const CPI_AUTHORITY_SEED = Buffer.from("__ika_cpi_authority");

/** Seeds for deriving the Ika DWalletCoordinator PDA. */
export const COORDINATOR_SEED = Buffer.from("dwallet_coordinator");

// ─── Curve types (matching Ika's DWalletCurve enum) ─────────────────────────
export const DWalletCurve = {
  Secp256k1: 0,  // Bitcoin, Ethereum
  Secp256r1: 1,  // WebAuthn
  Curve25519: 2, // Solana / Ed25519
  Ristretto: 3,  // Substrate / sr25519
} as const;
export type DWalletCurveKey = keyof typeof DWalletCurve;
export type DWalletCurveValue = (typeof DWalletCurve)[DWalletCurveKey];

// ─── Signature schemes (matching Ika's DWalletSignatureScheme enum) ──────────
export const SignatureScheme = {
  EcdsaKeccak256:    0, // Ethereum
  EcdsaSha256:       1, // Bitcoin legacy / WebAuthn
  EcdsaDoubleSha256: 2, // Bitcoin BIP143
  TaprootSha256:     3, // Bitcoin Taproot
  EcdsaBlake2b256:   4, // Zcash
  EddsaSha512:       5, // Ed25519 (Solana)
  SchnorrkelMerlin:  6, // Substrate sr25519
} as const;
export type SignatureSchemeKey = keyof typeof SignatureScheme;
export type SignatureSchemeValue = (typeof SignatureScheme)[SignatureSchemeKey];

// ─── Position status ─────────────────────────────────────────────────────────
export const IkaPositionStatus = {
  Active:     0,
  Released:   1,
  Liquidated: 2,
} as const;

// ─── Account layout offsets ──────────────────────────────────────────────────

/** Offsets within an Ika dWallet on-chain account. */
export const DWalletLayout = {
  DISCRIMINATOR: 0, // 1 byte (must equal 2)
  VERSION:       1, // 1 byte
  AUTHORITY:     2, // 32 bytes — current authority pubkey
  CURVE:        34, // 2 bytes u16 LE
  STATE:        36, // 1 byte: 0=DKGInProgress, 1=Active, 2=Frozen

  DWALLET_DISCRIMINATOR: 2,
  STATE_ACTIVE: 1,
} as const;

/** Offsets within a Veil IkaDwalletPosition PDA (128 bytes). */
export const IkaPositionLayout = {
  DISCRIMINATOR:    0,  // 8 bytes "VEILIKA!"
  OWNER:            8,  // 32 bytes
  POOL:            40,  // 32 bytes
  DWALLET:         72,  // 32 bytes
  USD_VALUE:      104,  // 8 bytes u64 LE
  CURVE:          112,  // 2 bytes u16 LE
  SIGNATURE_SCHEME: 114, // 2 bytes u16 LE
  STATUS:         116,  // 1 byte
  BUMP:           117,  // 1 byte
  SIZE:           128,
} as const;

/** Offsets within a MessageApproval PDA (312 bytes). */
export const MessageApprovalLayout = {
  DWALLET:         2,   // 32 bytes pubkey
  MESSAGE_DIGEST: 34,   // 32 bytes
  STATUS:        172,   // 1 byte: 0=Pending, 1=Signed
  SIGNATURE_LEN: 173,   // 2 bytes u16 LE
  SIGNATURE:     175,   // 128 bytes (secp256k1) or less
  SIZE:          312,
} as const;
