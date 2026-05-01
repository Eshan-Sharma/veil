-- ─── Veil Postgres schema ────────────────────────────────────────────────────
-- Run via:  npm run db:migrate
-- Idempotent — safe to re-apply.
--
-- Cluster scoping: tables that hold on-chain state (pools, positions, tx_log,
-- audit_log) carry a `cluster` column so a single database can host multiple
-- clusters' rows without collision. API routes always filter/insert with the
-- current `NETWORK` constant. Mainnet should still use a dedicated database;
-- the column makes mistakes loud rather than catastrophic.

CREATE TABLE IF NOT EXISTS pool_admins (
  pubkey       TEXT PRIMARY KEY,
  role         TEXT NOT NULL DEFAULT 'pool_admin', -- 'super_admin' | 'pool_admin'
  label        TEXT,
  added_by     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pool_admins_role ON pool_admins(role) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pools (
  cluster          TEXT NOT NULL,                       -- 'mainnet'|'devnet'|'localnet'
  pool_address     TEXT NOT NULL,                       -- Solana PDA
  token_mint       TEXT NOT NULL,
  symbol           TEXT,                                -- ui label (SOL, BTC, ...)
  authority        TEXT NOT NULL,                       -- on-chain pool.authority
  vault            TEXT NOT NULL,                       -- ATA owned by pool_authority PDA
  pool_bump        INTEGER NOT NULL,
  authority_bump   INTEGER NOT NULL,
  vault_bump       INTEGER NOT NULL,
  paused           BOOLEAN NOT NULL DEFAULT false,
  total_deposits   NUMERIC NOT NULL DEFAULT 0,
  total_borrows    NUMERIC NOT NULL DEFAULT 0,
  accumulated_fees NUMERIC NOT NULL DEFAULT 0,
  supply_index     TEXT NOT NULL DEFAULT '1000000000000000000',
  borrow_index     TEXT NOT NULL DEFAULT '1000000000000000000',
  -- Risk parameters (stored as text for u128 fidelity)
  ltv_wad                  TEXT,
  liquidation_threshold_wad TEXT,
  liquidation_bonus_wad    TEXT,
  protocol_liq_fee_wad     TEXT,
  reserve_factor_wad       TEXT,
  close_factor_wad         TEXT,
  base_rate_wad            TEXT,
  optimal_util_wad         TEXT,
  slope1_wad               TEXT,
  slope2_wad               TEXT,
  flash_fee_bps            INTEGER,
  decimals                 INTEGER NOT NULL DEFAULT 9,
  -- Oracle
  oracle_price       NUMERIC,
  oracle_conf        NUMERIC,
  oracle_expo        INTEGER,
  pyth_price_feed    TEXT,
  -- Bookkeeping
  created_by         TEXT,
  init_signature     TEXT,
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster, pool_address)
);
CREATE INDEX IF NOT EXISTS idx_pools_mint ON pools(cluster, token_mint);
CREATE INDEX IF NOT EXISTS idx_pools_authority ON pools(cluster, authority);

CREATE TABLE IF NOT EXISTS positions (
  cluster           TEXT NOT NULL,
  position_address  TEXT NOT NULL,
  pool_address      TEXT NOT NULL,
  owner             TEXT NOT NULL,
  deposit_shares    NUMERIC NOT NULL DEFAULT 0,
  borrow_principal  NUMERIC NOT NULL DEFAULT 0,
  deposit_idx_snap  TEXT,
  borrow_idx_snap   TEXT,
  health_factor_wad TEXT,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster, position_address),
  FOREIGN KEY (cluster, pool_address) REFERENCES pools(cluster, pool_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_positions_owner ON positions(cluster, owner);
CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(cluster, pool_address);
CREATE INDEX IF NOT EXISTS idx_positions_health ON positions(cluster, health_factor_wad)
  WHERE borrow_principal > 0;

CREATE TABLE IF NOT EXISTS tx_log (
  id              BIGSERIAL PRIMARY KEY,
  cluster         TEXT NOT NULL,
  signature       TEXT NOT NULL,
  pool_address    TEXT,
  wallet          TEXT NOT NULL,
  action          TEXT NOT NULL, -- deposit|withdraw|borrow|repay|liquidate|cross_*|flash*|init|init_position|update_pool|pause|resume|collect_fees|update_oracle|set_pool_decimals
  amount          NUMERIC,
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'confirmed'|'failed'
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cluster, signature)
);
CREATE INDEX IF NOT EXISTS idx_tx_log_wallet ON tx_log(cluster, wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_log_pool ON tx_log(cluster, pool_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_log_action ON tx_log(cluster, action, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  cluster      TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(cluster, actor, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_nonces (
  pubkey      TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pubkey, nonce)
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);

-- Rate-limit windows for /api/auth/nonce. Key is the requester (pubkey or IP).
-- Old rows are GC'd opportunistically on every nonce issuance.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket      TEXT NOT NULL,         -- e.g. "pubkey:<base58>" or "ip:<addr>"
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket_ts ON rate_limit(bucket, ts DESC);
