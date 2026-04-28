import { Connection, PublicKey, ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID } from "./constants";

/**
 * Maps the 1-byte instruction discriminator → action label used by tx_log.
 * Must stay in sync with programs/src/instructions/*.rs DISCRIMINATOR consts.
 */
const ACTION_BY_DISCRIMINATOR: Record<number, string> = {
  0x00: "init",
  0x01: "deposit",
  0x02: "withdraw",
  0x03: "borrow",
  0x04: "repay",
  0x05: "liquidate",
  0x06: "flash_borrow",
  0x07: "flash_repay",
  0x0D: "update_pool",
  0x0E: "pause",
  0x0F: "resume",
  0x10: "collect_fees",
  0x14: "update_oracle",
  0x15: "set_pool_decimals",
  0x16: "cross_borrow",
  0x17: "cross_withdraw",
  0x18: "cross_repay",
  0x19: "cross_liquidate",
  0x1A: "init_position",
};

export type OnchainTx = {
  id: string;
  signature: string;
  wallet: string;
  action: string;
  pool_address: string | null;
  amount: string | null;
  status: "confirmed" | "failed";
  error_msg: string | null;
  created_at: string;
  source: "chain";
};

/**
 * Pull recent Veil-program transactions for a wallet directly from the cluster.
 * Used as a fallback when the indexer DB is empty (fresh deploy, missed POSTs,
 * or rejected actions before the whitelist was widened).
 *
 * Strategy: getSignaturesForAddress is cheap (one RPC); fetching each parsed
 * tx is N more RPCs, so we cap at `limit` and run them in small batches to
 * stay polite to public RPCs.
 */
export async function fetchOnchainTxs(
  connection: Connection,
  wallet: PublicKey,
  limit = 50,
): Promise<OnchainTx[]> {
  const sigs = await connection.getSignaturesForAddress(wallet, { limit });
  if (sigs.length === 0) return [];

  const programIdStr = PROGRAM_ID.toBase58();
  const walletStr = wallet.toBase58();
  const out: OnchainTx[] = [];

  // Batch by 10 to bound concurrent RPCs.
  for (let i = 0; i < sigs.length; i += 10) {
    const batch = sigs.slice(i, i + 10);
    const txs = await Promise.all(
      batch.map((s) =>
        connection
          .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
          .catch(() => null),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const sigInfo = batch[j];
      const tx = txs[j];
      if (!tx) continue;

      const ixs = tx.transaction.message.instructions;
      // Only count instructions that target the Veil program.
      const veilIxs = ixs.filter(
        (ix): ix is PartiallyDecodedInstruction =>
          ix.programId.toBase58() === programIdStr && "data" in ix,
      );
      if (veilIxs.length === 0) continue;

      // First Veil ix in the tx defines the action label. (Flash bundles two —
      // we surface the first as `flash_borrow`; tx_log uses `flash` historically,
      // but that distinction is preserved in the DB for older rows only.)
      const primary = veilIxs[0];
      let discriminator: number | null = null;
      try {
        const raw = bs58.decode(primary.data);
        if (raw.length > 0) discriminator = raw[0];
      } catch { /* malformed data — skip */ }
      if (discriminator === null) continue;

      const action = ACTION_BY_DISCRIMINATOR[discriminator];
      if (!action) continue; // unknown / private-* (encrypted) ix — skip

      // Pool account: position is instruction-specific, but for every
      // user-facing action it's the first non-signer non-system account in
      // the ix's accounts list. We just take the first account that's owned
      // by the program — cheap heuristic, good enough for display.
      const poolAddress = primary.accounts.find((a) => a.toBase58() !== walletStr)?.toBase58() ?? null;

      out.push({
        id: sigInfo.signature,
        signature: sigInfo.signature,
        wallet: walletStr,
        action,
        pool_address: poolAddress,
        amount: null, // would require ix-data layout per action; left null for fallback view
        status: tx.meta?.err ? "failed" : "confirmed",
        error_msg: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
        created_at: sigInfo.blockTime
          ? new Date(sigInfo.blockTime * 1000).toISOString()
          : new Date().toISOString(),
        source: "chain",
      });
    }
  }

  return out;
}
