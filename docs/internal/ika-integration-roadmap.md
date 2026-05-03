# Future scope — wire `IkaDwalletPosition` into cross-collateral borrows

**Status:** deferred. Documented during the 2026-04-29 hackathon-prep round.
**Owner:** unassigned.
**Blockers:** see "Security gates" below — must close before this lands on
mainnet (and arguably before devnet).

---

## What works today

| Surface | State |
|---|---|
| `IkaRegister` (disc `0x11`) | ✅ Creates `IkaDwalletPosition` PDA. Verifies dWallet authority == Veil CPI PDA, dWallet account ownership, curve/scheme. **Now enforces per-pool cap** (`pool.max_ika_usd_cents`) — defaults to 0 (registration disabled) until pool authority opts in. |
| `SetIkaCollateralCap` (disc `0x1B`) | ✅ Pool-authority instruction that sets `pool.max_ika_usd_cents`. Closes gate #3 below — caps `usd_value` at registration so a malicious caller can't claim u64::MAX. |
| `IkaSign` (disc `0x13`) | ✅ CPIs `approve_message` on the Ika pre-alpha program (mock signer). |
| `IkaRelease` (disc `0x12`) | ✅ Refuses while `borrow_principal != 0` or `cross_collateral != 0`; CPIs `transfer_dwallet` back to the user. |
| `IkaSetupModal` (frontend) | ✅ Real DKG via [`@ika.xyz/pre-alpha-solana-client`](https://www.npmjs.com/package/@ika.xyz/pre-alpha-solana-client), real `transfer_ownership` to Veil CPI PDA, real `IkaRegister`. |
| BTC and ETH **lending pools** | ✅ `scripts/setup-ika-pools.ts` initialises them on localnet/devnet with sensible Ika caps ($250k BTC, $100k ETH per position). |

## What does **not** work today

The cross-collateral borrow paths (`cross_borrow`, `cross_withdraw`,
`cross_liquidate`) **never read `IkaDwalletPosition`**. They aggregate
collateral from `LendingPool` deposits via the pool's Pyth price only.

That means:

> A user can register a dWallet declaring "I hold $30,000 of BTC", but if
> they have no SPL deposits, **`cross_borrow` will not let them borrow a
> single token against that dWallet**. The Ika position is observable but
> inert.

`programs/tests/scenarios_ika_encrypt.rs::ika_collateral_position_state_machine`
encodes the *target* math for what wiring should produce, against the day
that path lights up.

---

## Why this is deferred (the real reasons)

### 1. `IkaDwalletPosition.usd_value` is user-supplied with no oracle

[`programs/src/instructions/ika_register.rs`](../programs/src/instructions/ika_register.rs)
takes `usd_value: u64` directly from instruction data. There is **no Pyth
attestation** that the dWallet actually controls $X of BTC, no admin
signature, no upper bound. If `cross_borrow` started reading this field
as collateral, an attacker would:

```
1. Run DKG → empty dWallet (mock signer in pre-alpha lets anyone create one).
2. Call `IkaRegister` with usd_value = u64::MAX.
3. Call `cross_borrow` against the strongest pool's vault.
4. Drain the vault.
```

That's not theoretical — it's a one-tx exploit.

### 2. Pre-alpha Ika is mock-signed

The Ika pre-alpha network does not yet attest BTC ownership end-to-end; the
[docs](https://docs.ika.xyz) call out *"signing uses a single mock signer,
not real distributed MPC"*. Even with a Pyth feed, there is no chain-level
proof that the dWallet's BTC balance is what the user claims. Wiring usd
collateral against an unattested mock-signed account is unsafe at any
non-zero exposure.

### 3. The math is decidable but the protocol is not — yet

Inserting a USD-denominated collateral leg into the WAD-scaled cross
arithmetic is straightforward (the math already works in USD WAD via
`pool_token_to_usd`). The blocker is *trust in `usd_value`*, not arithmetic.

---

## Design proposal for when this is unblocked

When the security gates below close, the change shape is:

### On-chain

1. **Add a per-pool cap** to `LendingPool`:
   ```rust
   /// Max dWallet-declared USD value the pool accepts as collateral, in cents.
   /// 0 disables Ika collateral on this pool entirely.
   pub max_ika_usd_per_position: u64,
   ```
   Default `0` keeps every existing pool safe. An admin opt-in via
   `UpdatePool` is required to enable.

2. **Change `IkaRegister` to clamp** at registration:
   ```rust
   if pool.max_ika_usd_per_position == 0 {
       return Err(LendError::IkaCollateralDisabled.into());
   }
   let usd_value = self.usd_value.min(pool.max_ika_usd_per_position);
   ```

3. **Extend `cross_borrow` (and friends)** to accept `IkaDwalletPosition`
   accounts as additional trailing slots:
   ```
   accounts[7..N]                     existing (pool, position) pairs
   accounts[N..M]                     new: IkaDwalletPosition slots
   ```
   For each Ika slot:
   - Verify `pos.owner == user`, `pos.status == ACTIVE`.
   - Add `usd_value × 1e16` (cents → WAD) to the appropriate weighted USD
     buckets, using the **anchored** pool's LTV / liq_threshold.
   - Bind the slot into the cross-set registry (`cross_set_id`,
     `cross_count`) so it cannot be omitted at liquidation time.

4. **`IkaRelease` already** rejects on `cross_collateral != 0` — extend the
   cross-set tracking so the Ika position is part of the set when used as
   collateral, otherwise the release path is bypassable.

5. **New error variants:**
   - `IkaCollateralDisabled` — pool's cap is 0.
   - `IkaCollateralNotAttested` — once oracle attestation lands.

### Frontend

6. `useVeilActions.crossBorrow` / `crossWithdraw` / `crossLiquidate`
   gain an optional `ikaPositions: PublicKey[]` argument that becomes
   trailing slots in the instruction.
7. The dApp's borrow modal exposes "Use my BTC dWallet" as a checkbox
   when the user holds an `IkaDwalletPosition` against the pool.

### Tests

8. New scenarios in `programs/tests/scenarios_ika_encrypt.rs` already lay
   out the *target math* for HF / max-borrow with mixed Ika + SPL collat.
   When B lands, those tests should be promoted from math-only to full
   instruction-dispatch where possible.

---

## Security gates that must close before B is shipped

| # | Gate | Owner | Status | Why |
|---|---|---|---|---|
| 1 | `IkaDwalletPosition.usd_value` derived from a Pyth BTC/ETH feed AT THE NOMINAL DECLARED AMOUNT, not user-supplied | TBD | ❌ open | Forecloses the "register at u64::MAX" attack. The cap (gate #3) bounds blast radius but doesn't prove the dWallet actually holds that much. |
| 2 | Ika pre-alpha → real distributed MPC (network-level) | upstream (dwallet-labs) | ❌ open (upstream) | Without it the dWallet's BTC ownership is unverified. |
| 3 | Per-pool cap (`max_ika_usd_cents`) defaults to 0; admins opt in pool-by-pool | this repo | ✅ **closed 2026-04-30** | `LendingPool.max_ika_usd_cents` (offset 408) + `SetIkaCollateralCap` (disc 0x1B) + enforcement in `IkaRegister`. Tests: `ika_register_disabled_when_cap_zero_rejected`, `ika_register_value_above_cap_rejected`. |
| 4 | Liquidation path supports seizing dWallet collateral (`IkaLiquidate` instruction — audit finding X-01) | this repo | ❌ open | Today a `LIQUIDATED` Ika position is bricked; cross-liquidation against it has no settlement path. |
| 5 | Devnet integration test: open a real dWallet, register, cross-borrow USDC, liquidate via price drop | this repo | ❌ open | Closes the loop end-to-end before mainnet. |

---

## Tracking

When this work picks up, the surface area is:
- `programs/src/state/lending_pool.rs` (+8 bytes)
- `programs/src/instructions/ika_register.rs` (cap enforcement)
- `programs/src/instructions/cross_borrow.rs` (~80 lines)
- `programs/src/instructions/cross_withdraw.rs` (~60 lines)
- `programs/src/instructions/cross_liquidate.rs` (~80 lines + new `IkaLiquidate`)
- `veil-landing/lib/veil/instructions.ts` (extend cross-* signatures)
- `veil-landing/app/dapp/hooks/useVeilActions.ts` (pass-through)
- `programs/tests/scenarios_ika_encrypt.rs` (promote math tests)
- `programs/tests/protocol_tests.rs` (instruction-level coverage)

Estimated diff: ~600 LOC. Estimated time including audit pass: 4–6 days.

Until then, **the Ika integration is a setup demo, not a borrow primitive.**

---

## Security findings deferred to architectural work

Recorded during audit 05 (2026-05-02). Two on-chain findings (I-2, I-5) were
fixed in-place; the three below require larger architectural work and are
deferred. Until they close the IKA flow stays gated behind
`max_ika_usd_cents = 0` (audit gate #3) and remains a setup demo only.

### Deployer checklist (audit 05, finding I-2)

Before any non-devnet deployment, the deployer **must**:

1. Update `IKA_PROGRAM_ID` in `programs/src/ika/mod.rs` to match the
   target cluster's Ika program ID. `Address::from_str_const` is
   `const`-eval and cannot accept `env!()` input, so this is a literal
   edit + rebuild — there is no env-var override.
2. Allocate the Veil CPI-authority PDA
   (`seeds = [b"__ika_cpi_authority"]`) so its on-chain owner is the
   Veil program ID. `ika_register`, `ika_sign`, and `ika_release` now
   reject if the CPI authority is owned by anything other than Veil
   (audit 05, finding I-5). The PDA is allocated once at deploy time
   via a one-shot `system_program::create_account_with_seed`-style
   instruction (followed by a transfer to Veil ownership) — wire this
   into `scripts/setup-ika-pools.ts` before mainnet.

### I-1 (HIGH) — User signature verification on `ika_sign`

**Current behaviour.** `ika_sign` authorizes the cross-chain signature via
`pos.owner == accounts[0].address()` (i.e. the on-chain `IkaDwalletPosition`
records the user pubkey at registration time and re-checks it at sign
time) plus the program's CPI-authority signature against the Ika program.
There is **no on-chain proof that the requesting Solana signer is the
rightful owner of the dWallet keypair** — the Solana signer is just
whoever's listed in `pos.owner`, which is set at register time from
whichever signer paid for the position. Once the position exists, anyone
who compromises Veil (or anyone with a future bug that lets them edit
`pos.owner`) can drive the dWallet via `ika_sign`. A Veil program
compromise grants attacker control over every registered dWallet.

**Intended fix.** The `IkaDwalletPosition` already stores the user pubkey
via `verify_binding`-equivalent layout. Make it explicit, then require the
user to sign the `message_hash` off-chain with their Solana keypair. Pass
the signature in instruction data. Use the ed25519 sigverify precompile
(loaded as a previous instruction in the same transaction; introspect via
`Instructions` sysvar) to verify on-chain that the message hash was signed
by `pos.owner` before the IKA CPI fires. This binds every cross-chain
signing request to a fresh user signature, so a Veil compromise alone is
not enough — the attacker also needs the user's Solana key.

**Effort.** ~1–2 days. Needs ed25519 instruction integration + a TS-side
signing flow in `useVeilActions.ikaSign`.

### I-3 (MED) — `IkaDwalletPosition.usd_value` frozen at registration

**Current behaviour.** `IkaDwalletPosition.usd_value` is set once at
register time (clamped against `pool.max_ika_usd_cents`) and never
updated. If BTC or ETH price doubles after registration, the on-chain
cap check still uses the stale value — the user can effectively borrow
twice the intended cap by registering during a dip.

**Intended fix.** Store the dWallet's BTC/ETH oracle feed reference (32
bytes — same shape as `LendingPool.pyth_price_feed`) on
`IkaDwalletPosition` at register time. On every `ika_sign` (or, more
precisely, on every cross-borrow path that reads the position once gate
#1 closes), fetch the current oracle price and re-validate the cap
dynamically. Document the per-pool oracle requirement in
`SetIkaCollateralCap`'s preconditions.

**Effort.** ~1 day. `IkaDwalletPosition` schema migration (add 32-byte
feed slot) + cap-check refactor in `ika_register` and the future
`cross_borrow` Ika path.

### I-4 (MED) — Multi-pool dWallet release

**Current behaviour.** `ika_release` checks the calling pool's
`UserPosition.borrow_principal` and `cross_collateral`. The same dWallet
could back debt against another Veil pool (e.g. registered against pool
A and pool B), and releasing here lets the user walk away with the
off-chain collateral while pool B's debt remains as an unsecured loan.
The binding from dWallet → pool is one-to-many at registration but
one-to-one at release time, which is the asymmetry that opens the gap.

**Intended fix.** Two options:

1. **Enforce one dWallet per user globally.** Simplest: derive the
   `IkaDwalletPosition` PDA from `[seed, dwallet]` (drop the `pool`
   component), require all registrations of the same dWallet to point at
   the same position. Breaks legitimate multi-pool use cases.
2. **Track all pools per dWallet.** Store a `pools: [Pubkey; N]` list (or
   a dynamically-grown sub-account) on `IkaDwalletPosition`. Every
   register pushes; `ika_release` walks the list and rejects if any
   `UserPosition` for `(user, pool)` has non-zero `borrow_principal` or
   `cross_collateral`. More complex but preserves multi-pool collateral.

Option 2 is the right product call. Option 1 is the right "first
mainnet" call.

**Effort.** ~1 day after the UX decision.

---

After these are filed, the security gates table reflects:

- **Gates 1, 4** (from the table above) plus the three findings here
  (I-1, I-3, I-4) are now on the security-deferred list (audit 05,
  2026-05-02).
- **Gate 3** (per-pool cap) was closed 2026-04-30 — see the table above.
- **Gates 2 and 5** (upstream MPC, devnet integration end-to-end) remain
  as before.

