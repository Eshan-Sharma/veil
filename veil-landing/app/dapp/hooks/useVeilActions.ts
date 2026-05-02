"use client";

import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { logSafe } from "@/lib/log";
import {
  depositIx,
  withdrawIx,
  borrowIx,
  repayIx,
  liquidateIx,
  flashBorrowIx,
  flashRepayIx,
  crossBorrowIx,
  crossWithdrawIx,
  crossRepayIx,
  crossLiquidateIx,
  initPositionIx,
  findPoolAuthorityAddress,
  findPositionAddress,
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from "@/lib/veil";
import type { CollateralPair } from "@/lib/veil/instructions";
import { formatTxError } from "@/lib/veil/errors";
import type { PoolView } from "@/lib/veil/usePools";

export type TxStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";

const logTx = (p: { signature: string; wallet: string; action: string; pool_address?: string; amount?: bigint; status?: string; error_msg?: string }) => {
  void fetch("/api/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...p, amount: p.amount?.toString() }),
  }).catch((err) => logSafe("warn", "veil.tx.log_failed", { err: String(err) }));
};

const syncPool = (poolAddress: string): Promise<void> =>
  fetch("/api/pools/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool_address: poolAddress }),
  }).then(() => {}).catch((err) => logSafe("warn", "veil.pool.sync_failed", { pool: poolAddress, err: String(err) }));

const syncPosition = (poolAddress: string, user: string): Promise<void> =>
  fetch("/api/positions/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pool_address: poolAddress, user }),
  }).then(() => {}).catch((err) => logSafe("warn", "veil.position.sync_failed", { pool: poolAddress, user, err: String(err) }));

