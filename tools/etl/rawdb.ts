// A small dedicated connection pool used only to introspect a Custom SQL
// node's output columns (Prisma's $queryRawUnsafe doesn't surface
// driver-level field metadata the way `pg`'s own query results do).
// Postgres-only, matching the rest of this ETL feature.

let pool: import("pg").Pool | null = null;
let unavailableReason: string | null = null;

async function getPool(): Promise<import("pg").Pool | null> {
  if (pool || unavailableReason) return pool;
  const dbUrl = new URL(process.env.DATABASE_URL!);
  const scheme = dbUrl.protocol.replace(":", "");
  if (scheme !== "postgres" && scheme !== "postgresql") {
    unavailableReason = `Custom SQL column detection requires Postgres (found "${scheme}")`;
    return null;
  }
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

/**
 * Runs `sql` (expected to be a full, executable SELECT — including any
 * leading WITH clause the caller has already assembled) with a forced
 * `LIMIT 0` and returns the output column names, in order. Postgres reports
 * result field metadata even for a zero-row result, so this is cheap and
 * exact — no guessing from returned row shapes.
 *
 * `values` must be supplied whenever `sql` contains `$1`/`$2`/... — e.g. a
 * native Filter node compiled earlier in the same query — since Postgres
 * rejects a parameterized query with no bound values ("there is no
 * parameter $1"), even for a LIMIT 0 probe.
 */
export async function describeColumns(sql: string, values: unknown[] = []): Promise<string[]> {
  const p = await getPool();
  if (!p) throw new Error(unavailableReason!);
  const result = await p.query(`${sql} LIMIT 0`, values);
  return result.fields.map((f) => f.name);
}
