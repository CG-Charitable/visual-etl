// Detects a SQL shape like `SELECT <list> FROM t1 JOIN t2 ON ... JOIN t3 ON
// ... [WHERE ...] [ORDER BY ...] [LIMIT ...]` so the importer can decompose
// it into a chain of native Join nodes instead of one opaque box — same
// "narrow grammar, bail to null on anything unexpected" spirit as
// simpleSelectParser.ts, extended to multiple tables. Unlike
// simpleSelectParser.ts, a bare/unqualified column is never valid here
// (ambiguous with 2+ tables in scope) — every reference must be
// `alias.column`.
//
// The SELECT list is treated differently from the rest: WHERE/ORDER BY/JOIN
// conditions must be fully understood by this parser or the whole attempt
// bails (there's nowhere else for them to go), but a SELECT item that isn't
// a plain `alias.column` (a CASE expression, a function call, ...) doesn't
// bail anything — it just means `selectItems` comes back null and the
// caller falls back to keeping the ENTIRE select list as one small
// unparsed text span (`rawSelectListText`), verbatim except for
// `alias.column` substitution (see `rewriteQualifiedColumns`) once the join
// chain has been turned into native nodes and each alias's columns have
// been renamed by the compiler's own left_/right_ prefixing.

import { Scanner } from "./sqlImportParser.ts";

export type JoinChainFrom = { schema: string; table: string } | { cteName: string };

export interface JoinChainCondition {
  leftAlias: string;
  leftCol: string;
  rightCol: string;
}

export type JoinChainType = "INNER" | "LEFT" | "RIGHT" | "FULL";

export interface JoinChainStep {
  from: JoinChainFrom;
  alias: string;
  type: JoinChainType;
  conditions: JoinChainCondition[];
}

export type JoinChainOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "LIKE"
  | "IS NULL"
  | "IS NOT NULL"
  | "IN";

export interface JoinChainFilterCondition {
  qualifier: string;
  column: string;
  operator: JoinChainOperator;
  value?: string | number | (string | number)[];
}

export interface JoinChainSortField {
  qualifier: string;
  column: string;
  direction: "ASC" | "DESC";
}

export interface JoinChainSelectItem {
  qualifier: string;
  column: string;
  alias: string;
}

export interface JoinChainPlan {
  base: { from: JoinChainFrom; alias: string };
  joins: JoinChainStep[];
  filter: { conjunction: "AND" | "OR"; conditions: JoinChainFilterCondition[] } | null;
  sort: JoinChainSortField[] | null;
  limit: number | null;
  selectItems: JoinChainSelectItem[] | null;
  rawSelectListText: string;
  /**
   * Per top-level select-list item (same order/length as the item split
   * used for `selectItems`), whether that item's raw text is exactly the
   * bare word `NULL` — an untyped literal whose real type SQL only resolves
   * once it sees the *other* branches of the union it's part of. Compiling
   * each branch as its own standalone chain (so it stays independently
   * inspectable) means that context is gone by the time this branch's
   * columns get described, and Postgres defaults an isolated bare NULL to
   * `text` — which then conflicts with a real numeric/etc column at the
   * same position in another branch. The importer uses this to emit a
   * genuine untyped `NULL` directly in the union's own SQL for that
   * position instead of routing it through a concretely-typed column.
   */
  nullLiteralPositions: boolean[];
}

const RESERVED = new Set([
  "select", "distinct", "from", "where", "and", "or", "as", "order", "by",
  "asc", "desc", "limit", "is", "not", "null", "in", "like", "join", "inner",
  "left", "right", "full", "outer", "cross", "using", "lateral", "union",
  "group", "having", "on",
]);

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function matchIdent(s: Scanner): string | null {
  const save = s.pos;
  const id = s.scanIdentifier();
  if (id === null) return null;
  if (RESERVED.has(id.toLowerCase())) {
    s.pos = save;
    return null;
  }
  return id;
}

function matchPunct(s: Scanner, ch: string): boolean {
  const save = s.pos;
  s.skipTrivia();
  if (s.peek() === ch) {
    s.pos++;
    return true;
  }
  s.pos = save;
  return false;
}

