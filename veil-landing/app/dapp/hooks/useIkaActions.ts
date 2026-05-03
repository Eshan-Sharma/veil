"use client";

import { useCallback, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { logSafe } from "@/lib/log";
import {
  findCpiAuthority,
  findIkaPosition,
  findMessageApproval,
  ikaRegisterIx,
  ikaReleaseIx,
  ikaSignIx,
  ikaTransferOwnershipIx,
  ikaDkgClient,
  DEFAULT_IKA_GRPC_URL,
  type DkgResult,
  IKA_PROGRAM_ID,
  type SignatureSchemeValue,
  type DWalletCurveValue,
} from "@/lib/ika";
import { PROGRAM_ID } from "@/lib/veil/constants";
import type { PoolView } from "@/lib/veil/usePools";

export type IkaTxStatus = "idle" | "dkg" | "transfer" | "register" | "sign" | "release" | "success" | "error";

export const useIkaActions = (grpcUrl: string = DEFAULT_IKA_GRPC_URL) => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<IkaTxStatus>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => { setStatus("idle"); setTxSig(null); setErrorMsg(null); };

  /** Submit a single instruction with a fresh blockhash. */
  const sendOne = useCallback(
    async (ix: TransactionInstruction, label: IkaTxStatus): Promise<string> => {
      if (!publicKey) throw new Error("wallet not connected");
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setStatus(label);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
    [publicKey, connection, sendTransaction]
  );

  /**
   * Run DKG with the Ika network. Returns the resulting dWallet account
   * (authority = user). Caller follows with `transferAuthority` then
   * `registerCollateral` to complete the setup.
   */
  const runDkg = useCallback(async (): Promise<DkgResult> => {
    if (!publicKey) throw new Error("wallet not connected");
    setStatus("dkg"); setErrorMsg(null);
    const client = ikaDkgClient(grpcUrl);
    return client.createDWallet(publicKey);
  }, [publicKey, grpcUrl]);

  /**
   * Hand the dWallet's authority over to Veil's CPI authority PDA. After
   * this transaction confirms, Veil — not the user directly — controls
   * which messages the dWallet signs.
   */
  const transferAuthority = useCallback(
    async (dwallet: PublicKey): Promise<string> => {
      if (!publicKey) throw new Error("wallet not connected");
      const [cpiAuth] = await findCpiAuthority(PROGRAM_ID);
      const ix = ikaTransferOwnershipIx(publicKey, dwallet, cpiAuth);
      return sendOne(ix, "transfer");
    },
    [publicKey, sendOne]
  );

  /**
   * Create the IkaDwalletPosition PDA on Veil. Records the dWallet as
   * collateral with the supplied USD value. Pool authority on the dWallet
   * must already be Veil's CPI PDA (call `transferAuthority` first).
   */
  const registerCollateral = useCallback(
    async (
      pool: PoolView,
      dwallet: PublicKey,
      curve: DWalletCurveValue,
      signatureScheme: SignatureSchemeValue,
      usdValueCents: bigint,
    ): Promise<{ position: PublicKey; signature: string }> => {
      if (!publicKey) throw new Error("wallet not connected");
      const [position, posBump] = await findIkaPosition(pool.poolAddress, publicKey, PROGRAM_ID);
      const [cpiAuth, cpiAuthBump] = await findCpiAuthority(PROGRAM_ID);
      const ix = ikaRegisterIx(
        publicKey, pool.poolAddress, dwallet, position, cpiAuth,
        usdValueCents, curve, signatureScheme, posBump, cpiAuthBump,
      );
      const signature = await sendOne(ix, "register");
      return { position, signature };
    },
    [publicKey, sendOne]
  );

  /**
   * Request a cross-chain signature from the dWallet network. Submits the
   * Veil ikaSign instruction, which CPIs to Ika's approve_message. Caller
   * polls the returned MessageApproval PDA's status byte (offset 172) to
   * detect when the signature has been written.
   */
  const sign = useCallback(
    async (
      pool: PoolView,
      dwallet: PublicKey,
      messageHash: Uint8Array,
      userPubkey: Uint8Array,
      signatureScheme: SignatureSchemeValue,
      messageMetadataDigest: Uint8Array = new Uint8Array(32),
    ): Promise<{ approval: PublicKey; signature: string }> => {
      if (!publicKey) throw new Error("wallet not connected");
      const [position] = await findIkaPosition(pool.poolAddress, publicKey, PROGRAM_ID);
      const [cpiAuth, cpiAuthBump] = await findCpiAuthority(PROGRAM_ID);
      const [approval, approvalBump] = await findMessageApproval(
        dwallet, messageHash, messageMetadataDigest, signatureScheme,
      );
      const callerProgram = new PublicKey(PROGRAM_ID.toBytes());
      const ix = ikaSignIx(
        publicKey, approval, dwallet, position, callerProgram, cpiAuth,
        messageHash, userPubkey, signatureScheme, approvalBump, cpiAuthBump,
      );
      const signature = await sendOne(ix, "sign");
      return { approval, signature };
    },
    [publicKey, sendOne]
  );

  /**
   * Release the dWallet — Veil CPIs `transfer_ownership` back to the user.
   * Fails on-chain if the user has any outstanding borrow or any cross
   * collateral marker still active in the matching UserPosition.
   */
  const release = useCallback(
    async (pool: PoolView, dwallet: PublicKey): Promise<string> => {
      if (!publicKey) throw new Error("wallet not connected");
      const [position] = await findIkaPosition(pool.poolAddress, publicKey, PROGRAM_ID);
      const [cpiAuth, cpiAuthBump] = await findCpiAuthority(PROGRAM_ID);
      const callerProgram = new PublicKey(PROGRAM_ID.toBytes());
      const ix = ikaReleaseIx(
        publicKey, pool.poolAddress, dwallet, position, callerProgram, cpiAuth, cpiAuthBump,
      );
      return sendOne(ix, "release");
    },
    [publicKey, sendOne]
  );

  /**
   * Single-call orchestration of the full setup: DKG → authority transfer
   * → on-chain registration. Used by `IkaSetupModal`.
   */
  const setupCollateral = useCallback(
    async (
      pool: PoolView,
      signatureScheme: SignatureSchemeValue,
      usdValueCents: bigint,
    ) => {
      try {
        reset();
        const dkg = await runDkg();
        const transferSig = await transferAuthority(dkg.dwallet);
        const reg = await registerCollateral(pool, dkg.dwallet, dkg.curve, signatureScheme, usdValueCents);
        setTxSig(reg.signature);
        setStatus("success");
        return { ...dkg, transferSig, registerSig: reg.signature, position: reg.position };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logSafe("error", "ika.setup_failed", { err: msg });
        setErrorMsg(msg);
        setStatus("error");
        throw e;
      }
    },
    [runDkg, transferAuthority, registerCollateral]
  );

  return {
    runDkg, transferAuthority, registerCollateral, sign, release,
    setupCollateral,
    status, txSig, errorMsg, reset,
    ikaProgramId: IKA_PROGRAM_ID,
  };
};
