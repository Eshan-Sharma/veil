# Problem Statement

Solana has become the leading venue for on-chain capital markets. But two structural gaps prevent institutional and sophisticated capital from fully participating — and both have remained unsolved because fixing one typically makes the other worse.

## The Liquidity Problem

The majority of the world's crypto wealth — Bitcoin, Ethereum, and gold-backed assets — cannot be used as collateral in Solana lending markets without first being bridged or wrapped. Bridges introduce custody risk, synthetic exposure, and trusted third parties that sophisticated participants won't accept. Institutions won't pledge $1M of native BTC into a protocol that requires them to trust a bridge operator. The same logic applies to physical gold: despite being a multi-trillion dollar asset class, gold has never been accessible as productive collateral in DeFi.

As a result, Solana lending protocols compete over a narrow slice of capital that is already on-chain, while trillions in BTC, ETH, and gold sit idle on other chains or in vaults — unable to participate without introducing unacceptable risk.

## The Transparency Problem

Every position, balance, and borrow amount is publicly visible on-chain. For any participant managing meaningful capital — a hedge fund, a market maker, a proprietary trading desk — this is unacceptable. Your collateral ratio, your liquidation price, your strategy: all visible to anyone with an RPC call.

The consequences are direct: front-running, liquidation targeting, and strategy leakage. This isn't a theoretical risk. It's a structural reason why sophisticated capital stays off-chain. The protocols that do attract institutional interest often do so through private deployments, whitelists, or off-chain settlement — which defeats the purpose of building on a public blockchain.

---

# Proposed Solution

Veil is a lending protocol on Solana that removes both barriers simultaneously, with a single unified interface.

## Cross-Chain Native Collateral

For the liquidity problem, Veil integrates [Ika's dWallet infrastructure](https://github.com/dwallet-labs/ika). A dWallet is a programmable, cross-chain signing mechanism governed jointly by the user and Ika's MPC network. This means a Solana lending program can enforce collateral logic against native Bitcoin or Ethereum held in a dWallet — no bridging, no wrapping, no custodian.

A user pledges native BTC. The Solana program tracks the position. If the position becomes unhealthy, the liquidation instruction triggers a dWallet signing event that settles directly on Bitcoin's native chain. Solana becomes the coordination layer for capital from every chain.

## Physical Gold as Collateral

Veil integrates [Oro's GRAIL platform](https://docs.grail.oro.finance/) to bring physical gold on-chain as productive collateral. Oro is an API-first digital gold infrastructure provider that handles the hard parts: physical custody, regulatory compliance, KYC, and on-chain settlement. Gold holders — individuals, family offices, institutions — can for the first time use their gold as collateral in a DeFi lending protocol without bridging risk or custodial compromise.

This makes Veil the first DeFi lending protocol where native BTC, native ETH, and physical gold can all be pledged as collateral in the same unified interface.

## Optional Privacy Layer

For the transparency problem, Veil integrates [Encrypt's](https://docs.encrypt.xyz/) FHE infrastructure. Privacy is a per-position opt-in toggle with no impact on users who don't use it.

### How it works

Calling `EnablePrivacy` (instruction 8) creates an `EncryptedPosition` account alongside the existing `UserPosition`. The Encrypt program creates two ciphertext accounts — one holding the encrypted deposit balance (`enc_deposit`), one holding the encrypted debt (`enc_debt`). Each is a 32-byte handle pointing at a ciphertext account owned by the Encrypt program.

From that point forward, the five private instruction variants (`PrivateDeposit`, `PrivateBorrow`, `PrivateRepay`, `PrivateWithdraw`, and `EnablePrivacy`) keep the ciphertext accounts in sync. Each instruction:

1. Executes the standard lending logic (same token transfers, same health factor enforcement via plaintext `UserPosition`).
2. Creates an ephemeral plaintext ciphertext for the instruction's amount.
3. Submits an FHE computation graph to the Encrypt program via CPI — e.g., `add_deposit`, `sub_debt`.
4. Optionally submits an `is_healthy` graph that produces an encrypted `EBool` result, allowing off-chain verifiers to audit health without seeing position values.

An off-chain executor evaluates the graph and commits updated ciphertext. To any RPC observer, the position account exposes only opaque 32-byte handles.

### Solvency and privacy are joint properties

The `UserPosition` is never removed. It remains the authoritative source of truth for on-chain health factor enforcement — the protocol cannot be exploited by manipulating ciphertext. Privacy provides observer confidentiality; the program proves solvency in plaintext.

### Implementation status

The Encrypt SDK (`encrypt-pinocchio`) currently requires pinocchio 0.10.x. Veil's core program targets 0.11.x. All five private instructions, the `EncryptedPosition` account, the `EncryptContext` wrapper, and the FHE graph definitions are fully implemented and wired into the entrypoint. The `execute_graph` CPI call is stubbed and activates once the SDK updates its pinocchio dependency.

Encrypt program ID (devnet): `4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`

## Flash Loans

Veil includes a native flash loan primitive. A borrower can take any amount up to the pool's free liquidity within a single Solana transaction. The funds are transferred out at the start and must be returned — with a 0.09 % fee — by the end of the same transaction. If the repayment instruction is missing or the amount falls short, the transaction reverts atomically and no funds leave the pool.

The fee is split 90 % to liquidity providers and 10 % to the protocol. Flash loans make arbitrage, liquidation bots, and on-chain collateral swaps capital-efficient: no upfront collateral required, just atomically correct execution.

## Efficient Execution

The core protocol — liquidity pool, kink-curve interest rate model, health factor engine, Pyth oracle integration, and liquidation mechanism — is built using [Pinocchio](https://github.com/febo/pinocchio), Solana's zero-dependency, zero-copy program framework. This gives Veil significantly lower compute unit consumption than equivalent Anchor-based protocols, which matters at scale when health factor checks run on every borrow and liquidation.

## Architecture Philosophy

Veil is designed to work today as a functional lending protocol and extend in place as Ika and Encrypt reach mainnet. No migration required. Each integration layer — cross-chain collateral, gold collateral, FHE privacy, and flash loans — is independently upgradeable without disrupting the core protocol.
