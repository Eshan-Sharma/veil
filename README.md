# Veil

**Veil is the first lending protocol on Solana where you can borrow against native Bitcoin, physical gold, or any on-chain asset — with an optional privacy layer.**

No bridges. No wrapping. No public visibility into your positions.

---

## The Problem

DeFi lending today has two structural limitations that have kept sophisticated capital on the sidelines.

**Liquidity fragmentation.** Most wealth sits in BTC, ETH, and physical gold. To use it in DeFi, you have to bridge or wrap it — adding custody risk, smart contract risk, and trusted third parties. Institutions won't pledge $1M of native BTC into a protocol that requires them to trust a bridge operator. Billions in capital sit idle.

**Transparent execution.** Every position, balance, and borrow amount is publicly visible on-chain. Your collateral ratio, your liquidation price, your strategy — all readable by anyone with an RPC call. For funds, market makers, and treasury managers, this is a structural non-starter.

Veil removes both constraints through a single, unified interface.

---

## How It Works

### Native Collateral — No Bridging

Veil integrates [Ika's dWallet infrastructure](https://github.com/dwallet-labs/ika). A dWallet is a programmable, cross-chain signing mechanism governed jointly by the user and Ika's MPC network. This means a Solana program can enforce collateral logic against native Bitcoin or Ethereum without bridges or custodians.

If a position becomes undercollateralized, the liquidation instruction triggers a dWallet signing event that settles directly on the native chain. Solana acts as the coordination layer for capital from every chain.

### Physical Gold as Collateral — via Oro

Veil integrates [Oro's GRAIL platform](https://docs.grail.oro.finance/) to support physical gold as collateral. Oro handles the operational complexity — custody, regulatory compliance, and on-chain settlement — so users can pledge gold-backed assets directly. This makes Veil the first DeFi lending protocol where physical gold sits alongside native BTC and ETH as productive collateral.

### Optional Privacy — FHE Layer

Each user position has a privacy toggle. When enabled, Veil integrates [Encrypt's](https://docs.encrypt.xyz/getting-started/installation) FHE infrastructure: balances and borrow amounts are stored as ciphertext on-chain, and health factor computations execute over encrypted data using the REFHE scheme. Observers see nothing — not the collateral, not the debt, not the liquidation price. Protocol invariants (solvency, health factor enforcement) are maintained without exposing position data publicly.

### Efficient On-Chain Execution

The core protocol is built using [Pinocchio](https://github.com/febo/pinocchio), Solana's zero-dependency, zero-copy program framework. This gives Veil significantly lower compute unit consumption than equivalent Anchor-based protocols — which matters at scale when health factor checks run on every borrow and liquidation.

---

## Supported Collateral

| Asset | Source | Settlement |
|---|---|---|
| Native BTC | Ika dWallet | Bitcoin mainnet |
| Native ETH | Ika dWallet | Ethereum mainnet |
| Physical Gold | Oro / GRAIL | On-chain (Oro-settled) |
| SPL tokens / LSTs | Native Solana | Solana |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | Solana |
| Program framework | Pinocchio |
| Cross-chain infra | Ika (dWallet / MPC) |
| Gold collateral | Oro / GRAIL |
| Privacy layer | Encrypt (FHE / REFHE) |
| Oracle | Pyth |

---

## Protocol Design

- Kink-based interest rate model
- Health factor engine with oracle-fed pricing (Pyth)
- Cross-chain liquidation via programmable MPC signing
- Privacy toggle per position (opt-in FHE)
- Designed to upgrade in place as Ika and Encrypt reach mainnet — no migration required

---

## Repository Structure

```
/docs
├── problem_statement.md     # Full breakdown of the problem and solution
├── user_persona.md          # Target users and use cases
└── veil_architecture.svg    # System architecture diagram

/programs
└── src/
    ├── instructions/        # deposit, withdraw, borrow, repay, liquidate, initialize
    ├── state/               # LendingPool, UserPosition, LiquidityPool, Treasury
    ├── errors.rs
    ├── math.rs
    └── entrypoint.rs

/veil-landing                # Next.js marketing site
```

---

## Who Is This For

See [`/docs/user_persona.md`](./docs/user_persona.md) for full profiles. In short:

- **Institutional traders and funds** — BTC/ETH holders who need capital efficiency without custody or privacy tradeoffs
- **Market makers** — need fast liquidity without leaking inventory or strategy
- **DAO treasuries** — large idle holdings, can't justify bridge risk to governance
- **Gold holders** — physical gold that has never been productive on-chain

---

## Status

Early-stage. Core protocol implementation is in progress.

- [x] Protocol design and architecture
- [x] Core program (Pinocchio) — instructions, state, entrypoint
- [ ] Ika dWallet integration
- [ ] Oro/GRAIL gold collateral integration
- [ ] FHE layer (Encrypt)
- [ ] Oracle integration (Pyth)
- [ ] Testnet deployment

---

## Disclaimer

Experimental. Not production-ready. Use at your own risk.