function matchOperator(s: Scanner): string | null {
  const save = s.pos;
  s.skipTrivia();
  const two = s.text.slice(s.pos, s.pos + 2);
  if (two === "<=" || two === ">=" || two === "<>" || two === "!=") {
    s.pos += 2;
    return two === "<>" ? "!=" : two;
  }
  const one = s.peek();
  if (one === "=" || one === "<" || one === ">") {
    s.pos += 1;
    return one;
  }
  s.pos = save;
  return null;
}

function matchNumber(s: Scanner): number | null {
  const save = s.pos;
  s.skipTrivia();
  const m = /^[0-9]+(\.[0-9]+)?/.exec(s.text.slice(s.pos));
  if (!m) {
    s.pos = save;
    return null;
  }
  s.pos += m[0].length;
  return Number(m[0]);
}

function matchStringLiteral(s: Scanner): string | null {
  const save = s.pos;
  s.skipTrivia();
  if (s.peek() !== "'") {
    s.pos = save;
    return null;
  }
  let pos = s.pos + 1;
  let out = "";
  while (pos < s.text.length) {
    if (s.text[pos] === "'" && s.text[pos + 1] === "'") {
      out += "'";
      pos += 2;
      continue;
    }
    if (s.text[pos] === "'") {
      s.pos = pos + 1;
      return out;
    }
    out += s.text[pos];
    pos++;
  }
  s.pos = save;
  return null; // unterminated — bail via null rather than throwing
}

function matchLiteral(s: Scanner): string | number | null {
  const str = matchStringLiteral(s);
  if (str !== null) return str;
  return matchNumber(s);
}

/** A required `alias.column` reference — a bare/unqualified name never matches here. */
function parseQualifiedRef(s: Scanner): { qualifier: string; column: string } | null {
  const save = s.pos;
  const first = matchIdent(s);
  if (!first) return null;
  if (!matchPunct(s, ".")) {
    s.pos = save;
    return null;
  }
  const second = matchIdent(s);
  if (!second) {
    s.pos = save;
    return null;
  }
  return { qualifier: first, column: second };
}

function parseFilterCondition(s: Scanner): JoinChainFilterCondition | null {
  const ref = parseQualifiedRef(s);
  if (!ref) return null;
  if (s.matchKeyword("IS")) {
    const negated = s.matchKeyword("NOT");
    if (!s.matchKeyword("NULL")) return null;
    return { ...ref, operator: negated ? "IS NOT NULL" : "IS NULL" };
  }
  if (s.matchKeyword("IN")) {
    if (!matchPunct(s, "(")) return null;
    const values: (string | number)[] = [];
    for (;;) {
      const lit = matchLiteral(s);
      if (lit === null) return null;
      values.push(lit);
      if (matchPunct(s, ",")) continue;
      break;
    }
    if (!matchPunct(s, ")")) return null;
    return { ...ref, operator: "IN", value: values };
  }
  if (s.matchKeyword("LIKE")) {
    const lit = matchStringLiteral(s);
    if (lit === null) return null;
    return { ...ref, operator: "LIKE", value: lit };
  }
  const op = matchOperator(s);
  if (!op) return null;
  const lit = matchLiteral(s);
  if (lit === null) return null;
  return { ...ref, operator: op as JoinChainOperator, value: lit };
}

/** A flat AND-only or OR-only chain — no mixing, no parens, same restriction as simpleSelectParser.ts. */
function parseBoolExpr(
  s: Scanner,
): { conjunction: "AND" | "OR"; conditions: JoinChainFilterCondition[] } | null {
  const first = parseFilterCondition(s);
  if (!first) return null;
  const conditions = [first];
  let conjunction: "AND" | "OR" | null = null;
  for (;;) {
    let next: "AND" | "OR" | null = null;
    if (s.matchKeyword("AND")) next = "AND";
    else if (s.matchKeyword("OR")) next = "OR";
    else break;
    if (conjunction === null) conjunction = next;
    else if (conjunction !== next) return null;
    const cond = parseFilterCondition(s);
    if (!cond) return null;
    conditions.push(cond);
  }
  return { conjunction: conjunction ?? "AND", conditions };
}

