# Veil

Veil is a privacy-preserving, cross-chain lending protocol built on Solana.  
It enables users to borrow against native assets like BTC and ETH without bridging, while keeping all position data private.

---

## Problem

DeFi lending today has two structural limitations:

### 1. Liquidity Fragmentation
Most capital (BTC, ETH) exists outside Solana.  
To use it, users must bridge or wrap assets, introducing:
- Custodial risk  
- Smart contract risk  
- Trusted intermediaries  

This keeps large pools of capital idle.

### 2. Transparent Execution
All positions are publicly visible on-chain:
- Collateral amounts  
- Borrow positions  
- Liquidation thresholds  

This creates:
- Front-running risk  
- Liquidation targeting  
- Strategy leakage  

For institutional participants, this is a non-starter.

---

## Solution

Veil removes both constraints through:

### Cross-Chain Collateral (No Bridging)
- Uses **Ika dWallets (MPC-based signing)**
- Assets remain on native chains (BTC, ETH)
- Solana acts as the coordination layer

### Private Positions (FHE)
- Integrates **Encrypt’s FHE infrastructure**
- Stores balances and debt as ciphertext
- Computes health factor over encrypted data
- No public visibility into user positions

### Efficient Execution
- Built using **Pinocchio (zero-dependency Solana framework)**
- Lower compute costs vs Anchor
- Optimized for frequent health checks and liquidations

---

## Key Features

- Native BTC/ETH collateral (no wrapping)
- Encrypted balances and borrowing positions
- Cross-chain liquidation via programmable signing
- Kink-based interest rate model
- Health factor-based risk engine
- Oracle integration (e.g., Pyth)

---

## How It Works

1. User deposits native BTC/ETH via dWallet
2. Veil tracks collateral position on Solana
3. User borrows stablecoins
4. Health factor is computed over encrypted data
5. If position becomes unhealthy:
   - Liquidation triggers cross-chain settlement
   - Executed via dWallet signing

---

## Repository Structure
```
/docs
├── problem_statement.md
├── veil_architecture.svg
└── user_persona.md
```

---

## User Personas

This protocol is designed for:

- **Institutional Traders**  
  Care about custody, privacy, capital efficiency  

- **Market Makers**  
  Care about execution speed and hiding strategy  

- **DAO Treasuries**  
  Care about risk, governance, and capital utilization 

And many more...

See: [`/docs/user_persona`](./docs/user_persona.md)

---

## Architecture

Detailed system design, components, and flow are documented here:  [`/docs/veil_architecture`](./docs/veil_architecture.svg)

---

## Problem & Solution

Full breakdown available here:  [`/docs/problem_statement`](./docs/problem_statement.md)  

---

## Tech Stack

- **Blockchain:** Solana  
- **Framework:** Pinocchio  
- **Cross-chain infra:** Ika (dWallet, MPC)  
- **Privacy layer:** Encrypt (FHE / REFHE)  
- **Oracle:** Pyth  

---

## Status

Early-stage / experimental  

- Core protocol design defined  
- Architecture in progress  
- External dependencies (Ika, Encrypt) evolving toward mainnet  

---

## Why This Matters

Veil is targeting a specific gap:

> Capital exists, but cannot be used safely or privately across chains.

By removing:
- bridging risk  
- and on-chain transparency  

Veil makes it possible for larger, more sophisticated capital to participate in on-chain lending.

---

## Disclaimer

This is a conceptual and experimental system.  
Not production-ready. Use at your own risk.

---

## Future Work

- Mainnet integration with Ika and Encrypt  
- Risk parameter tuning  
- UI/UX layer  
- Advanced liquidation strategies  
- Institutional-grade access controls  

