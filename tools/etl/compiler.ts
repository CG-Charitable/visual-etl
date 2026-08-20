import { getIntrospection, type TableInfo } from "./introspect.ts";
import { assertReadOnlySql, SqlSafetyError } from "./sqlGuard.ts";
import { describeColumns } from "./rawdb.ts";

// ---------------------------------------------------------------------------
// Graph node/data shapes (mirrored by the frontend's node config forms)
// ---------------------------------------------------------------------------
export interface SourceNodeData {
  schema: string;
  table: string;
  columns: string[]; // empty = all columns
}

export interface SelectMapping {
  from: string;
  to: string;
  /**
   * Purely descriptive origin (e.g. "o.accountId"), for display only — never
   * read by compileSelect. Populated by the join-chain importer's per-step
   * c0/c1/... renames (see importGraph.ts), whose real `from` value is just
   * the previous step's short synthetic name and so carries no meaning on
   * its own.
   */
  sourceLabel?: string;
}
export interface SelectNodeData {
  mappings: SelectMapping[];
}

export type FilterOperator =
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
export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}
export interface FilterNodeData {
  conjunction: "AND" | "OR";
  conditions: FilterCondition[];
}

export interface JoinCondition {
  leftKey: string;
  rightKey: string;
}
/**
 * No `type` field: like Alteryx's Join tool, this always joins on every row
 * (a FULL OUTER JOIN internally) and exposes three outputs — "left_only"
 * (unmatched left rows), "matched" (inner-joined rows), "right_only"
 * (unmatched right rows). Which outputs a downstream node wires up to is
 * what determines the effective join semantics (matched-only = inner,
 * matched+left_only = left join, etc). Multiple conditions are ANDed
 * together (composite-key joins).
 */
export interface JoinNodeData {
  conditions: JoinCondition[];
}

export type AggFn = "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" | "COUNT_DISTINCT";
export interface Aggregation {
  column: string;
  fn: AggFn;
  alias: string;
}
export interface AggregateNodeData {
  groupBy: string[];
  aggregations: Aggregation[];
}

export interface SortField {
  column: string;
  direction: "ASC" | "DESC";
}
export interface SortNodeData {
  fields: SortField[];
}

export interface LimitNodeData {
  count: number;
}

/**
 * N-input union (SQL UNION / UNION ALL). Unlike Join's fixed left/right
 * ports, `inputs` lists this node's own target-handle ids in order — order
 * matters because `columns[].from` maps each output column to a source
 * column *per input handle*, not by name, so branches with differently
 * named/ordered columns still combine correctly (mirrors true SQL UNION's
 * positional semantics rather than guessing an alignment). `from[handle] ===
 * null` means "fill NULL for this branch" (e.g. a column only one branch
 * has).
 */
export interface UnionNodeData {
  mode: "ALL" | "DISTINCT";
  inputs: string[];
  columns: { to: string; from: Record<string, string | null> }[];
}

/**
 * An escape hatch for SQL constructs no native node can represent (window
 * functions, subqueries, CASE expressions, lateral-VALUES unpivots, ...).
 * `sql` is spliced in completely verbatim as this node's CTE body — no
 * rewriting — under the CTE name `label` instead of an auto-generated one,
 * so it can reference sibling `sql` nodes (or real tables) by whatever
 * names the original SQL already used. `dependsOn` is purely informational
 * (drives which named input handles the UI shows); the compiler relies only
 * on the graph's actual edges for ordering.
 */
export interface SqlNodeData {
  sql: string;
  label: string;
  dependsOn: string[];
}

export type GraphNode = (
  | { id: string; type: "source"; data: SourceNodeData }
  | { id: string; type: "select"; data: SelectNodeData }
  | { id: string; type: "filter"; data: FilterNodeData }
  | { id: string; type: "join"; data: JoinNodeData }
  | { id: string; type: "aggregate"; data: AggregateNodeData }
  | { id: string; type: "sort"; data: SortNodeData }
  | { id: string; type: "limit"; data: LimitNodeData }
  | { id: string; type: "union"; data: UnionNodeData }
  | { id: string; type: "sql"; data: SqlNodeData }
) & {
  /**
   * Optional custom CTE name for non-`sql` node types (sql nodes use
   * `data.label` instead — see SqlNodeData). Set by the import pipeline
   * when a native-mapped stage's original CTE name needs to keep resolving
   * for an opaque sibling whose verbatim text still references it by that
   * name. Applies only to a node's "primary" output branch (its only
   * branch for single-output types, or a filter's "true" branch) — a
   * secondary branch (e.g. filter's "false") always gets an auto name.
   */
  label?: string;
};

