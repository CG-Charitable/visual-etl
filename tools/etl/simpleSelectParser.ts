// Detects SQL simple enough to represent with native nodes (Source -> Filter
// -> Select -> Sort -> Limit) instead of an opaque Custom SQL node. Unlike
// sqlImportParser.ts (which only needs block boundaries), this actually
// parses the SELECT list and WHERE clause — but the grammar it accepts is
// deliberately narrow: one table, no JOIN, no DISTINCT, no expressions
// beyond a plain column (optionally aliased via explicit AS), a flat
// AND-only or OR-only WHERE (no mixing, no parens), optional ORDER BY /
// LIMIT. The moment anything doesn't fit, `tryParseSimpleSelect` returns
// null — never throws — so the caller can always fall back to a Custom SQL
// node with nothing lost.

export interface SimpleFilterCondition {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "IS NULL" | "IS NOT NULL" | "IN";
  value?: string | number | (string | number)[];
}

export type SimpleFrom = { schema: string; table: string } | { cteName: string };

export interface SimpleSelectPlan {
  from: SimpleFrom;
  selectAll: boolean;
  selectItems: { column: string; alias: string }[];
  filter: { conjunction: "AND" | "OR"; conditions: SimpleFilterCondition[] } | null;
  sort: { column: string; direction: "ASC" | "DESC" }[] | null;
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
type TokenType = "ident" | "string" | "number" | "punct" | "eof";
interface Token {
  type: TokenType;
  value: string;
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= n) return null;
      i += 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j++;
          closed = true;
          break;
        }
        out += text[j];
        j++;
      }
      if (!closed) return null;
      tokens.push({ type: "string", value: out });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < n) {
        if (text[j] === '"' && text[j + 1] === '"') {
          out += '"';
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          closed = true;
          break;
        }
        out += text[j];
        j++;
      }
      if (!closed) return null;
      tokens.push({ type: "ident", value: out });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(text[j])) j++;
      tokens.push({ type: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push({ type: "ident", value: text.slice(i, j) });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=") {
      tokens.push({ type: "punct", value: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }
    if ("(),.=<>*;".includes(c)) {
      tokens.push({ type: "punct", value: c });
      i++;
      continue;
    }
    return null; // unrecognized character — not a query this grammar understands
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

const KEYWORDS = new Set([
  "select",
  "distinct",
  "from",
  "where",
  "and",
  "or",
  "as",
  "order",
  "by",
  "asc",
  "desc",
  "limit",
  "is",
  "not",
  "null",
  "in",
  "like",
  // Not otherwise handled by this grammar, but excluded from ever being
  // mistaken for a bare (no-AS) alias, so a query using them fails cleanly
  // at the point they appear rather than via a confusing later mismatch.
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "union",
  "group",
  "having",
]);

class TokenCursor {
  pos = 0;
  constructor(private tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { type: "eof", value: "" };
  }

  atEnd(): boolean {
    return this.peek().type === "eof";
  }

  matchKeyword(word: string): boolean {
    const t = this.peek();
    if (t.type === "ident" && t.value.toLowerCase() === word) {
      this.pos++;
      return true;
    }
    return false;
  }

  matchPunct(p: string): boolean {
    const t = this.peek();
    if (t.type === "punct" && t.value === p) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** An identifier usable as a name (column/table/alias) — not a reserved keyword. */
  matchIdent(): string | null {
    const t = this.peek();
    if (t.type !== "ident" || KEYWORDS.has(t.value.toLowerCase())) return null;
    this.pos++;
    return t.value;
  }
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------
interface RawRef {
  qualifier: string | null;
  column: string;
}

function parseColumnRef(p: TokenCursor): RawRef | null {
  const first = p.matchIdent();
  if (!first) return null;
  if (p.matchPunct(".")) {
    const second = p.matchIdent();
    if (!second) return null;
    return { qualifier: first, column: second };
  }
  return { qualifier: null, column: first };
}

function parseLiteral(p: TokenCursor): string | number | undefined {
  const t = p.peek();
  if (t.type === "string") {
    p.pos++;
    return t.value;
  }
  if (t.type === "number") {
    p.pos++;
    return Number(t.value);
  }
  return undefined;
}

function parseOperator(p: TokenCursor): SimpleFilterCondition["operator"] | null {
  const t = p.peek();
  if (t.type === "punct" && ["=", "!=", "<", ">", "<=", ">="].includes(t.value)) {
    p.pos++;
    return t.value as SimpleFilterCondition["operator"];
  }
  if (p.matchKeyword("like")) return "LIKE";
  return null;
}

function parseCondition(p: TokenCursor): (RawRef & SimpleFilterCondition) | null {
  const ref = parseColumnRef(p);
  if (!ref) return null;

  if (p.matchKeyword("is")) {
    const negated = p.matchKeyword("not");
    if (!p.matchKeyword("null")) return null;
    return { ...ref, operator: negated ? "IS NOT NULL" : "IS NULL" };
  }
  if (p.matchKeyword("in")) {
    if (!p.matchPunct("(")) return null;
    const values: (string | number)[] = [];
    for (;;) {
      const lit = parseLiteral(p);
      if (lit === undefined) return null;
      values.push(lit);
      if (p.matchPunct(",")) continue;
      break;
    }
    if (!p.matchPunct(")")) return null;
    return { ...ref, operator: "IN", value: values };
  }
  const op = parseOperator(p);
  if (!op) return null;
  const lit = parseLiteral(p);
  if (lit === undefined) return null;
  if (op === "LIKE" && typeof lit !== "string") return null;
  return { ...ref, operator: op, value: lit };
}

function parseBoolExpr(
  p: TokenCursor,
): { conjunction: "AND" | "OR"; conditions: (RawRef & SimpleFilterCondition)[] } | null {
  const first = parseCondition(p);
  if (!first) return null;
  const conditions = [first];
  let conjunction: "AND" | "OR" | null = null;
  for (;;) {
    let next: "AND" | "OR" | null = null;
    if (p.matchKeyword("and")) next = "AND";
    else if (p.matchKeyword("or")) next = "OR";
    else break;
    if (conjunction === null) conjunction = next;
    else if (conjunction !== next) return null; // mixed AND/OR — too complicated, bail
    const cond = parseCondition(p);
    if (!cond) return null;
    conditions.push(cond);
  }
  return { conjunction: conjunction ?? "AND", conditions };
}

export function tryParseSimpleSelect(
  body: string,
  localCteNames: Set<string>,
): SimpleSelectPlan | null {
  const tokens = tokenize(body);
  if (!tokens) return null;
  const p = new TokenCursor(tokens);

  if (!p.matchKeyword("select")) return null;
  if (p.matchKeyword("distinct")) return null; // unsupported — no native DISTINCT node

  let selectAll = false;
  const rawItems: (RawRef & { alias: string })[] = [];
  if (p.matchPunct("*")) {
    selectAll = true;
  } else {
    for (;;) {
      const ref = parseColumnRef(p);
      if (!ref) return null;
      let alias = ref.column;
      if (p.matchKeyword("as")) {
        const a = p.matchIdent();
        if (!a) return null;
        alias = a;
      } else {
        // Bare alias with no AS (e.g. `"Value" conf_value`) — safe to
        // consume speculatively: the only things that can legally follow a
        // select item are a comma, FROM, or an alias, and matchIdent()
        // already refuses to eat a reserved keyword.
        const bare = p.matchIdent();
        if (bare) alias = bare;
      }
      rawItems.push({ ...ref, alias });
      if (p.matchPunct(",")) continue;
      break;
    }
  }

  if (!p.matchKeyword("from")) return null;
  const fromFirst = p.matchIdent();
  if (!fromFirst) return null;
  let fromSchema = "public";
  let fromTable = fromFirst;
  if (p.matchPunct(".")) {
    const second = p.matchIdent();
    if (!second) return null;
    fromSchema = fromFirst;
    fromTable = second;
  }
  let tableAlias: string | null = null;
  if (p.matchKeyword("as")) {
    const a = p.matchIdent();
    if (!a) return null;
    tableAlias = a;
  } else {
    // Bare alias with no AS (e.g. `FROM "Table" t`) — by far the more
    // common style in hand-written SQL. Same safety argument as above: the
    // only legal continuations here are WHERE/ORDER/LIMIT/EOF or an alias,
    // and reserved words (including JOIN and friends) are excluded.
    const bare = p.matchIdent();
    if (bare) tableAlias = bare;
  }

  let rawFilter: ReturnType<typeof parseBoolExpr> = null;
  if (p.matchKeyword("where")) {
    rawFilter = parseBoolExpr(p);
    if (!rawFilter) return null;
  }

  let rawSort: (RawRef & { direction: "ASC" | "DESC" })[] | null = null;
  if (p.matchKeyword("order")) {
    if (!p.matchKeyword("by")) return null;
    rawSort = [];
    for (;;) {
      const ref = parseColumnRef(p);
      if (!ref) return null;
      let direction: "ASC" | "DESC" = "ASC";
      if (p.matchKeyword("asc")) direction = "ASC";
      else if (p.matchKeyword("desc")) direction = "DESC";
      rawSort.push({ ...ref, direction });
      if (p.matchPunct(",")) continue;
      break;
    }
  }

  let limit: number | null = null;
  if (p.matchKeyword("limit")) {
    const t = p.peek();
    if (t.type !== "number") return null;
    p.pos++;
    limit = Number(t.value);
  }

  if (!p.atEnd()) return null; // trailing content this grammar doesn't understand

  // Every qualifier used anywhere must refer to the single table in scope
  // (or its alias) — a second qualifier would mean a join we didn't parse.
  const validQualifiers = new Set<string>([fromTable]);
  if (tableAlias) validQualifiers.add(tableAlias);
  const qualifierOk = (q: string | null) => q === null || validQualifiers.has(q);
  if (!selectAll && !rawItems.every((i) => qualifierOk(i.qualifier))) return null;
  if (rawFilter && !rawFilter.conditions.every((c) => qualifierOk(c.qualifier))) return null;
  if (rawSort && !rawSort.every((s) => qualifierOk(s.qualifier))) return null;

  const from: SimpleFrom =
    fromSchema === "public" && localCteNames.has(fromTable)
      ? { cteName: fromTable }
      : { schema: fromSchema, table: fromTable };

  return {
    from,
    selectAll,
    selectItems: rawItems.map((i) => ({ column: i.column, alias: i.alias })),
    filter: rawFilter
      ? {
          conjunction: rawFilter.conjunction,
          conditions: rawFilter.conditions.map((c) => ({
            column: c.column,
            operator: c.operator,
            value: c.value,
          })),
        }
      : null,
    sort: rawSort ? rawSort.map((s) => ({ column: s.column, direction: s.direction })) : null,
    limit,
  };
}
