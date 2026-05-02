# Veil frontend e2e tests

Playwright tests that drive the dapp end-to-end on devnet using a hardcoded
test wallet (no manual signing). The browser opens visible (`--headed`) so a
human can watch each step run.

## Layout

```
frontend-e2e-tests/
├── playwright.config.ts        Test runner config (Chrome, slowMo, single worker)
├── specs/                      Test scenarios
│   ├── dapp.spec.ts            2-step smoke (connect + cross-borrow)
│   ├── user-flow.spec.ts       16-step user journey
│   └── admin-flow.spec.ts      13-step super_admin journey
├── helpers/
│   └── index.ts                Wallet inject, nav, submitAction, settle waits
├── setup/                      Devnet preflight scripts
│   ├── verify-devnet.ts        Sanity-check program + DB before tests
│   └── setup-frontend-test.ts  Fund test_user/victim, mint tokens, plant unhealthy
└── README.md
```

## Wallets used

| Role        | Pubkey                                          | Source                                          |
|-------------|-------------------------------------------------|-------------------------------------------------|
| `super_admin` | `7QVKqRRyicZQ74VwnmtctXgDnKvjuwRFr2cHVqDqA1Ua` | `/Users/eshan/my-solana-testing-dev-wallet.json` |
| `test_user`   | varies (regenerated)                          | `/tmp/test-user.json`                            |
| `victim`      | varies (regenerated)                          | `/tmp/test-victim.json`                          |

The dapp's `TestWalletAdapter` (in `app/dapp/lib/`) reads the secret from
`window.__VEIL_TEST_WALLET_SECRET__`, which the helpers inject via
`page.addInitScript` before the app loads. The adapter is gated behind
`NEXT_PUBLIC_TEST_WALLET=1` and refuses to register on mainnet.

## Running

```bash
# 1. (one-time per fresh DB) confirm devnet is in shape
npm run test:ui:verify

# 2. fund test wallets, mint test tokens, plant a liquidatable position
npm run test:ui:setup

# 3. drive the dapp
npm run test:ui
```

`test:ui` runs all three specs in serial. To run one:

```bash
npx playwright test --config frontend-e2e-tests/playwright.config.ts \
                    frontend-e2e-tests/specs/user-flow.spec.ts --headed
```

## Required env

In `.env.local` at the repo root:

- `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`
- `RPC_URL=https://api.devnet.solana.com`
- `CLUSTER=devnet`
- `NEXT_PUBLIC_VEIL_PROGRAM_ID=BAvY...`
- `DATABASE_URL=<dedicated devnet Neon project>`
- `SUPER_ADMIN_PUBKEY=7QVK...`
- `PAYER_KEYPAIR=/Users/eshan/my-solana-testing-dev-wallet.json`
- `NEXT_PUBLIC_TEST_WALLET=1`

## Known caveats

- **Step 13 (USDC encrypted borrow) can fail with `0x178c CrossCollateralActive`.**
  Once a position is in a cross-set, a new `cross_borrow` generates a fresh
  `set_id` that mismatches. Either insert a repay-BTC step before 13 or accept
  the documented failure.
- **Encrypted operations are plaintext on-chain.** The FHE toggle in the modal
  controls UI only; `useVeilActions` doesn't yet route `encPos` to the
  `private_*` instructions, so step 12/13 transactions are regular deposit/borrow.
