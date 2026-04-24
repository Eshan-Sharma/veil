/* Run schema + seed. Usage:  npm run db:migrate
 * Idempotent — safe to re-run.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "dotenv";

config({ path: join(process.cwd(), ".env.local") });

neonConfig.webSocketConstructor = ws;

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
    // Run as a single multi-statement query — Neon Postgres accepts simple-query protocol.
    await client.query(schema);
    console.log("[migrate] schema applied");

    const superAdmin = process.env.SUPER_ADMIN_PUBKEY;
    if (superAdmin) {
      await client.query(
        `INSERT INTO pool_admins (pubkey, role, label, added_by)
         VALUES ($1, 'super_admin', 'bootstrap', 'system')
         ON CONFLICT (pubkey) DO UPDATE
           SET role = 'super_admin', revoked_at = NULL`,
        [superAdmin]
      );
      console.log(`[migrate] seeded super_admin: ${superAdmin}`);
    } else {
      console.warn("[migrate] SUPER_ADMIN_PUBKEY not set — skipping seed");
    }
    console.log("[migrate] done");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
