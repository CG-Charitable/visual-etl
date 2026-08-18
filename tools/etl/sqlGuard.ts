import { stripStringsAndComments } from "./sqlImportParser.ts";

// This tool is view/inspect-only — a Custom SQL node's body is spliced
// directly into a `WITH x AS (<body>)` clause, and Postgres allows
// data-modifying CTEs (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`),
// so we reject anything that isn't a plain read-only expression. This is a
// best-effort guard against careless/accidental pastes, not the app's sole
// security boundary — any authenticated user already has full CRUD via
// exposePrismaCRUD through other routes.
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CREATE",
  "COPY",
  "CALL",
  "DO",
  "EXECUTE",
  "VACUUM",
  "REINDEX",
  "MERGE",
  "LOCK",
];

export class SqlSafetyError extends Error {}

export function assertReadOnlySql(sql: string, context: string): void {
  const stripped = stripStringsAndComments(sql);
  if (stripped.includes(";")) {
    throw new SqlSafetyError(
      `${context}: contains a ";" — only a single read-only expression is allowed here`,
    );
  }
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(stripped)) {
      throw new SqlSafetyError(
        `${context}: contains "${keyword}", which isn't allowed — this tool is read-only (view/inspect only)`,
      );
    }
  }
}