export interface GraphEdge {
  source: string;
  target: string;
  /** Which output branch of the source node this edge reads from. */
  sourceHandle?: string | null;
  /** Which named input of the target node this edge feeds (join only). */
  targetHandle?: string | null;
  /**
   * "dependency" (default when omitted) drives compilation — the source
   * must be compiled first and is pulled into the ancestor subgraph.
   * "reference" is visual-only lineage (e.g. the SQL importer wiring a real
   * table's auto-created Source node into a `sql` node whose own verbatim
   * body already names that table directly) — ignored entirely by the
   * compiler so it doesn't generate an unused CTE or affect ordering, while
   * still letting the Source node be clicked and previewed on its own.
   */
  kind?: "dependency" | "reference";
}

// The single implicit output branch for single-output node types.
export const DEFAULT_BRANCH = "out";
export const FILTER_BRANCHES = ["true", "false"] as const;
export const JOIN_BRANCHES = ["left_only", "matched", "right_only"] as const;

function branchKey(handle: string | null | undefined): string {
  return handle || DEFAULT_BRANCH;
}

// ---------------------------------------------------------------------------
// Compile-time types
// ---------------------------------------------------------------------------
export interface ColRef {
  sourceNodeId: string;
  originalName: string;
  outputName: string;
  /** Mirrors SelectMapping.sourceLabel — display only, carried through so a
   * preview of the node itself can show it too. */
  sourceLabel?: string;
}
interface NodeOutput {
  cteName: string;
  columns: ColRef[];
}
/** A node's compiled outputs, keyed by output branch (DEFAULT_BRANCH for single-output types). */
type NodeOutputs = Record<string, NodeOutput>;

