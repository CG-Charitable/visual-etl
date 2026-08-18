// Boundary scanner for importing a hand-written SQL view into the ETL graph.
//
// This is explicitly NOT a SQL parser — it never interprets what's inside a
// CTE body. It only needs to know: where does each `name AS ( ... )` block
// start and end, and which sibling CTE names does its text mention. Treating
// the body as opaque (and never rewriting it) is what lets the compiler
// splice it back in byte-for-byte and get identical query results.

export interface TableRef {
  schema: string;
  table: string;
}

export interface ParsedCte {
  name: string;
  body: string;
  dependsOn: string[];
  tableRefs: TableRef[];
}

export interface ParsedSql {
  ctes: ParsedCte[];
  mainQuery: { body: string; dependsOn: string[]; tableRefs: TableRef[] };
}

export class SqlParseError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(`${message} (at character ${position})`);
    this.position = position;
  }
}

const WHITESPACE = /\s/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;

class Scanner {
  pos: number;
  constructor(
    public text: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }
  eof(): boolean {
    return this.pos >= this.text.length;
  }

  /**
   * If a string literal / quoted identifier / line comment / block comment /
   * dollar-quoted string starts at the current position, consume it
   * entirely and return true. Otherwise leave the position untouched and
   * return false, so the caller can handle the character itself.
   */
  consumeNonStructural(): boolean {
    const c = this.peek();
    if (c === "'") {
      this.pos++;
      while (!this.eof()) {
        if (this.peek() === "'" && this.peek(1) === "'") {
          this.pos += 2;
          continue;
        }
        if (this.peek() === "'") {
          this.pos++;
          return true;
        }
        this.pos++;
      }
      throw new SqlParseError("Unterminated string literal", this.pos);
    }
    if (c === '"') {
      this.pos++;
      while (!this.eof()) {
        if (this.peek() === '"' && this.peek(1) === '"') {
          this.pos += 2;
          continue;
        }
        if (this.peek() === '"') {
          this.pos++;
          return true;
        }
        this.pos++;
      }
      throw new SqlParseError("Unterminated quoted identifier", this.pos);
    }
    if (c === "-" && this.peek(1) === "-") {
      this.pos += 2;
      while (!this.eof() && this.peek() !== "\n") this.pos++;
      return true;
    }
    if (c === "/" && this.peek(1) === "*") {
      this.pos += 2;
      let depth = 1;
      while (!this.eof() && depth > 0) {
        if (this.peek() === "/" && this.peek(1) === "*") {
          depth++;
          this.pos += 2;
        } else if (this.peek() === "*" && this.peek(1) === "/") {
          depth--;
          this.pos += 2;
        } else {
          this.pos++;
        }
      }
      return true;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(this.text.slice(this.pos));
      if (m) {
        const tag = m[0];
        this.pos += tag.length;
        const end = this.text.indexOf(tag, this.pos);
        if (end === -1) {
          throw new SqlParseError("Unterminated dollar-quoted string", this.pos);
        }
        this.pos = end + tag.length;
        return true;
      }
    }
    return false;
  }

  skipTrivia(): void {
    for (;;) {
      if (WHITESPACE.test(this.peek())) {
        this.pos++;
        continue;
      }
      if (
        (this.peek() === "-" && this.peek(1) === "-") ||
        (this.peek() === "/" && this.peek(1) === "*")
      ) {
        this.consumeNonStructural();
        continue;
      }
      break;
    }
  }

  /** Case-insensitive whole-word keyword match at the current position. */
  /**
   * Case-insensitive whole-word keyword match at the current position (after
   * skipping trivia). On failure, restores `pos` to exactly where it was —
   * safe to call speculatively (e.g. `matchKeyword("FROM") ||
   * matchKeyword("JOIN")` at every position in a scanning loop) without
   * leaking a partial trivia-skip when nothing actually matched.
   */
  matchKeyword(word: string): boolean {
    const save = this.pos;
    this.skipTrivia();
    const slice = this.text.slice(this.pos, this.pos + word.length);
    if (slice.toLowerCase() !== word.toLowerCase()) {
      this.pos = save;
      return false;
    }
    const after = this.text[this.pos + word.length];
    if (after && IDENT_CONT.test(after)) {
      this.pos = save;
      return false;
    }
    this.pos += word.length;
    return true;
  }