/** Only flat `alias.col = alias.col` equalities, ANDed — no OR, no expressions, no USING. */
function parseOnConditions(
  s: Scanner,
  knownAliases: Set<string>,
  newAlias: string,
): JoinChainCondition[] | null {
  const conditions: JoinChainCondition[] = [];
  for (;;) {
    const left = parseQualifiedRef(s);
    if (!left) return null;
    if (!matchPunct(s, "=")) return null;
    const right = parseQualifiedRef(s);
    if (!right) return null;

    let leftAlias: string, leftCol: string, rightCol: string;
    if (left.qualifier === newAlias && knownAliases.has(right.qualifier)) {
      leftAlias = right.qualifier;
      leftCol = right.column;
      rightCol = left.column;
    } else if (right.qualifier === newAlias && knownAliases.has(left.qualifier)) {
      leftAlias = left.qualifier;
      leftCol = left.column;
      rightCol = right.column;
    } else {
      return null; // both new, both old, or an unknown alias — not a valid incremental join condition
    }
    conditions.push({ leftAlias, leftCol, rightCol });
    if (s.matchKeyword("AND")) continue;
    break;
  }
  return conditions;
}

function parseTableRef(
  s: Scanner,
  localCteNames: Set<string>,
): { from: JoinChainFrom; alias: string } | null {
  const first = matchIdent(s);
  if (!first) return null;
  let schema = "public";
  let table = first;
  const save = s.pos;
  if (matchPunct(s, ".")) {
    const second = matchIdent(s);
    if (second) {
      schema = first;
      table = second;
    } else {
      s.pos = save;
    }
  }
  let alias: string | null = null;
  if (s.matchKeyword("AS")) {
    alias = matchIdent(s);
    if (!alias) return null;
  } else {
    alias = matchIdent(s);
  }
  const from: JoinChainFrom =
    schema === "public" && localCteNames.has(table) ? { cteName: table } : { schema, table };
  return { from, alias: alias ?? table };
}

/** Splits `text` at top-level (paren-depth-0) commas — used for the select list. */
function splitTopLevelCommas(text: string): string[] {
  const s = new Scanner(text);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    const c = s.peek();
    if (c === "(") {
      depth++;
      s.pos++;
      continue;
    }
    if (c === ")") {
      depth--;
      s.pos++;
      continue;
    }
    if (c === "," && depth === 0) {
      items.push(text.slice(start, s.pos).trim());
      s.pos++;
      start = s.pos;
      continue;
    }
    s.pos++;
  }
  items.push(text.slice(start).trim());
  return items;
}

/** Whether one select-list item is exactly `alias.column [[AS] alias]` — nothing more. */
function tryParseSimpleSelectItem(text: string): JoinChainSelectItem | null {
  const s = new Scanner(text);
  const ref = parseQualifiedRef(s);
  if (!ref) return null;
  let alias = ref.column;
  if (s.matchKeyword("AS")) {
    const a = matchIdent(s);
    if (!a) return null;
    alias = a;
  } else {
    const bare = matchIdent(s);
    if (bare) alias = bare;
  }
  s.skipTrivia();
  if (!s.eof()) return null;
  return { qualifier: ref.qualifier, column: ref.column, alias };
}

/**
 * For any `SELECT <list> FROM ...` shaped query (regardless of what the
 * FROM/WHERE/etc. actually contain, or whether the rest of the shape is
 * otherwise supported), finds which top-level select-list items are
 * exactly the bare word `NULL`. Returns null if the query doesn't even
 * have this basic shape (no `SELECT`, `SELECT *`, or no top-level `FROM`).
 *
 * Used for a union branch (whether native-mapped or left fully opaque)
 * whose real columns get probed/described in isolation as part of
 * decomposing the union into independently-inspectable pieces: a bare
 * untyped `NULL` normally gets its real type resolved by seeing every
 * union branch together in one statement, and describing this branch on
 * its own loses that context (Postgres defaults an isolated bare NULL to
 * `text`) — silently turning a harmless untyped placeholder into a type
 * that conflicts with a real column at the same position in another
 * branch. Flagging it here lets the importer emit a genuine untyped NULL
 * directly in the union's own SQL for that position instead.
 */