export class CompileError extends Error {
  nodeId: string;
  constructor(nodeId: string, message: string) {
    super(message);
    this.nodeId = nodeId;
  }
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Wraps a verbatim `sql` node body as `"name" AS (<sql>\n)`. The trailing
 * newline before the closing paren matters: if the pasted body's last line
 * is a `--` comment (common — e.g. a commented-out WHERE clause left as a
 * toggle), naively concatenating `AS (${sql})` puts the closing paren on
 * that same commented-out line, and the comment silently swallows it —
 * Postgres then sees an unterminated expression ("syntax error at end of
 * input"). Adding a newline is purely about where OUR wrapper places its
 * own paren; it doesn't touch the pasted text.
 */
function wrapVerbatimCte(cteName: string, sql: string): string {
  return `${quoteIdent(cteName)} AS (${sql}\n)`;
}

function findCol(upstream: NodeOutput, name: string, nodeId: string): ColRef {
  const col = upstream.columns.find((c) => c.outputName === name);
  if (!col) {
    throw new CompileError(
      nodeId,
      `Column "${name}" is not available on this node's input`,
    );
  }
  return col;
}

function paramize(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

// ---------------------------------------------------------------------------
// Per-node-type SQL emitters. Each returns one CTE body per output branch it
// produces (single-output types produce exactly one, under DEFAULT_BRANCH).
// `neededBranches` lets the compiler skip generating CTEs for branches that
// nothing downstream (and no explicit preview target) actually reads.
// ---------------------------------------------------------------------------
function compileSource(
  node: Extract<GraphNode, { type: "source" }>,
  tableMap: Map<string, TableInfo>,
): Record<string, { sql: string; columns: ColRef[] }> {
  const key = `${node.data.schema}.${node.data.table}`;
  const table = tableMap.get(key);
  if (!table) {
    throw new CompileError(node.id, `Unknown table or view "${key}"`);
  }
  const validNames = new Set(table.columns.map((c) => c.name));
  const chosen =
    node.data.columns.length > 0
      ? node.data.columns
      : table.columns.map((c) => c.name);
  for (const c of chosen) {
    if (!validNames.has(c)) {
      throw new CompileError(node.id, `Unknown column "${c}" on ${key}`);
    }
  }
  const selectList = chosen
    .map((c) => `${quoteIdent(c)} AS ${quoteIdent(c)}`)
    .join(", ");
  const sql = `SELECT ${selectList} FROM ${quoteIdent(node.data.schema)}.${quoteIdent(node.data.table)}`;
  const columns: ColRef[] = chosen.map((c) => ({
    sourceNodeId: node.id,
    originalName: c,
    outputName: c,
  }));
  return { [DEFAULT_BRANCH]: { sql, columns } };
}

function compileSelect(
  node: Extract<GraphNode, { type: "select" }>,
  upstreamCte: string,
  upstream: NodeOutput,
): Record<string, { sql: string; columns: ColRef[] }> {
  if (node.data.mappings.length === 0) {
    // Empty mappings = passthrough (mirrors Source's "empty columns = all
    // columns"), rather than an error — used by the SQL importer to give a
    // pure passthrough stage a labelable node without needing to already
    // know its upstream's column list.
    return {
      [DEFAULT_BRANCH]: {
        sql: `SELECT * FROM ${quoteIdent(upstreamCte)}`,
        columns: upstream.columns,
      },
    };
  }
  // Same duplicate-name safety as compileUnion: reference each source
  // column positionally (via `FROM ... AS t(c0, c1, ...)`) rather than by a
  // bare name — a legal upstream can have two columns sharing a name (e.g.
  // two unaliased same-named expressions surviving from a verbatim `sql`
  // node) that a plain name reference can't disambiguate.
  const positionalAliases = upstream.columns.map((_, i) => quoteIdent(`c${i}`));
  const claimed = new Map<string, number>();
  const parts = node.data.mappings.map((m) => {
    const startFrom = claimed.get(m.from) ?? 0;
    const idx = upstream.columns.findIndex((c, i) => i >= startFrom && c.outputName === m.from);
    if (idx === -1) {
      throw new CompileError(node.id, `Column "${m.from}" is not available on this node's input`);
    }
    claimed.set(m.from, idx + 1);
    return `${positionalAliases[idx]} AS ${quoteIdent(m.to)}`;
  });
  const sql = `SELECT ${parts.join(", ")} FROM ${quoteIdent(upstreamCte)} AS ${quoteIdent("t")}(${positionalAliases.join(", ")})`;
  const columns: ColRef[] = node.data.mappings.map((m) => ({
    sourceNodeId: node.id,
    originalName: m.from,
    outputName: m.to,
    sourceLabel: m.sourceLabel,
  }));
  return { [DEFAULT_BRANCH]: { sql, columns } };
}

function compileConditionExpr(
  node: Extract<GraphNode, { type: "filter" }>,
  upstream: NodeOutput,
  values: unknown[],
): string {
  if (node.data.conditions.length === 0) {
    throw new CompileError(node.id, "Filter node needs at least one condition");
  }
  const clauses = node.data.conditions.map((cond) => {
    const col = findCol(upstream, cond.column, node.id);
    const ident = quoteIdent(col.outputName);
    switch (cond.operator) {
      case "IS NULL":
        return `${ident} IS NULL`;
      case "IS NOT NULL":
        return `${ident} IS NOT NULL`;
      case "IN": {
        const arr = Array.isArray(cond.value) ? cond.value : [];
        if (arr.length === 0) {
          throw new CompileError(
            node.id,
            `IN condition on "${cond.column}" needs at least one value`,
          );
        }
        const placeholders = arr.map((v) => paramize(values, v));
        return `${ident} IN (${placeholders.join(", ")})`;
      }
      default: {
        const ph = paramize(values, cond.value);
        return `${ident} ${cond.operator} ${ph}`;
      }
    }
  });
  const joiner = node.data.conjunction === "OR" ? " OR " : " AND ";
  return clauses.join(joiner);
}

function compileFilter(
  node: Extract<GraphNode, { type: "filter" }>,
  upstreamCte: string,
  upstream: NodeOutput,
  values: unknown[],
  needed: Set<string>,
): Record<string, { sql: string; columns: ColRef[] }> {
  const expr = compileConditionExpr(node, upstream, values);
  const out: Record<string, { sql: string; columns: ColRef[] }> = {};
  // IS TRUE / IS NOT TRUE (rather than NOT (...)) so every row lands in
  // exactly one branch even when the condition evaluates to NULL/unknown.
  if (needed.has("true")) {
    out.true = {
      sql: `SELECT * FROM ${quoteIdent(upstreamCte)} WHERE (${expr}) IS TRUE`,
      columns: upstream.columns,
    };
  }
  if (needed.has("false")) {
    out.false = {
      sql: `SELECT * FROM ${quoteIdent(upstreamCte)} WHERE (${expr}) IS NOT TRUE`,
      columns: upstream.columns,
    };
  }
  return out;
}

function compileJoin(
  node: Extract<GraphNode, { type: "join" }>,
  left: NodeOutput,
  leftCte: string,
  right: NodeOutput,
  rightCte: string,
  needed: Set<string>,
): Record<string, { sql: string; columns: ColRef[] }> {
  if (node.data.conditions.length === 0) {
    throw new CompileError(node.id, "Join node needs at least one condition");
  }
  for (const cond of node.data.conditions) {
    findCol(left, cond.leftKey, node.id);
    findCol(right, cond.rightKey, node.id);
  }
  const leftSelect = left.columns.map(
    (c) => `l.${quoteIdent(c.outputName)} AS ${quoteIdent("left_" + c.outputName)}`,
  );
  const rightSelect = right.columns.map(
    (c) => `r.${quoteIdent(c.outputName)} AS ${quoteIdent("right_" + c.outputName)}`,
  );
  const columns: ColRef[] = [
    ...left.columns.map((c) => ({
      sourceNodeId: node.id,
      originalName: c.outputName,
      outputName: "left_" + c.outputName,
    })),
    ...right.columns.map((c) => ({
      sourceNodeId: node.id,
      originalName: c.outputName,
      outputName: "right_" + c.outputName,
    })),
  ];

  // Always a FULL OUTER JOIN under the hood — which of the three filtered
  // views below get used downstream determines the effective join type.
  // Multiple conditions are ANDed together (composite-key join).
  const onClause = node.data.conditions
    .map((cond) => `l.${quoteIdent(cond.leftKey)} = r.${quoteIdent(cond.rightKey)}`)
    .join(" AND ");
  // A literal marker column selected from *inside* each side's own
  // subquery — not a join-key nullability check, and not a whole-row
  // `l IS NOT NULL` test either. A join-key check breaks down when that key
  // can legitimately be NULL as real data on a row that *did* participate.
  // A whole-row test breaks down too: SQL's ROW IS NOT NULL is only true
  // when *every* field is non-null, so a participating row with any other
  // column legitimately NULL (common) reads as "not present" — the row and
  // a genuinely-unmatched opposite-side row become indistinguishable,
  // silently misclassifying and double-counting between left_only and
  // right_only. A bare `TRUE` literal selected as part of each side's own
  // subquery (before the join) has no such ambiguity: it's always exactly
  // TRUE when that side's row is real, and only NULL when the FULL OUTER
  // JOIN pads the entire side because nothing matched.
  const marker = quoteIdent("__marker");
  const leftPresent = quoteIdent("__left_present");
  const rightPresent = quoteIdent("__right_present");
  const baseSql = `SELECT ${[...leftSelect, ...rightSelect].join(", ")}, l.${marker} AS ${leftPresent}, r.${marker} AS ${rightPresent} FROM (SELECT *, TRUE AS ${marker} FROM ${quoteIdent(leftCte)}) l FULL OUTER JOIN (SELECT *, TRUE AS ${marker} FROM ${quoteIdent(rightCte)}) r ON ${onClause}`;
  const outputColumnList = columns.map((c) => quoteIdent(c.outputName)).join(", ");

  const out: Record<string, { sql: string; columns: ColRef[]; base?: string }> =
    {};
  (out as any)._base = { sql: baseSql, columns };
  // The marker is always exactly TRUE (present) or NULL (padded-out,
  // absent) — never FALSE — so "absent" must be tested with IS NULL, not
  // NOT(...): NOT NULL is NULL, not TRUE, and would silently drop every row
  // a NULL-marker check was supposed to catch.
  if (needed.has("matched")) {
    out.matched = {
      sql: `SELECT ${outputColumnList} FROM __BASE__ WHERE ${leftPresent} IS NOT NULL AND ${rightPresent} IS NOT NULL`,
      columns,
    };
  }
  if (needed.has("left_only")) {
    out.left_only = {
      sql: `SELECT ${outputColumnList} FROM __BASE__ WHERE ${rightPresent} IS NULL`,
      columns,
    };
  }
  if (needed.has("right_only")) {
    out.right_only = {
      sql: `SELECT ${outputColumnList} FROM __BASE__ WHERE ${leftPresent} IS NULL`,
      columns,
    };
  }
  return out;
}

function compileUnion(
  node: Extract<GraphNode, { type: "union" }>,
  inputs: { handle: string; cteName: string; output: NodeOutput }[],
): Record<string, { sql: string; columns: ColRef[] }> {
  if (node.data.inputs.length < 2) {
    throw new CompileError(node.id, "Union node requires at least two inputs");
  }
  if (node.data.columns.length === 0) {
    throw new CompileError(node.id, "Union node needs at least one output column");
  }
  const inputByHandle = new Map(inputs.map((i) => [i.handle, i]));
  const branches = node.data.inputs.map((handle) => {
    const input = inputByHandle.get(handle);
    if (!input) {
      throw new CompileError(node.id, `Union input "${handle}" has not been compiled`);
    }
    // A plain `SELECT "name" FROM inputCte` breaks if that input legally
    // has two columns sharing the name "name" (allowed in SQL — e.g. two
    // unaliased `o.name`/`p.name` references landing in the same result
    // set) — Postgres can't tell which one a bare name reference means.
    // Renaming every column positionally via `AS t(c0, c1, ...)` first
    // sidesteps that entirely: c0/c1/... are always unique regardless of
    // what the input's own columns happen to be named. `claimed` tracks,
    // per source name, how many occurrences earlier union columns for this
    // same input already used, so repeated references to a duplicated name
    // claim successive occurrences in order rather than colliding.
    const positionalAliases = input.output.columns.map((_, i) => quoteIdent(`c${i}`));
    const claimed = new Map<string, number>();
    const selectList = node.data.columns
      .map((c, targetIdx) => {
        const src = c.from[handle] ?? null;
        if (src === null) return `NULL AS ${quoteIdent(c.to)}`;
        // Prefer the column at this same positional index when its name
        // already matches: that's what the SQL importer always intends
        // (target position k is built directly from this input's own
        // column at position k), and trusting it sidesteps a real failure
        // mode in the claim-based fallback below — if an earlier duplicate
        // occurrence of this same name got NULL-filled for a *different*
        // union column instead of referenced, claim-counting only sees the
        // references that remain and silently drifts onto the wrong
        // occurrence. A manually-wired union (this input's own shape
        // unrelated to the union's column order) won't match here and
        // falls through to the claim search unchanged.
        const direct = input.output.columns[targetIdx];
        if (direct && direct.outputName === src) {
          claimed.set(src, targetIdx + 1);
          return `${positionalAliases[targetIdx]} AS ${quoteIdent(c.to)}`;
        }
        const startFrom = claimed.get(src) ?? 0;
        const idx = input.output.columns.findIndex(
          (col, i) => i >= startFrom && col.outputName === src,
        );
        if (idx === -1) {
          throw new CompileError(
            node.id,
            `Column "${src}" is not available on this node's input`,
          );
        }
        claimed.set(src, idx + 1);
        return `${positionalAliases[idx]} AS ${quoteIdent(c.to)}`;
      })
      .join(", ");
    return `SELECT ${selectList} FROM ${quoteIdent(input.cteName)} AS ${quoteIdent("t")}(${positionalAliases.join(", ")})`;
  });
  const op = node.data.mode === "DISTINCT" ? "UNION" : "UNION ALL";
  const sql = branches.join(` ${op} `);
  const columns: ColRef[] = node.data.columns.map((c) => ({
    sourceNodeId: node.id,
    originalName: c.to,
    outputName: c.to,
  }));
  return { [DEFAULT_BRANCH]: { sql, columns } };
}

const AGG_FN: Record<AggFn, (col: string) => string> = {
  SUM: (c) => `SUM(${c})`,
  COUNT: (c) => `COUNT(${c})`,
  AVG: (c) => `AVG(${c})`,
  MIN: (c) => `MIN(${c})`,
  MAX: (c) => `MAX(${c})`,
  COUNT_DISTINCT: (c) => `COUNT(DISTINCT ${c})`,
};

function compileAggregate(
  node: Extract<GraphNode, { type: "aggregate" }>,
  upstreamCte: string,
  upstream: NodeOutput,
): Record<string, { sql: string; columns: ColRef[] }> {
  if (node.data.groupBy.length === 0 && node.data.aggregations.length === 0) {
    throw new CompileError(
      node.id,
      "Aggregate node needs at least one group-by column or aggregation",
    );
  }
  const groupParts = node.data.groupBy.map((g) => {
    findCol(upstream, g, node.id);
    return `${quoteIdent(g)} AS ${quoteIdent(g)}`;
  });
  const aggParts = node.data.aggregations.map((a) => {
    findCol(upstream, a.column, node.id);
    return `${AGG_FN[a.fn](quoteIdent(a.column))} AS ${quoteIdent(a.alias)}`;
  });
  const selectList = [...groupParts, ...aggParts].join(", ");
  let sql = `SELECT ${selectList} FROM ${quoteIdent(upstreamCte)}`;
  if (node.data.groupBy.length > 0) {
    sql += ` GROUP BY ${node.data.groupBy.map(quoteIdent).join(", ")}`;
  }
  const columns: ColRef[] = [
    ...node.data.groupBy.map((g) => ({
      sourceNodeId: node.id,
      originalName: g,
      outputName: g,
    })),
    ...node.data.aggregations.map((a) => ({
      sourceNodeId: node.id,
      originalName: a.alias,
      outputName: a.alias,
    })),
  ];
  return { [DEFAULT_BRANCH]: { sql, columns } };
}

function compileSort(
  node: Extract<GraphNode, { type: "sort" }>,
  upstreamCte: string,
  upstream: NodeOutput,
): Record<string, { sql: string; columns: ColRef[] }> {
  if (node.data.fields.length === 0) {
    throw new CompileError(node.id, "Sort node needs at least one field");
  }
  const parts = node.data.fields.map((f) => {
    findCol(upstream, f.column, node.id);
    return `${quoteIdent(f.column)} ${f.direction === "DESC" ? "DESC" : "ASC"}`;
  });
  const sql = `SELECT * FROM ${quoteIdent(upstreamCte)} ORDER BY ${parts.join(", ")}`;
  return { [DEFAULT_BRANCH]: { sql, columns: upstream.columns } };
}

function compileLimit(
  node: Extract<GraphNode, { type: "limit" }>,
  upstreamCte: string,
  upstream: NodeOutput,
): Record<string, { sql: string; columns: ColRef[] }> {
  const count = Number(node.data.count);
  if (!Number.isInteger(count) || count < 0) {
    throw new CompileError(node.id, "Limit must be a non-negative integer");
  }
  const sql = `SELECT * FROM ${quoteIdent(upstreamCte)} LIMIT ${count}`;
  return { [DEFAULT_BRANCH]: { sql, columns: upstream.columns } };
}

// ---------------------------------------------------------------------------
// Graph compiler
// ---------------------------------------------------------------------------
function requireSingleUpstream(
  incoming: GraphEdge[],
  outputs: Map<string, NodeOutputs>,
  nodeId: string,
): NodeOutput {
  if (incoming.length !== 1) {
    throw new CompileError(nodeId, "This node requires exactly one input");
  }
  const upstreamOutputs = outputs.get(incoming[0].source);
  const output = upstreamOutputs?.[branchKey(incoming[0].sourceHandle)];
  if (!output) {
    throw new CompileError(nodeId, "Upstream node has not been compiled");
  }
  return output;
}

export async function compileGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  targetNodeId: string,
  targetHandle?: string | null,
): Promise<{ sql: string; values: unknown[]; columns: ColRef[] }> {
  const tables = await getIntrospection();
  const tableMap = new Map<string, TableInfo>();
  for (const t of tables) tableMap.set(`${t.schema}.${t.name}`, t);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeMap.has(targetNodeId)) {
    throw new CompileError(targetNodeId, "Target node not found in graph");
  }

  // "reference" edges are visual-only lineage (see GraphEdge.kind) — never
  // real dependencies, so they're excluded before ancestor discovery even
  // starts.
  const dependencyEdges = edges.filter((e) => e.kind !== "reference");

  // Collect the ancestor-only subgraph of the target node (BFS backward).
  const ancestorIds = new Set<string>([targetNodeId]);
  const queue = [targetNodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of dependencyEdges) {
      if (e.target === cur && !ancestorIds.has(e.source)) {
        ancestorIds.add(e.source);
        queue.push(e.source);
      }
    }
  }
  const subEdges = dependencyEdges.filter(
    (e) => ancestorIds.has(e.source) && ancestorIds.has(e.target),
  );