  /** A bare identifier or a "quoted identifier" (unescaped). */
  scanIdentifier(): string | null {
    this.skipTrivia();
    if (this.peek() === '"') {
      let out = "";
      this.pos++;
      while (!this.eof()) {
        if (this.peek() === '"' && this.peek(1) === '"') {
          out += '"';
          this.pos += 2;
          continue;
        }
        if (this.peek() === '"') {
          this.pos++;
          return out;
        }
        out += this.peek();
        this.pos++;
      }
      throw new SqlParseError("Unterminated quoted identifier", this.pos);
    }
    const start = this.pos;
    while (!this.eof() && IDENT_CONT.test(this.peek())) this.pos++;
    if (this.pos === start) return null;
    return this.text.slice(start, this.pos);
  }

  /**
   * Assumes the current character is "(". Scans to the matching ")" — every
   * string/quoted-ident/comment/dollar-quote shields its contents from
   * paren-counting — and returns the text strictly between the outer
   * parens (only leading/trailing whitespace trimmed).
   */
  scanParenBody(): string {
    this.skipTrivia();
    if (this.peek() !== "(") {
      throw new SqlParseError("Expected '('", this.pos);
    }
    this.pos++;
    const start = this.pos;
    let depth = 1;
    while (!this.eof() && depth > 0) {
      if (this.consumeNonStructural()) continue;
      const c = this.peek();
      if (c === "(") {
        depth++;
        this.pos++;
        continue;
      }
      if (c === ")") {
        depth--;
        this.pos++;
        continue;
      }
      this.pos++;
    }
    if (depth !== 0) {
      throw new SqlParseError("Unbalanced parentheses", this.pos);
    }
    return this.text.slice(start, this.pos - 1).trim();
  }

  /**
   * Scans from the current position to the next top-level ';' or EOF.
   * Rejects (rather than silently truncating) if more non-trivia text
   * follows a top-level ';' — multiple pasted statements aren't supported.
   */
  scanMainQuery(): string {
    const start = this.pos;
    while (!this.eof()) {
      if (this.consumeNonStructural()) continue;
      if (this.peek() === ";") {
        const body = this.text.slice(start, this.pos).trim();
        this.pos++;
        this.skipTrivia();
        if (!this.eof()) {
          throw new SqlParseError(
            "Multiple statements aren't supported — paste one view/query at a time",
            this.pos,
          );
        }
        return body;
      }
      if (this.peek() === "(") {
        this.scanParenBody();
        continue;
      }
      this.pos++;
    }
    return this.text.slice(start).trim();
  }
}

/**
 * Returns `text` with the contents of every string literal / quoted
 * identifier / comment / dollar-quoted string blanked out to spaces
 * (preserving length and every structural character's position), so a
 * caller can safely keyword-scan or position-report against the result
 * without false positives from text inside a string or comment.
 */
export function stripStringsAndComments(text: string): string {
  const s = new Scanner(text);
  let out = "";
  let lastEnd = 0;
  while (!s.eof()) {
    const start = s.pos;
    if (s.consumeNonStructural()) {
      out += text.slice(lastEnd, start);
      out += " ".repeat(s.pos - start);
      lastEnd = s.pos;
      continue;
    }
    s.pos++;
  }
  out += text.slice(lastEnd);
  return out;
}

function findReferencedNames(body: string, candidateNames: string[]): string[] {
  if (candidateNames.length === 0) return [];
  const nameSet = new Set(candidateNames);
  const found = new Set<string>();
  const s = new Scanner(body);
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    const c = s.peek();
    if (c === '"' || IDENT_START.test(c)) {
      const id = s.scanIdentifier();
      if (id && nameSet.has(id)) found.add(id);
      continue;
    }
    s.pos++;
  }
  return [...found];
}