export function findNullLiteralSelectItems(body: string): boolean[] | null {
  const s = new Scanner(body);
  if (!s.matchKeyword("SELECT")) return null;
  s.matchKeyword("DISTINCT");
  if (matchPunct(s, "*")) return null;

  const selectListStart = s.pos;
  let depth = 0;
  let fromKeywordStart = -1;
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    const c = s.peek();
    if (c === "(") {
      depth++;
      s.pos++;
      continue;
    }
    if (c === ")") {
      depth--;
      s.pos++;
      continue;
    }
    if (depth === 0) {
      const before = s.pos;
      if (s.matchKeyword("FROM")) {
        fromKeywordStart = before;
        break;
      }
    }
    s.pos++;
  }
  if (fromKeywordStart === -1) return null;
  const rawSelectListText = body.slice(selectListStart, fromKeywordStart).trim();
  if (!rawSelectListText) return null;

  return splitTopLevelCommas(rawSelectListText).map((t) => /^null$/i.test(t.trim()));
}

export function tryParseJoinChain(body: string, localCteNames: Set<string>): JoinChainPlan | null {
  const s = new Scanner(body);
  if (!s.matchKeyword("SELECT")) return null;
  if (s.matchKeyword("DISTINCT")) return null;
  if (matchPunct(s, "*")) return null; // SELECT * — can't attribute columns to a table without a catalog lookup

  const selectListStart = s.pos;
  let depth = 0;
  let fromKeywordStart = -1;
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    const c = s.peek();
    if (c === "(") {
      depth++;
      s.pos++;
      continue;
    }
    if (c === ")") {
      depth--;
      s.pos++;
      continue;
    }
    if (depth === 0) {
      const before = s.pos;
      if (s.matchKeyword("FROM")) {
        fromKeywordStart = before;
        break;
      }
    }
    s.pos++;
  }
  if (fromKeywordStart === -1) return null;
  const rawSelectListText = body.slice(selectListStart, fromKeywordStart).trim();
  if (!rawSelectListText) return null;

  const itemTexts = splitTopLevelCommas(rawSelectListText);
  const nullLiteralPositions = itemTexts.map((t) => /^null$/i.test(t.trim()));
  const parsedItems = itemTexts.map(tryParseSimpleSelectItem);
  let selectItems: JoinChainSelectItem[] | null = parsedItems.every((i) => i !== null)
    ? (parsedItems as JoinChainSelectItem[])
    : null;

  const baseRef = parseTableRef(s, localCteNames);
  if (!baseRef) return null;
  const knownAliases = new Set<string>([baseRef.alias]);
  const joins: JoinChainStep[] = [];

  for (;;) {
    const save = s.pos;
    let joinType: JoinChainType = "INNER";
    if (s.matchKeyword("INNER")) {
      joinType = "INNER";
    } else if (s.matchKeyword("LEFT")) {
      joinType = "LEFT";
      s.matchKeyword("OUTER");
    } else if (s.matchKeyword("RIGHT")) {
      joinType = "RIGHT";
      s.matchKeyword("OUTER");
    } else if (s.matchKeyword("FULL")) {
      joinType = "FULL";
      s.matchKeyword("OUTER");
    } else if (s.matchKeyword("CROSS")) {
      return null; // CROSS JOIN / comma joins unsupported
    }
    if (!s.matchKeyword("JOIN")) {
      s.pos = save;
      break;
    }
    s.skipTrivia();
    if (s.matchKeyword("LATERAL") || s.peek() === "(") return null; // subquery/LATERAL join — bail

    const joinRef = parseTableRef(s, localCteNames);
    if (!joinRef) return null;
    if (knownAliases.has(joinRef.alias)) return null; // duplicate alias — ambiguous

    if (s.matchKeyword("USING")) return null; // USING(...) unsupported
    if (!s.matchKeyword("ON")) return null;
    const conditions = parseOnConditions(s, knownAliases, joinRef.alias);
    if (!conditions || conditions.length === 0) return null;

    knownAliases.add(joinRef.alias);
    joins.push({ from: joinRef.from, alias: joinRef.alias, type: joinType, conditions });
  }

  if (joins.length === 0) return null; // no actual JOIN — let the caller try tryParseSimpleSelect/opaque instead

  let filter: JoinChainPlan["filter"] = null;
  if (s.matchKeyword("WHERE")) {
    const expr = parseBoolExpr(s);
    if (!expr) return null;
    if (!expr.conditions.every((c) => knownAliases.has(c.qualifier))) return null;
    filter = expr;
  }

  let sort: JoinChainSortField[] | null = null;
  if (s.matchKeyword("ORDER")) {
    if (!s.matchKeyword("BY")) return null;
    sort = [];
    for (;;) {
      const ref = parseQualifiedRef(s);
      if (!ref || !knownAliases.has(ref.qualifier)) return null;
      let direction: "ASC" | "DESC" = "ASC";
      if (s.matchKeyword("ASC")) direction = "ASC";
      else if (s.matchKeyword("DESC")) direction = "DESC";
      sort.push({ qualifier: ref.qualifier, column: ref.column, direction });
      if (matchPunct(s, ",")) continue;
      break;
    }
  }

  let limit: number | null = null;
  if (s.matchKeyword("LIMIT")) {
    const n = matchNumber(s);
    if (n === null) return null;
    limit = n;
  }

  s.skipTrivia();
  if (!s.eof()) return null; // trailing content this grammar doesn't understand (GROUP BY/HAVING/window functions/...)

  // A select-list item that cleanly parsed as `alias.column` but whose
  // alias isn't actually one of this chain's own tables can't safely be
  // used as a structured mapping (nor can we tell what it means) — fall
  // back to the raw-text path for the WHOLE list rather than guess.
  if (selectItems && !selectItems.every((i) => knownAliases.has(i.qualifier))) {
    selectItems = null;
  }

  return { base: baseRef, joins, filter, sort, limit, selectItems, rawSelectListText, nullLiteralPositions };
}

