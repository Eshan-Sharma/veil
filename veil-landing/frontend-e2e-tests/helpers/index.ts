import { Page, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

export function loadKeypairSecret(path: string): number[] {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Inject the wallet secret BEFORE navigation so TestWalletAdapter sees it on construct. */
export async function injectWallet(page: Page, secret: number[]) {
  await page.addInitScript((s) => {
    (window as unknown as { __VEIL_TEST_WALLET_SECRET__?: number[] }).__VEIL_TEST_WALLET_SECRET__ = s;
  }, secret);
}

/** Stream browser console + page errors into the test log. */
export function pipeBrowserLogs(page: Page) {
  page.on("console", (msg) => console.log(`[browser:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log(`[browser:error]`, err.message));
}

/** Click "Select Wallet" and choose the Veil Test Wallet. Resolves once trigger shows pubkey. */
export async function connectTestWallet(page: Page, expectedPubkeyStart: string) {
  await page.getByRole("button", { name: /select wallet/i }).click();
  await page.locator(".wallet-adapter-modal-list button", { hasText: /veil test wallet/i }).click();
  await expect(page.locator(".wallet-adapter-button-trigger")).toContainText(expectedPubkeyStart, {
    timeout: 15_000,
  });
  // Dismiss the wallet modal if it lingers (newer adapter versions auto-close).
  const close = page.locator(".wallet-adapter-modal-button-close");
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** Click a top-tab in the dapp navbar. */
export async function nav(page: Page, label: "Markets" | "Portfolio" | "Flash" | "Liquidate" | "History") {
  await page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).click();
}

/** Open a pool's detail by clicking its row in the Markets table. */
export async function openPoolRow(page: Page, symbol: string) {
  await page.getByRole("row", { name: new RegExp(symbol) }).click();
}

/**
 * Drive an action modal: opens the right modal from the pool detail panel,
 * fills the amount, optionally toggles FHE, and clicks the confirm button.
 * Caller awaits the on-chain effect (modal close, position update).
 */
export async function submitAction(
  page: Page,
  opts: {
    type: "supply" | "borrow" | "withdraw" | "repay";
    amount: string;
    encrypted?: boolean;
    /** Confirm-button text that appears in the action modal. */
    confirmText: RegExp;
  },
) {
  // Pool-detail panel button to open the modal.
  const triggerName: Record<typeof opts["type"], RegExp> = {
    supply: /^supply$/i,
    borrow: /^borrow$/i,
    withdraw: /^withdraw$/i,
    repay: /^repay$/i,
  };
  await page.getByRole("button", { name: triggerName[opts.type] }).click();
  const modal = page.locator(".modal-card");
  await modal.locator('input[placeholder="0.00"]').fill(opts.amount);
  if (opts.encrypted) {
    // Toggle "Encrypt position (FHE)" — only visible on enc-typed pools.
    await modal.getByText(/encrypt position/i).click();
  }
  await modal.getByRole("button", { name: opts.confirmText }).click();
}

/**
 * Wait for the action to settle on-chain + DB-sync to land + dapp to refresh
 * its userCollateralPools cache. Without this the next action sees stale
 * state and may pick the wrong instruction (e.g. single-pool borrow when
 * cross_borrow is required).
 *
 *  - success path: a green toast with "Confirmed" or the explorer link appears
 *  - failure path: a red toast with the friendly error message appears
 *  - in either case we then sleep 1.5s for the userCollateralPools refetch
 */
export async function waitForActionSettled(page: Page, opts?: { timeout?: number }) {
  const timeout = opts?.timeout ?? 60_000;
  const successToast = page.getByText(/confirmed|view tx|✓/i).first();
  const errorToast = page.getByText(/error|failed|wallet rejected/i).first();
  await Promise.race([
    successToast.waitFor({ state: "visible", timeout }).catch(() => null),
    errorToast.waitFor({ state: "visible", timeout }).catch(() => null),
  ]);
  // Give the dapp's portfolio refetch a beat to land.
  await page.waitForTimeout(2_000);
}