/**
 * Finds plain `FROM x` / `JOIN x` (optionally `schema.x`) table references,
 * excluding any name that's actually a locally-defined CTE (those are
 * tracked separately via findReferencedNames/dependsOn). Deliberately skips
 * the "complicated" cases rather than guess: a subquery (`FROM (SELECT
 * ...)`) or `LATERAL` (`CROSS JOIN LATERAL (...)`) immediately following
 * FROM/JOIN is left alone. A name that slips through anyway (e.g. a
 * function call like `FROM generate_series(...)`) is harmless — the caller
 * validates every candidate against the real introspected table list before
 * creating anything from it.
 */
function findTableRefs(body: string, localCteNames: Set<string>): TableRef[] {
  const found = new Map<string, TableRef>();
  const s = new Scanner(body);
  while (!s.eof()) {
    if (s.consumeNonStructural()) continue;
    if (s.matchKeyword("FROM") || s.matchKeyword("JOIN")) {
      s.skipTrivia();
      if (s.matchKeyword("LATERAL") || s.peek() === "(") continue;
      const first = s.scanIdentifier();
      if (!first) continue;
      let schema = "public";
      let table = first;
      const save = s.pos;
      s.skipTrivia();
      if (s.peek() === ".") {
        s.pos++;
        const second = s.scanIdentifier();
        if (second) {
          schema = first;
          table = second;
        } else {
          s.pos = save;
        }
      } else {
        s.pos = save;
      }
      if (!localCteNames.has(table)) {
        found.set(`${schema}.${table}`, { schema, table });
      }
      continue;
    }
    s.pos++;
  }
  return [...found.values()];
}

/** Best-effort strip of a leading `CREATE [OR REPLACE] [MATERIALIZED] VIEW <name> AS`. */
function stripCreateViewPrefix(s: Scanner): void {
  const save = s.pos;
  try {
    if (!s.matchKeyword("CREATE")) return;
    if (s.matchKeyword("OR")) {
      if (!s.matchKeyword("REPLACE")) throw new Error("not a CREATE VIEW");
    }
    s.matchKeyword("MATERIALIZED");
    if (!s.matchKeyword("VIEW")) throw new Error("not a CREATE VIEW");
    // Skip the (possibly schema-qualified/quoted) view name up to AS.
    let guard = 0;
    while (!s.matchKeyword("AS")) {
      if (s.eof() || guard++ > 100000) throw new Error("no AS found");
      if (!s.consumeNonStructural()) s.pos++;
    }
  } catch {
    s.pos = save;
  }
}

export function parseSqlForImport(input: string): ParsedSql {
  const s = new Scanner(input);
  s.skipTrivia();
  stripCreateViewPrefix(s);
  s.skipTrivia();

  const ctes: ParsedCte[] = [];
  const names: string[] = [];

  if (s.matchKeyword("WITH")) {
    s.matchKeyword("RECURSIVE");
    for (;;) {
      const name = s.scanIdentifier();
      if (!name) throw new SqlParseError("Expected a CTE name", s.pos);
      if (!s.matchKeyword("AS")) {
        throw new SqlParseError(`Expected AS after "${name}"`, s.pos);
      }
      const body = s.scanParenBody();
      if (names.includes(name)) {
        throw new SqlParseError(`Duplicate CTE name "${name}"`, s.pos);
      }
      ctes.push({ name, body, dependsOn: [], tableRefs: [] });
      names.push(name);
      s.skipTrivia();
      if (s.peek() === ",") {
        s.pos++;
        continue;
      }
      break;
    }
  }

  const mainBody = s.scanMainQuery();
  if (!mainBody) {
    throw new SqlParseError("No query found after the CTE list", s.pos);
  }

  const localCteNames = new Set(names);
  for (const cte of ctes) {
    cte.dependsOn = findReferencedNames(
      cte.body,
      names.filter((n) => n !== cte.name),
    );
    cte.tableRefs = findTableRefs(cte.body, localCteNames);
  }
  const mainDependsOn = findReferencedNames(mainBody, names);
  const mainTableRefs = findTableRefs(mainBody, localCteNames);

  return {
    ctes,
    mainQuery: { body: mainBody, dependsOn: mainDependsOn, tableRefs: mainTableRefs },
  };
}