  // Kahn topological sort restricted to the ancestor subgraph.
  const inDegree = new Map<string, number>();
  for (const id of ancestorIds) inDegree.set(id, 0);
  for (const e of subEdges) {
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }
  const ready = [...ancestorIds].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of subEdges.filter((e) => e.source === id)) {
      inDegree.set(e.target, inDegree.get(e.target)! - 1);
      if (inDegree.get(e.target) === 0) ready.push(e.target);
    }
  }
  if (order.length !== ancestorIds.size) {
    throw new CompileError(targetNodeId, "Graph contains a cycle");
  }

  // Which output branches of each node are actually consumed by something
  // in the compiled subgraph (or are the requested preview target) — lets
  // filter/join nodes skip generating CTEs nothing reads.
  function neededBranches(nodeId: string): Set<string> {
    const set = new Set<string>();
    for (const e of subEdges) {
      if (e.source === nodeId) set.add(branchKey(e.sourceHandle));
    }
    if (nodeId === targetNodeId) set.add(branchKey(targetHandle));
    return set;
  }

  // Nodes with a chosen CTE name (sql nodes always; other node types
  // optionally, via the shared `label` field) are compiled under that name
  // instead of an auto-generated one, so verbatim `sql` node bodies
  // elsewhere can reference them by whatever name the original SQL used.
  // Collision check up front — never silently rename, since that would
  // break those verbatim references.
  const usedNames = new Map<string, string>(); // cte name -> owning nodeId
  function registerLabel(label: string, nodeId: string): void {
    const existing = usedNames.get(label);
    if (existing) {
      throw new CompileError(
        nodeId,
        `CTE name "${label}" is used by more than one node (also used by "${existing}")`,
      );
    }
    usedNames.set(label, nodeId);
  }
  for (const id of order) {
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node.type === "sql") {
      const label = node.data.label?.trim();
      if (!label) throw new CompileError(node.id, "Custom SQL node needs a name");
      registerLabel(label, node.id);
    } else if (node.label?.trim()) {
      registerLabel(node.label.trim(), node.id);
    }
  }

  const outputs = new Map<string, NodeOutputs>();
  const values: unknown[] = [];
  const cteParts: string[] = [];
  let counter = 0;
  const nextCteName = (ownerId: string) => {
    let name: string;
    do {
      name = `n_${counter++}`;
    } while (usedNames.has(name));
    usedNames.set(name, ownerId);
    return name;
  };

  for (const id of order) {
    const node = nodeMap.get(id);
    if (!node) throw new CompileError(id, "Node referenced by an edge does not exist");
    const incoming = subEdges.filter((e) => e.target === id);
    const needed = neededBranches(id);

    if (node.type === "sql") {
      try {
        assertReadOnlySql(node.data.sql, `Node "${node.id}"`);
      } catch (e) {
        if (e instanceof SqlSafetyError) throw new CompileError(node.id, e.message);
        throw e;
      }
      const cteName = node.data.label.trim();
      const describeSql = `WITH ${[...cteParts, wrapVerbatimCte(cteName, node.data.sql)].join(", ")} SELECT * FROM ${quoteIdent(cteName)}`;
      // `values` already holds every parameter referenced by `cteParts` so
      // far (e.g. a native Filter node compiled earlier) — pass it through
      // or Postgres rejects the probe query with "there is no parameter $1".
      const columnNames = await describeColumns(describeSql, values);
      const columns: ColRef[] = columnNames.map((name) => ({
        sourceNodeId: node.id,
        originalName: name,
        outputName: name,
      }));
      cteParts.push(wrapVerbatimCte(cteName, node.data.sql));
      outputs.set(id, { [DEFAULT_BRANCH]: { cteName, columns } });
      continue;
    }

    let branchSqls: Record<string, { sql: string; columns: ColRef[] }>;
    switch (node.type) {
      case "source": {
        branchSqls = compileSource(node, tableMap);
        break;
      }
      case "select": {
        const up = requireSingleUpstream(incoming, outputs, node.id);
        const upCte = outputs.get(incoming[0].source)![branchKey(incoming[0].sourceHandle)].cteName;
        branchSqls = compileSelect(node, upCte, up);
        break;
      }
      case "filter": {
        const up = requireSingleUpstream(incoming, outputs, node.id);
        const upCte = outputs.get(incoming[0].source)![branchKey(incoming[0].sourceHandle)].cteName;
        branchSqls = compileFilter(node, upCte, up, values, needed);
        break;
      }
      case "join": {
        const leftEdge = incoming.find((e) => e.targetHandle === "left");
        const rightEdge = incoming.find((e) => e.targetHandle === "right");
        if (!leftEdge || !rightEdge) {
          throw new CompileError(
            node.id,
            "Join node requires both a left and a right input",
          );
        }
        const left = outputs.get(leftEdge.source)?.[branchKey(leftEdge.sourceHandle)];
        const right = outputs.get(rightEdge.source)?.[branchKey(rightEdge.sourceHandle)];
        if (!left || !right) {
          throw new CompileError(node.id, "Join inputs have not been compiled");
        }
        branchSqls = compileJoin(node, left, left.cteName, right, right.cteName, needed);
        break;
      }
      case "aggregate": {
        const up = requireSingleUpstream(incoming, outputs, node.id);
        const upCte = outputs.get(incoming[0].source)![branchKey(incoming[0].sourceHandle)].cteName;
        branchSqls = compileAggregate(node, upCte, up);
        break;
      }
      case "sort": {
        const up = requireSingleUpstream(incoming, outputs, node.id);
        const upCte = outputs.get(incoming[0].source)![branchKey(incoming[0].sourceHandle)].cteName;
        branchSqls = compileSort(node, upCte, up);
        break;
      }
      case "limit": {
        const up = requireSingleUpstream(incoming, outputs, node.id);
        const upCte = outputs.get(incoming[0].source)![branchKey(incoming[0].sourceHandle)].cteName;
        branchSqls = compileLimit(node, upCte, up);
        break;
      }
      case "union": {
        const inputs = node.data.inputs.map((handle) => {
          const edge = incoming.find((e) => e.targetHandle === handle);
          if (!edge) {
            throw new CompileError(node.id, `Union input "${handle}" is not connected`);
          }
          const output = outputs.get(edge.source)?.[branchKey(edge.sourceHandle)];
          if (!output) {
            throw new CompileError(node.id, "Union input has not been compiled");
          }
          return { handle, cteName: output.cteName, output };
        });
        branchSqls = compileUnion(node, inputs);
        break;
      }
      default:
        throw new CompileError((node as any).id, "Unknown node type");
    }

    // Join emits an internal "_base" CTE that its branch CTEs select from.
    const nodeOutputs: NodeOutputs = {};
    const base = (branchSqls as any)._base as { sql: string; columns: ColRef[] } | undefined;
    let baseCteName: string | null = null;
    if (base) {
      baseCteName = nextCteName(id);
      cteParts.push(`${quoteIdent(baseCteName)} AS (${base.sql})`);
    }
    for (const [branch, { sql, columns }] of Object.entries(branchSqls)) {
      if (branch === "_base") continue;
      // "true" (Filter) and "matched" (Join) are each that node type's most
      // commonly-referenced/canonical output — same convention, extended to
      // Join so a chain ending on a plain inner join with nothing after it
      // can still be labeled (a "left_only"/"right_only" branch, like
      // Filter's "false", always gets an auto name).
      const isPrimaryBranch = branch === DEFAULT_BRANCH || branch === "true" || branch === "matched";
      const label = node.label?.trim();
      const cteName = isPrimaryBranch && label ? label : nextCteName(id);
      const finalSql = baseCteName
        ? sql.replace("__BASE__", quoteIdent(baseCteName))
        : sql;
      cteParts.push(`${quoteIdent(cteName)} AS (${finalSql})`);
      nodeOutputs[branch] = { cteName, columns };
    }
    outputs.set(id, nodeOutputs);
  }

  const targetOutput = outputs.get(targetNodeId)?.[branchKey(targetHandle)];
  if (!targetOutput) {
    throw new CompileError(
      targetNodeId,
      `Output branch "${branchKey(targetHandle)}" was not produced for this node`,
    );
  }
  const sql = `WITH ${cteParts.join(", ")} SELECT * FROM ${quoteIdent(targetOutput.cteName)}`;
  return { sql, values, columns: targetOutput.columns };
}
