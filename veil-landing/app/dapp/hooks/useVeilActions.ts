"use client";

import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useSolanaRpc } from "@/app/providers/SolanaProvider";
import {
  depositIx,
  withdrawIx,
  borrowIx,
  repayIx,
  liquidateIx,
  flashBorrowIx,
  flashRepayIx,
  findPoolAuthorityAddress,
  findPositionAddress,
  TOKEN_PROGRAM_ID,
} from "@/lib/veil";
import type { PoolView } from "@/lib/veil/usePools";

export type TxStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";

const logTx = (p: { signature: string; wallet: string; action: string; pool_address?: string; amount?: bigint; status?: string; error_msg?: string }) => {
  void fetch("/api/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...p, amount: p.amount?.toString() }),
  }).catch(() => {});
};

const syncPool = (poolAddress: string, rpc: string) => {
  void fetch("/api/pools/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool_address: poolAddress, rpc }),
  }).catch(() => {});
};

const syncPosition = (poolAddress: string, user: string, rpc: string) => {
  void fetch("/api/positions/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool_address: poolAddress, user, rpc }),
  }).catch(() => {});
};

export const useVeilActions = () => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { endpoint } = useSolanaRpc();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => { setStatus("idle"); setTxSig(null); setErrorMsg(null); };

  async function sendTx(
    buildIx: () => TransactionInstruction,
    meta: { action: string; poolAddress: string; amount?: bigint },
  ) {
    if (!publicKey) return;
    setStatus("building");
    setErrorMsg(null);
    setTxSig(null);
    try {
      const ix = buildIx();
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setStatus("signing");
      const sig = await sendTransaction(tx, connection);
      setStatus("confirming");
      await connection.confirmTransaction(sig, "confirmed");
      setStatus("success");
      setTxSig(sig);
      logTx({ signature: sig, wallet: publicKey.toBase58(), action: meta.action,
              pool_address: meta.poolAddress, amount: meta.amount, status: "confirmed" });
      syncPool(meta.poolAddress, endpoint);
      syncPosition(meta.poolAddress, publicKey.toBase58(), endpoint);
    } catch (e: unknown) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
    }
  }

  const deposit = useCallback(
    async (pool: PoolView, amount: bigint) => {
      if (!publicKey) return;
      const [position, positionBump] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => depositIx(publicKey, userToken, pool.vault, pool.poolAddress, position, amount, positionBump),
        { action: "deposit", poolAddress: pool.poolAddress.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  const withdraw = useCallback(
    async (pool: PoolView, shares: bigint) => {
      if (!publicKey) return;
      const [authority] = findPoolAuthorityAddress(pool.poolAddress);
      const [position] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => withdrawIx(publicKey, userToken, pool.vault, pool.poolAddress, position, authority, shares),
        { action: "withdraw", poolAddress: pool.poolAddress.toBase58(), amount: shares },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  const borrow = useCallback(
    async (pool: PoolView, amount: bigint) => {
      if (!publicKey) return;
      const [authority] = findPoolAuthorityAddress(pool.poolAddress);
      const [position] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => borrowIx(publicKey, userToken, pool.vault, pool.poolAddress, position, authority, amount),
        { action: "borrow", poolAddress: pool.poolAddress.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  const repay = useCallback(
    async (pool: PoolView, amount: bigint) => {
      if (!publicKey) return;
      const [position] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => repayIx(publicKey, userToken, pool.vault, pool.poolAddress, position, amount),
        { action: "repay", poolAddress: pool.poolAddress.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  const liquidate = useCallback(
    async (pool: PoolView, borrower: PublicKey) => {
      if (!publicKey) return;
      const [authority] = findPoolAuthorityAddress(pool.poolAddress);
      const [borrowerPos] = findPositionAddress(pool.poolAddress, borrower);
      const liquidatorToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => liquidateIx(publicKey, liquidatorToken, pool.vault, pool.poolAddress, borrowerPos, authority),
        { action: "liquidate", poolAddress: pool.poolAddress.toBase58() },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  const flashExecute = useCallback(
    async (pool: PoolView, amount: bigint) => {
      if (!publicKey) return;
      const [authority] = findPoolAuthorityAddress(pool.poolAddress);
      const borrowerToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      const tx = new Transaction();
      tx.add(flashBorrowIx(publicKey, borrowerToken, pool.vault, pool.poolAddress, authority, amount));
      tx.add(flashRepayIx(publicKey, borrowerToken, pool.vault, pool.poolAddress));
      setStatus("building"); setErrorMsg(null); setTxSig(null);
      try {
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        setStatus("signing");
        const sig = await sendTransaction(tx, connection);
        setStatus("confirming");
        await connection.confirmTransaction(sig, "confirmed");
        setStatus("success");
        setTxSig(sig);
        logTx({ signature: sig, wallet: publicKey.toBase58(), action: "flash",
                pool_address: pool.poolAddress.toBase58(), amount, status: "confirmed" });
        syncPool(pool.poolAddress.toBase58(), endpoint);
      } catch (e: unknown) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, endpoint, sendTransaction]
  );

  return { deposit, withdraw, borrow, repay, liquidate, flashExecute, status, txSig, errorMsg, reset };
};
