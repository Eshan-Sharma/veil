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
// Mirrors Ika's redesigned `approve_message` (Apr 13 2026 SDK update):
// coordinator was dropped, sig_scheme shrank u16→u8, metadata_digest was
// removed from the instruction payload (the MessageApproval account still
// stores it for binding, the PDA derivation still includes the optional
// metadata digest seed — see findMessageApproval).
//
// Accounts (8):
//   [0] user             signer, writable
//   [1] message_approval writable
//   [2] dwallet          readonly
//   [3] ika_position     readonly
//   [4] caller_program   readonly  (Veil program)
//   [5] cpi_authority    readonly
//   [6] system_program
//   [7] ika_program      readonly
//
// Data (after disc): message_hash[32], user_pubkey[32], signature_scheme u8,
//                    msg_approval_bump u8, cpi_authority_bump u8
//                    Total = 1 + 67 = 68 bytes

export function ikaSignIx(
  user: PublicKey,
  messageApproval: PublicKey,
  dwallet: PublicKey,
  ikaPosition: PublicKey,
  callerProgram: PublicKey,
  cpiAuthority: PublicKey,
  messageHash: Uint8Array,
  userPubkey: Uint8Array,
  signatureScheme: number,
  msgApprovalBump: number,
  cpiAuthorityBump: number
): TransactionInstruction {
  if (messageHash.length !== 32) throw new Error("messageHash must be 32 bytes");
  if (userPubkey.length !== 32)  throw new Error("userPubkey must be 32 bytes");

  const data = concat(
    u8(0x13),
    messageHash,
    userPubkey,
    u8(signatureScheme),
    u8(msgApprovalBump),
    u8(cpiAuthorityBump)
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,            isSigner: true,  isWritable: true  },
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

// ─── Ika `transfer_ownership` direct-signer path (disc 24) ─────────────────
//
// Submitted by the dWallet's current authority (the user) directly to the
// Ika program — no Veil CPI involved. Used by the modal flow to hand the
// dWallet over to Veil's CPI authority PDA before `ikaRegisterIx` runs.
//
// Accounts (2):
//   [0] current_authority signer
//   [1] dwallet           writable
//
// Data: discriminator(1) + new_authority(32) = 33 bytes.

export function ikaTransferOwnershipIx(
  currentAuthority: PublicKey,
  dwallet: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction {
  const data = concat(u8(24), newAuthority.toBytes());
  return new TransactionInstruction({
    programId: IKA_PROGRAM_PK,
    keys: [
      { pubkey: currentAuthority, isSigner: true,  isWritable: false },
      { pubkey: dwallet,          isSigner: false, isWritable: true  },
    ],
    data,
  });
}
