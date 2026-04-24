import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  // Don't throw at module load — server routes throw when they actually run.
  console.warn("[veil/db] DATABASE_URL is not set. API routes will fail.");
}

export const sql = neon(process.env.DATABASE_URL ?? "");

export type AdminRole = "super_admin" | "pool_admin";

export interface AdminRow {
  pubkey: string;
  role: AdminRole;
  label: string | null;
  added_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface PoolRow {
  pool_address: string;
  token_mint: string;
  symbol: string | null;
  authority: string;
  vault: string;
  pool_bump: number;
  authority_bump: number;
  vault_bump: number;
  paused: boolean;
  total_deposits: string;
  total_borrows: string;
  accumulated_fees: string;
  ltv_wad: string | null;
  liquidation_threshold_wad: string | null;
  liquidation_bonus_wad: string | null;
  protocol_liq_fee_wad: string | null;
  reserve_factor_wad: string | null;
  close_factor_wad: string | null;
  base_rate_wad: string | null;
  optimal_util_wad: string | null;
  slope1_wad: string | null;
  slope2_wad: string | null;
  flash_fee_bps: number | null;
  oracle_price: string | null;
  oracle_conf: string | null;
  oracle_expo: number | null;
  pyth_price_feed: string | null;
  created_by: string | null;
  init_signature: string | null;
  last_synced_at: string;
  created_at: string;
}

export interface PositionRow {
  position_address: string;
  pool_address: string;
  owner: string;
  deposit_shares: string;
  borrow_principal: string;
  deposit_idx_snap: string | null;
  borrow_idx_snap: string | null;
  health_factor_wad: string | null;
  last_synced_at: string;
}

export interface TxLogRow {
  id: number;
  signature: string;
  pool_address: string | null;
  wallet: string;
  action: string;
  amount: string | null;
  status: "pending" | "confirmed" | "failed";
  error_msg: string | null;
  created_at: string;
}