export const useVeilActions = () => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => { setStatus("idle"); setTxSig(null); setErrorMsg(null); };

  async function sendTx(
    buildIx: () => TransactionInstruction | TransactionInstruction[],
    meta: { action: string; poolAddress: string; amount?: bigint },
  ) {
    if (!publicKey) return;
    setStatus("building");
    setErrorMsg(null);
    setTxSig(null);
    try {
      const ixResult = buildIx();
      const ixList = Array.isArray(ixResult) ? ixResult : [ixResult];
      const tx = new Transaction();
      for (const ix of ixList) tx.add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // Simulate first to surface program errors with logs (before wallet prompt)
      try {
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
          logSafe("error", "veil.tx.sim_failed", { action: meta.action, err: sim.value.err, logs: sim.value.logs });
          const progErr = sim.value.logs?.find((l) => l.includes("Error") || l.includes("failed"));
          throw new Error(progErr ?? `Simulation failed: ${JSON.stringify(sim.value.err)}`);
        }
      } catch (simErr) {
        // Re-throw program errors, ignore encoding/network errors from unsigned tx
        if (simErr instanceof Error && simErr.message.includes("failed")) throw simErr;
        logSafe("warn", "veil.tx.sim_skipped", { err: String(simErr) });
      }

      setStatus("signing");
      const sig = await sendTransaction(tx, connection);
      setStatus("confirming");
      await connection.confirmTransaction(sig, "confirmed");
      setTxSig(sig);
      logTx({ signature: sig, wallet: publicKey.toBase58(), action: meta.action,
              pool_address: meta.poolAddress, amount: meta.amount, status: "confirmed" });
      // Sync on-chain state to DB before signalling success (so portfolio refetch sees fresh data)
      await Promise.all([
        syncPool(meta.poolAddress),
        syncPosition(meta.poolAddress, publicKey.toBase58()),
      ]);
      setStatus("success");
    } catch (e: unknown) {
      setStatus("error");
      // Full error → console (with logs); friendly one-liner → UI.
      const err = e as Record<string, unknown>;
      const logs = (err?.logs ?? (err?.cause as Record<string, unknown>)?.logs) as string[] | undefined;
      if (logs?.length) {
        logSafe("error", "veil.tx.failed_with_logs", { action: meta.action, logs, err: String(e) });
      } else {
        logSafe("error", "veil.tx.failed", { action: meta.action, err: String(e) });
      }
      setErrorMsg(formatTxError(e));
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
    [publicKey, connection, sendTransaction]
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
    [publicKey, connection, sendTransaction]
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
    [publicKey, connection, sendTransaction]
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
    [publicKey, connection, sendTransaction]
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
    [publicKey, connection, sendTransaction]
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
        void syncPool(pool.poolAddress.toBase58());
      } catch (e: unknown) {
        setStatus("error");
        logSafe("error", "veil.tx.failed", { action: "flash", err: String(e) });
        setErrorMsg(formatTxError(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const crossBorrow = useCallback(
    async (borrowPool: PoolView, collateralPools: PoolView[], amount: bigint) => {
      if (!publicKey) return;
      const [borrowAuth] = findPoolAuthorityAddress(borrowPool.poolAddress);
      const [borrowPos, borrowPosBump] = findPositionAddress(borrowPool.poolAddress, publicKey);
      const userBorrowToken = getAssociatedTokenAddressSync(borrowPool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);

      const collPairs: CollateralPair[] = collateralPools.map((cp) => {
        const [pos] = findPositionAddress(cp.poolAddress, publicKey);
        return { pool: cp.poolAddress, position: pos };
      });

      // Check if borrow position exists on-chain; if not, prepend initPosition to create it
      const posInfo = await connection.getAccountInfo(borrowPos);
      const needsInit = !posInfo || posInfo.owner.equals(SYSTEM_PROGRAM_ID);

      // Check if user has an ATA for the borrow token; if not, create it
      const ataInfo = await connection.getAccountInfo(userBorrowToken);
      const needsAta = !ataInfo;

      await sendTx(
        () => {
          const ixs: TransactionInstruction[] = [];

          if (needsAta) {
            ixs.push(
              createAssociatedTokenAccountInstruction(publicKey, userBorrowToken, publicKey, borrowPool.tokenMint),
            );
          }

          if (needsInit) {
            ixs.push(
              initPositionIx(publicKey, borrowPool.poolAddress, borrowPos, borrowPosBump),
            );
          }

          ixs.push(
            crossBorrowIx(publicKey, borrowPool.poolAddress, borrowPos, borrowPool.vault, userBorrowToken, borrowAuth, collPairs, amount),
          );
          return ixs;
        },
        { action: "cross_borrow", poolAddress: borrowPool.poolAddress.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const crossWithdraw = useCallback(
    async (pool: PoolView, relatedPools: PoolView[], shares: bigint) => {
      if (!publicKey) return;
      const [authority] = findPoolAuthorityAddress(pool.poolAddress);
      const [position] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);

      const relatedPairs: CollateralPair[] = relatedPools.map((rp) => {
        const [pos] = findPositionAddress(rp.poolAddress, publicKey);
        return { pool: rp.poolAddress, position: pos };
      });

      await sendTx(
        () => crossWithdrawIx(publicKey, pool.poolAddress, position, pool.vault, userToken, authority, relatedPairs, shares),
        { action: "cross_withdraw", poolAddress: pool.poolAddress.toBase58(), amount: shares },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const crossRepay = useCallback(
    async (pool: PoolView, collateralPositions: PublicKey[], amount: bigint) => {
      if (!publicKey) return;
      const [position] = findPositionAddress(pool.poolAddress, publicKey);
      const userToken = getAssociatedTokenAddressSync(pool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      await sendTx(
        () => crossRepayIx(publicKey, userToken, pool.vault, pool.poolAddress, position, collateralPositions, amount),
        { action: "cross_repay", poolAddress: pool.poolAddress.toBase58(), amount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  const crossLiquidate = useCallback(
    async (
      debtPool: PoolView,
      collPool: PoolView,
      borrower: PublicKey,
      otherPools: PoolView[],
      repayAmount: bigint,
    ) => {
      if (!publicKey) return;
      const [debtPos] = findPositionAddress(debtPool.poolAddress, borrower);
      const [collPos] = findPositionAddress(collPool.poolAddress, borrower);
      const [collAuth] = findPoolAuthorityAddress(collPool.poolAddress);
      const liquidatorDebtToken = getAssociatedTokenAddressSync(debtPool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);
      const liquidatorCollToken = getAssociatedTokenAddressSync(collPool.tokenMint, publicKey, false, TOKEN_PROGRAM_ID);

      const otherPairs: CollateralPair[] = otherPools.map((op) => {
        const [pos] = findPositionAddress(op.poolAddress, borrower);
        return { pool: op.poolAddress, position: pos };
      });

      await sendTx(
        () => crossLiquidateIx(
          publicKey, liquidatorDebtToken, liquidatorCollToken,
          debtPool.poolAddress, debtPos, debtPool.vault,
          collPool.poolAddress, collPos, collPool.vault,
          collAuth, otherPairs, repayAmount,
        ),
        { action: "cross_liquidate", poolAddress: debtPool.poolAddress.toBase58(), amount: repayAmount },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, connection, sendTransaction]
  );

  return {
    deposit, withdraw, borrow, repay, liquidate, flashExecute,
    crossBorrow, crossWithdraw, crossRepay, crossLiquidate,
    status, txSig, errorMsg, reset,
  };
};
