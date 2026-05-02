import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const KEYPAIR_PATH = process.env.TEST_ADMIN_KEYPAIR ?? process.env.TEST_WALLET_KEYPAIR;
if (!KEYPAIR_PATH) {
  throw new Error("TEST_ADMIN_KEYPAIR env var not set (see .env.example)");
}
const SECRET: number[] = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"));

test.describe.configure({ mode: "serial" });

test("dapp deposit + cross-borrow flow", async ({ page }) => {
  // Inject the test wallet's secret BEFORE the app loads so TestWalletAdapter
  // sees readyState = Installed and the WalletProvider lists it as a choice.
  await page.addInitScript((secret) => {
    (window as unknown as { __VEIL_TEST_WALLET_SECRET__?: number[] }).__VEIL_TEST_WALLET_SECRET__ =
      secret;
  }, SECRET);

  // Surface every browser console message in the test log — invaluable for
  // diagnosing wallet-adapter race conditions or RPC errors.
  page.on("console", (msg) => console.log(`[browser:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log(`[browser:error]`, err.message));

  await page.goto("/dapp");

  // ─── Connect wallet ────────────────────────────────────────────────────────
  // The WalletMultiButton shows "Select Wallet" until a wallet is chosen.
  await page.getByRole("button", { name: /select wallet/i }).click();
  // Modal lists registered wallets; ours is "Veil Test Wallet".
  await page
    .locator(".wallet-adapter-modal-list button", { hasText: /veil test wallet/i })
    .click();
  // After connect, the trigger button text shows truncated pubkey "7QVK..".
  await expect(page.locator(".wallet-adapter-button-trigger")).toContainText("7QVK", {
    timeout: 15_000,
  });
  // Dismiss modal if it didn't auto-close (some adapter versions leave it open).
  const modalCloseBtn = page.locator(".wallet-adapter-modal-button-close");
  if (await modalCloseBtn.isVisible().catch(() => false)) {
    await modalCloseBtn.click();
  }

  // ─── Supply 100 USDC ──────────────────────────────────────────────────────
  // The Markets view renders pools as a <table>. Clicking a row opens a
  // PoolDetail panel that contains the actual Supply/Borrow trigger buttons.
  await page.getByRole("row", { name: /USDC/ }).click();
  await page.getByRole("button", { name: /^supply$/i }).click();

  // The action modal opens. Scope subsequent locators to .modal-card so they
  // don't collide with the still-rendered pool-detail panel underneath.
  const modal = page.locator(".modal-card");
  await modal.locator('input[placeholder="0.00"]').fill("100");
  // Confirm-button text is just "Supply" for non-ika pools (no symbol appended).
  await modal.getByRole("button", { name: /^supply$/i }).click();
  // Modal closes once the wallet adapter has built/signed/sent the tx.
  await expect(modal).toBeHidden({ timeout: 60_000 });

  // Tx settle — give the indexer a moment to update.
  await page.waitForTimeout(2_000);

  // ─── Cross-borrow 0.001 BTC ───────────────────────────────────────────────
  await page.getByRole("row", { name: /BTC/ }).click();
  await page.getByRole("button", { name: /^borrow$/i }).click();

  await modal.locator('input[placeholder="0.00"]').fill("0.001");
  // Confirm-button text for borrow IS suffixed with the symbol.
  await modal.getByRole("button", { name: /^borrow btc$/i }).click();
  await expect(modal).toBeHidden({ timeout: 60_000 });

  // ─── Portfolio shows position ─────────────────────────────────────────────
  await page.getByRole("button", { name: /^portfolio$/i }).click();
  // Position rows render the wallet pubkey + an HF readout. We just assert
  // SOMETHING USDC-related shows up under Portfolio.
  await expect(page.locator("text=USDC").first()).toBeVisible({ timeout: 15_000 });
});
