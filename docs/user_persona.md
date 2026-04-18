## Persona 1: Institutional Trader / Fund Manager  
**Name:** Alex  
**Role:** Portfolio Manager at a crypto hedge fund  

### Background  
- Manages $5M–$50M (mostly BTC, ETH)  
- TradFi background (equities/derivatives/FX)  
- Uses DeFi cautiously as infrastructure  

### Goal  
Maximize capital efficiency without compromising custody, privacy, or execution edge  

### Pain Points  
- **Bridge risk:** won’t wrap or trust bridges  
- **Transparency:** positions and liquidation levels are publicly visible  
- **Idle capital:** BTC/ETH underutilized due to cross-chain friction  

### Mental Model  
“Does this add trust assumptions or reduce control?”  
**Filters:** custody, privacy, liquidity, simplicity  

### What Veil Enables  
- Native BTC/ETH as collateral (no bridging)  
- Private positions (no public exposure)  
- Cross-chain capital efficiency via Solana  

### Workflow  
Hold BTC → deposit as collateral → borrow stablecoins → deploy (MM/arbitrage/yield) → monitor privately → repay/liquidate  

---

## Persona 2: Market Maker  
**Name:** Bob  
**Role:** Liquidity Provider at a trading firm  

### Background  
- Runs automated strategies across CEXs and DEXs  
- High volume, low margin  
- Sensitive to latency and information leakage  

### Goal  
Access fast liquidity without revealing inventory or strategy  

### Pain Points  
- **Visibility:** exposed positions reduce profitability  
- **Fragmentation:** capital split across chains  
- **Inefficiency:** idle collateral during active trading  

### What Veil Enables  
- Borrow on Solana using native BTC/ETH  
- Hide positions from competitors  
- Reduce cross-chain operational overhead  

### Workflow  
Hold reserves → borrow on demand → deploy in MM/arbitrage → repay quickly → repeat  

---

## Persona 3: DAO Treasury Manager  
**Name:** Charlie  
**Role:** Treasury Manager at a DAO  

### Background  
- Manages BTC, ETH, stablecoin treasury  
- Accountable to governance  
- Risk-averse, prefers conservative strategies  

### Goal  
Generate yield/liquidity without increasing systemic risk  

### Pain Points  
- **Bridges:** hard to justify risk to governance  
- **Transparency:** exposes strategy externally  
- **Idle assets:** large holdings sit unused  

### What Veil Enables  
- Use native assets without bridging  
- Keep positions private externally  
- Unlock liquidity without restructuring treasury  

### Workflow  
Treasury allocation → deposit collateral → borrow → deploy in low-risk strategies → monitor risk  

---

## Quick Contrast  

- **Alex (Fund Manager):** custody + secrecy + efficiency  
- **Bob (Market Maker):** speed + secrecy + liquidity  
- **Charlie (DAO):** risk + governance + utilization  

Same product, three different reasons to care.
