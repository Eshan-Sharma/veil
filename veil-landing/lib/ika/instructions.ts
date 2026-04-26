/**
 * TypeScript instruction builders for Veil's Ika integration.
 *
 * Disc map:
 *   0x11 (17) — IkaRegister
 *   0x12 (18) — IkaRelease
 *   0x13 (19) — IkaSign
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { PROGRAM_ID } from "../veil/constants";
import { IKA_PROGRAM_ID } from "./types";

const IKA_PROGRAM_PK = new PublicKey(IKA_PROGRAM_ID);

function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}

function u16LE(n: number): Uint8Array {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16LE(n);
  return buf;
}

function u64LE(n: bigint): Uint8Array {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}

// ─── IkaRegister (discriminator 0x11) ────────────────────────────────────────
//
// Accounts:
//   [0] user             signer, writable
//   [1] pool             readonly
//   [2] dwallet          readonly
//   [3] ika_position     writable
//   [4] cpi_authority    readonly
//   [5] system_program
//
// Data (after disc): usd_value u64 LE, curve u16 LE, signature_scheme u16 LE,
//                    position_bump u8, cpi_authority_bump u8

export function ikaRegisterIx(
  user: PublicKey,
  pool: PublicKey,
  dwallet: PublicKey,
  ikaPosition: PublicKey,
  cpiAuthority: PublicKey,
  usdValue: bigint,
  curve: number,
  signatureScheme: number,
  positionBump: number,
  cpiAuthorityBump: number
): TransactionInstruction {
  const data = concat(
    u8(0x11),
    u64LE(usdValue),
    u16LE(curve),
    u16LE(signatureScheme),
    u8(positionBump),
    u8(cpiAuthorityBump)
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,          isSigner: true,  isWritable: true  },
      { pubkey: pool,          isSigner: false, isWritable: false },
      { pubkey: dwallet,       isSigner: false, isWritable: false },
      { pubkey: ikaPosition,   isSigner: false, isWritable: true  },
      { pubkey: cpiAuthority,  isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── IkaRelease (discriminator 0x12) ─────────────────────────────────────────
//
// Accounts:
//   [0] user             signer, writable
//   [1] pool             readonly
//   [2] dwallet          writable
//   [3] ika_position     writable
//   [4] caller_program   readonly  (Veil program)
//   [5] cpi_authority    readonly
//   [6] ika_program      readonly
//
// Data (after disc): cpi_authority_bump u8

export function ikaReleaseIx(
  user: PublicKey,
  pool: PublicKey,
  dwallet: PublicKey,
  ikaPosition: PublicKey,
  callerProgram: PublicKey,
  cpiAuthority: PublicKey,
  cpiAuthorityBump: number
): TransactionInstruction {
  const data = concat(u8(0x12), u8(cpiAuthorityBump));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,           isSigner: true,  isWritable: true  },
      { pubkey: pool,           isSigner: false, isWritable: false },
      { pubkey: dwallet,        isSigner: false, isWritable: true  },
      { pubkey: ikaPosition,    isSigner: false, isWritable: true  },
      { pubkey: callerProgram,  isSigner: false, isWritable: false },
      { pubkey: cpiAuthority,   isSigner: false, isWritable: false },
      { pubkey: IKA_PROGRAM_PK, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── IkaSign (discriminator 0x13) ────────────────────────────────────────────
//
// Accounts:
//   [0] user             signer, writable
//   [1] coordinator      readonly
//   [2] message_approval writable
//   [3] dwallet          readonly
//   [4] ika_position     readonly
//   [5] caller_program   readonly  (Veil program)
//   [6] cpi_authority    readonly
//   [7] system_program
//   [8] ika_program      readonly
//
// Data (after disc): message_digest[32], message_metadata_digest[32],
//                    user_pubkey[32], signature_scheme u16 LE,
//                    msg_approval_bump u8, cpi_authority_bump u8
//                    Total = 1 + 100 = 101 bytes

export function ikaSignIx(
  user: PublicKey,
  coordinator: PublicKey,
  messageApproval: PublicKey,
  dwallet: PublicKey,
  ikaPosition: PublicKey,
  callerProgram: PublicKey,
  cpiAuthority: PublicKey,
  messageDigest: Uint8Array,
  messageMetadataDigest: Uint8Array,
  userPubkey: Uint8Array,
  signatureScheme: number,
  msgApprovalBump: number,
  cpiAuthorityBump: number
): TransactionInstruction {
  if (messageDigest.length !== 32)          throw new Error("messageDigest must be 32 bytes");
  if (messageMetadataDigest.length !== 32)  throw new Error("messageMetadataDigest must be 32 bytes");
  if (userPubkey.length !== 32)             throw new Error("userPubkey must be 32 bytes");

  const data = concat(
    u8(0x13),
    messageDigest,
    messageMetadataDigest,
    userPubkey,
    u16LE(signatureScheme),
    u8(msgApprovalBump),
    u8(cpiAuthorityBump)
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,            isSigner: true,  isWritable: true  },
      { pubkey: coordinator,     isSigner: false, isWritable: false },
      { pubkey: messageApproval, isSigner: false, isWritable: true  },
      { pubkey: dwallet,         isSigner: false, isWritable: false },
      { pubkey: ikaPosition,     isSigner: false, isWritable: false },
      { pubkey: callerProgram,   isSigner: false, isWritable: false },
      { pubkey: cpiAuthority,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: IKA_PROGRAM_PK,  isSigner: false, isWritable: false },
    ],
    data,
  });
}
