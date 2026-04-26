import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

type AuditRow = {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  details: unknown;
  created_at: string;
};

/** Public read of the admin audit log. Rows are not sensitive — actors and
 *  actions are recorded for transparency. Filterable by actor/action. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const actor = searchParams.get("actor");
  const action = searchParams.get("action");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 500);

  let rows: AuditRow[];
  if (actor && action) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE actor = ${actor} AND action = ${action}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else if (actor) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE actor = ${actor}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else if (action) {
    rows = await sql`
      SELECT * FROM audit_log
       WHERE action = ${action}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  } else {
    rows = await sql`
      SELECT * FROM audit_log
       ORDER BY created_at DESC
       LIMIT ${limit}
    ` as AuditRow[];
  }
  return NextResponse.json({ entries: rows });
}
