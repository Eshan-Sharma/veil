import { WAD } from "@/lib/veil/constants";

// ─── WAD conversions ────────────────────────────────────────────────────────

export function wadToPctNum(v: bigint | null): number {
  if (!v) return 0;

  return Number((v * 10000n) / WAD) / 100;
}

export function wadToPctStr(v: bigint | null): string {
  if (!v) return "—";

  return `${wadToPctNum(v)}%`;
}

// ─── Token formatting ───────────────────────────────────────────────────────

export function numberWithCommas(x: number, dp?: number): string {
  const s = dp !== undefined ? x.toFixed(dp) : x.toString();
  const [int, dec] = s.split(".");
  const formatted = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return dec ? `${formatted}.${dec}` : formatted;
}

export function formatBigAmount(v: bigint, decimals = 9): string {
  if (v === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = v / divisor;
  const frac = v % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  if (whole > 1_000_000n) return `${numberWithCommas(Number(whole) / 1_000_000, 2)}M`;
  if (whole > 1_000n) return `${numberWithCommas(Number(whole) / 1_000, 1)}K`;
  if (whole > 0n) return `${numberWithCommas(Number(whole))}.${fracStr.slice(0, 2)}`;

  return `0.${fracStr.slice(0, 4)}`;
}

export function formatTokenAmount(v: bigint, decimals: number, symbol: string): string {
  return `${formatBigAmount(v, decimals)} ${symbol}`;
}

export function formatBigInt(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ─── Fees formatting ────────────────────────────────────────────────────────

export function formatFees(raw: string, decimals: number): string {
  const v = BigInt(raw);
  if (v === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = v / divisor;
  const frac = v % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);

  return `${numberWithCommas(Number(whole))}.${fracStr}`;
}

// ─── Address formatting ─────────────────────────────────────────────────────

export function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;

  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// ─── Health factor ──────────────────────────────────────────────────────────

type HFTone = "ok" | "warn" | "err" | "muted";

export function formatHF(raw: string | null): { label: string; tone: HFTone } {
  if (!raw) return { label: "—", tone: "muted" };
  const v = BigInt(raw);
  if (v >= 1n << 100n) return { label: "∞", tone: "ok" };
  const whole = v / WAD;
  const frac = ((v % WAD) * 100n) / WAD;
  const display = `${whole}.${String(frac).padStart(2, "0")}`;
  const tone: HFTone = v < WAD ? "err" : v < (WAD * 12n) / 10n ? "warn" : "ok";

  return { label: display, tone };
}

export function estimateHF(deposits: bigint, borrows: bigint, liqThreshold: bigint): number {
  if (borrows === 0n) return 999;

  return Number((deposits * liqThreshold) / borrows) / Number(WAD);
}
