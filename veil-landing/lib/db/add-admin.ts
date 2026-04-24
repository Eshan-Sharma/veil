/* One-shot helper:  npm run db:add-admin -- <pubkey> [role] [label]
 * role defaults to "pool_admin". Idempotent.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "dotenv";

config({ path: join(process.cwd(), ".env.local") });
neonConfig.webSocketConstructor = ws;
void fileURLToPath; void dirname;

async function main() {
  const [pubkey, role = "pool_admin", label = null] = process.argv.slice(2);
  if (!pubkey) throw new Error("usage: add-admin <pubkey> [role] [label]");
  if (role !== "pool_admin" && role !== "super_admin") throw new Error(`bad role: ${role}`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const r = await client.query(
      `INSERT INTO pool_admins (pubkey, role, label, added_by)
       VALUES ($1, $2, $3, 'cli')
       ON CONFLICT (pubkey) DO UPDATE
         SET role = EXCLUDED.role,
             label = COALESCE(EXCLUDED.label, pool_admins.label),
             revoked_at = NULL
       RETURNING pubkey, role, label, created_at`,
      [pubkey, role, label],
    );
    console.log("[add-admin]", r.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