/**
 * Replaces every recognizable `alias.column` occurrence in `text` — found
 * via the same string/comment-shielded scanning used elsewhere in this
 * importer, so nothing inside a string literal or comment is ever touched —
 * with whatever `resolve` maps it to (the tracked *current* output name for
 * that alias/column on the native join chain that replaced the original
 * FROM/JOIN clause). An occurrence `resolve` doesn't recognize (its
 * qualifier isn't a known alias, or resolves to null) is left completely
 * untouched — usually harmless (a function call, a type name, an
 * unqualified identifier), and on the rare case it truly was a reference
 * this grammar failed to attribute, it fails loudly at compile/run time
 * (a clear Postgres "missing FROM-clause entry" error) rather than
 * silently producing a wrong result.
 */
export function rewriteQualifiedColumns(
  text: string,
  resolve: (alias: string, column: string) => string | null,
  resolveStar?: (alias: string) => string[] | null,
): string {
  const s = new Scanner(text);
  let out = "";
  let lastEnd = 0;
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    const c = s.peek();
    if (c === '"' || /[A-Za-z_]/.test(c)) {
      const identStart = s.pos;
      const ident = s.scanIdentifier();
      if (ident === null) {
        s.pos++;
        continue;
      }
      const afterIdent = s.pos;
      let replaced = false;
      if (matchPunct(s, ".")) {
        // A qualified wildcard (`alias.*`, e.g. `SELECT ca.*, other_expr
        // FROM ...`) isn't a single qualifier.column pair — it expands to
        // every column that alias currently has, in the same order Postgres
        // itself would enumerate them.
        if (s.peek() === "*" && resolveStar) {
          const cols = resolveStar(ident);
          if (cols !== null) {
            out += text.slice(lastEnd, identStart);
            out += cols.map(quoteIdent).join(", ");
            s.pos++; // consume the '*'
            lastEnd = s.pos;
            replaced = true;
          }
        } else {
          const col = s.scanIdentifier();
          if (col !== null) {
            const replacement = resolve(ident, col);
            if (replacement !== null) {
              out += text.slice(lastEnd, identStart);
              out += quoteIdent(replacement);
              lastEnd = s.pos;
              replaced = true;
            }
          }
        }
      }
      if (!replaced) s.pos = afterIdent;
      continue;
    }
    s.pos++;
  }
  out += text.slice(lastEnd);
  return out;
}
