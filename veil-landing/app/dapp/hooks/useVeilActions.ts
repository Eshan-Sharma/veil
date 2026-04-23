"use client";

import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  depositIx,
  withdrawIx,
  borrowIx,
  repayIx,
  liquidateIx,
  flashBorrowIx,
  flashRepayIx,
  findPoolAddress,
  findPoolAuthorityAddress,
  findPositionAddress,
  findVaultAddress,
  TOKEN_PROGRAM_ID,
} from "@/lib/veil";

/**
 * Devnet token mints for each pool.
 * Override via env vars after deploying and initializing pools.
 */
export const POOL_MINTS: Record<string, PublicKey> = {
  sol: new PublicKey(
    process.env.NEXT_PUBLIC_SOL_MINT ?? "So11111111111111111111111111111111111111112"
  ),
  btc: new PublicKey(
    process.env.NEXT_PUBLIC_BTC_MINT ?? "11111111111111111111111111111111"
  ),
  eth: new PublicKey(
    process.env.NEXT_PUBLIC_ETH_MINT ?? "11111111111111111111111111111111"
  ),
  xau: new PublicKey(
    process.env.NEXT_PUBLIC_XAU_MINT ?? "11111111111111111111111111111111"
  ),
  usdc: new PublicKey(
    process.env.NEXT_PUBLIC_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  ),
};

export type TxStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";

/** Fire-and-forget POST to the tx_log API. */
function logTx(p: { signature: string; wallet: string; action: string; pool_address?: string; amount?: bigint; status?: string; error_msg?: string }) {
  void fetch("/api/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...p, amount: p.amount?.toString() }),
  }).catch(() => {});
}

/** Fire-and-forget pool sync after a state-changing tx. */
function syncPool(poolAddress: string) {
  void fetch("/api/pools/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool_address: poolAddress }),
  }).catch(() => {});
}

export function useVeilActions() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function reset() { setStatus("idle"); setTxSig(null); setErrorMsg(null); }

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
      syncPool(meta.poolAddress);
    } catch (e: unknown) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
    }
  }

  const deposit = useCallback(
    async (poolId: string, amount: bigint) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const [authority] = findPoolAuthorityAddress(pool);
      const vault = findVaultAddress(mint, authority);
      const [position, positionBump] = findPositionAddress(pool, publicKey);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => depositIx(publicKey, userToken, vault, pool, position, amount, positionBump),
        { action: "deposit", poolAddress: pool.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const withdraw = useCallback(
    async (poolId: string, shares: bigint) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const [authority] = findPoolAuthorityAddress(pool);
      const vault = findVaultAddress(mint, authority);
      const [position] = findPositionAddress(pool, publicKey);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => withdrawIx(publicKey, userToken, vault, pool, position, authority, shares),
        { action: "withdraw", poolAddress: pool.toBase58(), amount: shares },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const borrow = useCallback(
    async (poolId: string, amount: bigint) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const [authority] = findPoolAuthorityAddress(pool);
      const vault = findVaultAddress(mint, authority);
      const [position] = findPositionAddress(pool, publicKey);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => borrowIx(publicKey, userToken, vault, pool, position, authority, amount),
        { action: "borrow", poolAddress: pool.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const repay = useCallback(
    async (poolId: string, amount: bigint) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const vault = findVaultAddress(mint, findPoolAuthorityAddress(pool)[0]);
      const [position] = findPositionAddress(pool, publicKey);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => repayIx(publicKey, userToken, vault, pool, position, amount),
        { action: "repay", poolAddress: pool.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const liquidate = useCallback(
    async (poolId: string, borrower: PublicKey) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const [authority] = findPoolAuthorityAddress(pool);
      const vault = findVaultAddress(mint, authority);
      const [borrowerPos] = findPositionAddress(pool, borrower);
      const liquidatorToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => liquidateIx(publicKey, liquidatorToken, vault, pool, borrowerPos, authority),
        { action: "liquidate", poolAddress: pool.toBase58() },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const flashExecute = useCallback(
    async (poolId: string, amount: bigint) => {
      if (!publicKey) return;
      const mint = POOL_MINTS[poolId];
      const [pool] = findPoolAddress(mint);
      const [authority] = findPoolAuthorityAddress(pool);
      const vault = findVaultAddress(mint, authority);
      const borrowerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
      const tx = new Transaction();
      tx.add(flashBorrowIx(publicKey, borrowerToken, vault, pool, authority, amount));
      tx.add(flashRepayIx(publicKey, borrowerToken, vault, pool));
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
                pool_address: pool.toBase58(), amount, status: "confirmed" });
        syncPool(pool.toBase58());
      } catch (e: unknown) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  return { deposit, withdraw, borrow, repay, liquidate, flashExecute, status, txSig, errorMsg, reset };
}
