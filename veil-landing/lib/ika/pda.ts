import { PublicKey } from "@solana/web3.js";
import {
  CPI_AUTHORITY_SEED,
  COORDINATOR_SEED,
  IKA_PROGRAM_ID,
  DWalletCurveValue,
  SignatureSchemeValue,
} from "./types";

const IKA_PROGRAM_PK = new PublicKey(IKA_PROGRAM_ID);

// ─── Veil CPI authority ───────────────────────────────────────────────────────

/**
 * Derive the Veil CPI authority PDA.
 * This is the address that must be the authority on any registered dWallet.
 */
export async function findCpiAuthority(
  veilProgramId: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress([CPI_AUTHORITY_SEED], veilProgramId);
}

// ─── Ika PDAs ────────────────────────────────────────────────────────────────

/** Derive the DWalletCoordinator PDA on the Ika program. */
export async function findCoordinator(): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress([COORDINATOR_SEED], IKA_PROGRAM_PK);
}

// ─── Veil IkaDwalletPosition PDA ─────────────────────────────────────────────

/**
 * Derive the IkaDwalletPosition PDA for a given (pool, user) pair.
 * Seeds: [b"ika_pos", pool, user]
 */
export async function findIkaPosition(
  pool: PublicKey,
  user: PublicKey,
  veilProgramId: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [Buffer.from("ika_pos"), pool.toBytes(), user.toBytes()],
    veilProgramId
  );
}

// ─── MessageApproval PDA ─────────────────────────────────────────────────────

/**
 * Derive the MessageApproval PDA on the Ika program.
 *
 * Seeds: ["dwallet", ...chunks, "message_approval", schemeLE, messageDigest,
 *          ...optional(messageMetadataDigest)]
 *
 * The Ika SDK uses variable-length chunked seeds.  For Veil's use case the
 * seeds are constructed by the Ika program, but the client still needs to
 * derive the address to pass it as an account.
 */
export async function findMessageApproval(
  dwallet: PublicKey,
  messageDigest: Uint8Array,
  messageMetadataDigest: Uint8Array,
  signatureScheme: SignatureSchemeValue
): Promise<[PublicKey, number]> {
  const schemeLE = Buffer.alloc(2);
  schemeLE.writeUInt16LE(signatureScheme);

  const seeds: (Buffer | Uint8Array)[] = [
    Buffer.from("dwallet"),
    dwallet.toBytes(),
    Buffer.from("message_approval"),
    schemeLE,
    Buffer.from(messageDigest),
  ];

  // Only append metadata digest seed when non-zero
  const isNonZero = Array.from(messageMetadataDigest).some((b) => b !== 0);
  if (isNonZero) {
    seeds.push(Buffer.from(messageMetadataDigest));
  }

  return PublicKey.findProgramAddress(seeds, IKA_PROGRAM_PK);
}
