# User Personas

Veil is designed for participants with significant capital who are currently blocked from using it productively in DeFi — either because of bridge risk, on-chain transparency, or lack of gold-collateral options.

---

## Persona 1: Institutional Trader / Fund Manager

**Name:** Alex
**Role:** Portfolio Manager at a crypto hedge fund

### Background
- Manages $5M–$50M in BTC and ETH
- TradFi background — equities, derivatives, FX
- Uses DeFi selectively, treats it as infrastructure
- Has passed on most lending protocols due to bridge risk or visible positions

### Goal
Maximize capital efficiency without compromising custody, privacy, or execution edge.

### Pain Points
- **Bridge risk:** won't wrap assets or trust bridge operators with fund capital
- **Transparency:** positions and liquidation levels are publicly visible to competitors
- **Idle capital:** BTC/ETH earn nothing while sitting in cold storage

### Mental Model
"Does this add trust assumptions or reduce control?"
Evaluates protocols the way a prime broker evaluates counterparties.

### What Veil Enables
- Native BTC/ETH as collateral — no bridging, no wrapping
- Private positions — competitors can't see collateral ratio or liquidation price
- Borrow stablecoins against idle holdings, deploy into yield or arbitrage

### Workflow
Hold BTC → deposit via dWallet → borrow USDC → deploy capital → monitor privately → repay and repeat

---

## Persona 2: Market Maker

**Name:** Bob
**Role:** Liquidity Provider at an automated trading firm

### Background
- Runs automated strategies across CEXs and DEXs
- High volume, thin margins — information leakage materially impacts profitability
- Needs fast, programmatic access to liquidity
- Currently avoids on-chain lending because visible positions telegraph strategy

### Goal
Access on-demand liquidity without revealing inventory or strategy to the market.

### Pain Points
- **Visibility:** exposed borrow positions let competitors infer directional exposure
- **Fragmentation:** capital split across chains reduces efficiency
- **Latency:** bridging adds settlement delays that don't work for active strategies

### What Veil Enables
- Borrow on Solana using native BTC/ETH held off-chain
- Encrypted positions — inventory and strategy remain private
- High-frequency borrow-repay cycles with low compute overhead (Pinocchio)

### Workflow
Allocate reserves → borrow on demand via Solana → deploy in MM or arb → repay quickly → repeat

---

## Persona 3: DAO Treasury Manager

**Name:** Charlie
**Role:** Treasury Manager at a mid-size DAO

### Background
- Manages a treasury of BTC, ETH, and stablecoins
- Every major decision is subject to governance approval
- Risk-averse — any loss of principal or bridge failure is a governance crisis
- Wants to generate yield on idle holdings but can't justify bridge risk to token holders

### Goal
Unlock liquidity from idle treasury assets without adding systemic risk or requiring governance votes on every transaction.

### Pain Points
- **Bridge risk:** bridge failures are hard to explain to governance and communities
- **Transparency:** publicly visible positions expose the DAO's strategy and holdings
- **Underutilization:** large BTC/ETH holdings generate no yield while held in multisig

### What Veil Enables
- Native asset collateral removes bridge risk from the governance equation
- Private positions keep treasury strategy off-chain from public view
- Borrow against holdings to fund operations without selling the treasury

### Workflow
Treasury governance vote → deposit collateral (native) → borrow stablecoins → fund operations → repay over time

---

## Persona 4: Gold Holder / Family Office

**Name:** Diana
**Role:** Capital Allocator at a family office or private wealth firm

### Background
- Manages significant gold holdings (physical or gold-backed instruments)
- Uses gold as a long-term store of value and inflation hedge
- Has never been able to use gold productively in DeFi
- Comfortable with TradFi-grade custody but interested in yield on gold

### Goal
Make existing gold holdings productive without selling or increasing risk exposure.

### Pain Points
- **No DeFi access:** gold has never been usable as collateral in on-chain lending
- **Yield gap:** gold earns nothing while sitting in custody
- **Counterparty risk:** traditional gold lending involves significant counterparty exposure

### What Veil Enables
- Pledge physical gold via Oro/GRAIL as collateral — no bridging, Oro handles custody and compliance
- Borrow stablecoins against gold holdings at transparent, market-driven rates
- First time gold can be used as collateral in a DeFi protocol

### Workflow
Gold in custody (via Oro) → connect to Veil → pledge as collateral → borrow USDC → deploy yield strategies → repay

---

## Quick Contrast

| Persona | Primary Driver | What Veil Solves For |
|---|---|---|
| Alex (Fund Manager) | Custody + privacy + efficiency | Bridge risk + transparent positions |
| Bob (Market Maker) | Speed + opacity | Visible strategy + cross-chain friction |
| Charlie (DAO) | Risk management + governance | Bridge risk + idle treasury assets |
| Diana (Gold Holder) | Gold productivity | No DeFi access for gold collateral |

Same protocol. Four different reasons to care.
