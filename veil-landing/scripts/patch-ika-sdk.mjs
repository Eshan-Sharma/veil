#!/usr/bin/env node
/**
 * Strip `.js` extensions from import statements inside
 * `@ika.xyz/pre-alpha-solana-client` so Turbopack (Next 16+) can resolve
 * the .ts source files. The SDK ships TypeScript directly via package
 * `exports` and uses NodeNext-style `from "./foo.js"` imports, which
 * Turbopack does not auto-redirect to `./foo.ts` for transpiled packages.
 *
 * Idempotent — safe to re-run on every `npm install`.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(
  __dirname,
  "..",
  "node_modules",
  "@ika.xyz",
  "pre-alpha-solana-client",
);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".ts")) patchFile(p);
  }
}

function patchFile(file) {
  const src = readFileSync(file, "utf8");
  const next = src.replace(
    /from\s+['"](\.{1,2}\/[^'"]+?)\.js['"]/g,
    "from '$1'",
  );
  if (next !== src) writeFileSync(file, next);
}

try {
  walk(root);
} catch (err) {
  if (err && err.code === "ENOENT") {
    // Package not installed yet (e.g. fresh CI). Skip silently.
  } else {
    throw err;
  }
}
