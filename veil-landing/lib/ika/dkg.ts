/**
 * Ika dWallet DKG client.
 *
 * Thin wrapper over `@ika.xyz/pre-alpha-solana-client/grpc-web` that:
 *   1. submits a DKG request to the Ika MPC pre-alpha network,
 *   2. derives the resulting on-chain dWallet PDA from the DKG attestation,
 *   3. exposes `requestSign` for cross-chain signing.
 *
 * The pre-alpha network uses mock signers (no real 2PC-MPC); the user
 * signature in the request is all-zero by design — every validator accepts
 * any signature for now. See the SDK README in the dwallet-labs/ika-pre-alpha
 * repo for the protocol roadmap.
 */

import { createIkaWebClient } from "@ika.xyz/pre-alpha-solana-client/grpc-web";
import { PublicKey } from "@solana/web3.js";
import { findDwallet } from "./pda";
import { DWalletCurve, type DWalletCurveValue } from "./types";

/** Default Ika gRPC-Web endpoint for the Solana pre-alpha network. */
export const DEFAULT_IKA_GRPC_URL = "https://pre-alpha-dev-1.ika.ika-network.net:443";

export type DkgResult = {
  /** Solana on-chain address of the freshly created dWallet account. */
  dwallet: PublicKey;
  /** Raw public key produced by DKG (curve-specific length). */
  publicKey: Uint8Array;
  /** Curve used by this dWallet — same enum value passed to ikaRegister. */
  curve: DWalletCurveValue;
};

export type IkaDkgClient = {
  /**
   * Run DKG with the Ika network and return the resulting dWallet account.
   *
   * After this resolves the Ika network has already submitted the on-chain
   * transaction that creates the dWallet account (authority = `senderPubkey`);
   * callers can read it with `getAccountInfo(result.dwallet)`.
   */
  createDWallet(senderPubkey: PublicKey): Promise<DkgResult>;

  /**
   * Request the MPC network to produce a signature over `message` for the
   * given dWallet, after the matching `ikaSign` (Veil disc 0x13) has created
   * the MessageApproval PDA. `txSignature` is the Solana signature of that
   * transaction (used by the network as the approval-proof receipt).
   */
  requestSign(
    senderPubkey: PublicKey,
    dwallet: PublicKey,
    message: Uint8Array,
    presignId: Uint8Array,
    txSignature: Uint8Array,
  ): Promise<Uint8Array>;
};

/** Construct an Ika DKG client targeting the given gRPC-Web URL. */
export function ikaDkgClient(grpcUrl: string = DEFAULT_IKA_GRPC_URL): IkaDkgClient {
  const inner = createIkaWebClient(grpcUrl);
  return {
    async createDWallet(senderPubkey) {
      // Pre-alpha defaults to Curve25519; secp256k1 (BTC/ETH) is not yet
      // exposed in the pre-alpha mock signer. Caller can override later.
      const curve: DWalletCurveValue = DWalletCurve.Curve25519;
      const { publicKey } = await inner.requestDKG(senderPubkey.toBytes());
      const [dwallet] = findDwallet(curve, publicKey);
      return { dwallet, publicKey, curve };
    },

    async requestSign(senderPubkey, dwallet, message, presignId, txSignature) {
      return inner.requestSign(
        senderPubkey.toBytes(),
        dwallet.toBytes(),
        message,
        presignId,
        txSignature,
      );
    },
  };
}
