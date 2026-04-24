/* CI guard — fails the build if any NEXT_PUBLIC_* env var name suggests a
 * server-only secret (postgres URL, password, secret key). Catches the
 * regression where an engineer prefixes DATABASE_URL with NEXT_PUBLIC_ and
 * leaks the secret into the client bundle.
 *
 * Run as a prebuild step:  npm run check:env-leak
 *
 * The script also greps for `process.env.NEXT_PUBLIC_…` literal references
 * in the codebase that match suspicious patterns.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_SUBSTRINGS = ["postgres", "password", "secret", "private_key", "privatekey"];
const SCAN_DIRS = ["app", "lib", "scripts"];
const SCAN_EXTS = [".ts", ".tsx", ".js", ".mjs"];
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.production"];

function suspicious(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("next_public_") &&
    FORBIDDEN_SUBSTRINGS.some((s) => lower.includes(s));
}

function scanEnvFile(path: string): string[] {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return []; }
  const issues: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && suspicious(m[1])) {
      issues.push(`${path}: ${m[1]}`);
    }
  }
  return issues;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out);
    else if (SCAN_EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

function scanSource(): string[] {
  const issues: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const content = readFileSync(file, "utf8");
      const re = /process\.env\.([A-Z0-9_]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) != null) {
        if (suspicious(m[1])) {
          issues.push(`${file}: process.env.${m[1]}`);
        }
      }
    }
  }
  return issues;
}

function main() {
  const envIssues = ENV_FILES.flatMap(scanEnvFile);
  const srcIssues = scanSource();

  if (envIssues.length === 0 && srcIssues.length === 0) {
    console.log("[check-env-leak] ✓ no suspicious NEXT_PUBLIC_* names");
    return;
  }
  console.error("[check-env-leak] ✗ found NEXT_PUBLIC_* names that look like server secrets:");
  for (const i of envIssues) console.error("  env:", i);
  for (const i of srcIssues) console.error("  src:", i);
  console.error("\nIf this is intentional (it almost certainly isn't), rename the variable to drop the NEXT_PUBLIC_ prefix.");
  process.exit(1);
}
main();
