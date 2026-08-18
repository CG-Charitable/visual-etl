import { getIntrospection, type TableInfo } from "./introspect.ts";

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

export type GraphNode =
  | { id: string; type: "source"; data: SourceNodeData }
  | { id: string; type: "select"; data: SelectNodeData }
  | { id: string; type: "filter"; data: FilterNodeData }
  | { id: string; type: "join"; data: JoinNodeData }
  | { id: string; type: "aggregate"; data: AggregateNodeData }
  | { id: string; type: "sort"; data: SortNodeData }
  | { id: string; type: "limit"; data: LimitNodeData };

export interface GraphEdge {
  source: string;
  target: string;
  /** Which output branch of the source node this edge reads from. */
  sourceHandle?: string | null;
  /** Which named input of the target node this edge feeds (join only). */
  targetHandle?: string | null;
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
    throw new CompileError(node.id, "Select node needs at least one column");
  }
  const parts = node.data.mappings.map((m) => {
    findCol(upstream, m.from, node.id);
    return `${quoteIdent(m.from)} AS ${quoteIdent(m.to)}`;
  });
  const sql = `SELECT ${parts.join(", ")} FROM ${quoteIdent(upstreamCte)}`;
  const columns: ColRef[] = node.data.mappings.map((m) => ({
    sourceNodeId: node.id,
    originalName: m.from,
    outputName: m.to,
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
  const baseSql = `SELECT ${[...leftSelect, ...rightSelect].join(", ")} FROM ${quoteIdent(leftCte)} l FULL OUTER JOIN ${quoteIdent(rightCte)} r ON ${onClause}`;

  // Any one condition's key pair is enough to tell matched from unmatched:
  // in a FULL OUTER JOIN, an unmatched row has every column from the
  // missing side (including all of its join keys) come back NULL.
  const leftKeyOut = quoteIdent("left_" + node.data.conditions[0].leftKey);
  const rightKeyOut = quoteIdent("right_" + node.data.conditions[0].rightKey);

  const out: Record<string, { sql: string; columns: ColRef[]; base?: string }> =
    {};
  (out as any)._base = { sql: baseSql, columns };
  if (needed.has("matched")) {
    out.matched = {
      sql: `SELECT * FROM __BASE__ WHERE ${leftKeyOut} IS NOT NULL AND ${rightKeyOut} IS NOT NULL`,
      columns,
    };
  }
  if (needed.has("left_only")) {
    out.left_only = {
      sql: `SELECT * FROM __BASE__ WHERE ${rightKeyOut} IS NULL`,
      columns,
    };
  }
  if (needed.has("right_only")) {
    out.right_only = {
      sql: `SELECT * FROM __BASE__ WHERE ${leftKeyOut} IS NULL`,
      columns,
    };
  }
  return out;
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

  // Collect the ancestor-only subgraph of the target node (BFS backward).
  const ancestorIds = new Set<string>([targetNodeId]);
  const queue = [targetNodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target === cur && !ancestorIds.has(e.source)) {
        ancestorIds.add(e.source);
        queue.push(e.source);
      }
    }
  }
  const subEdges = edges.filter(
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

  const outputs = new Map<string, NodeOutputs>();
  const values: unknown[] = [];
  const cteParts: string[] = [];
  let counter = 0;
  const nextCteName = () => `cte_${counter++}`;

  for (const id of order) {
    const node = nodeMap.get(id);
    if (!node) throw new CompileError(id, "Node referenced by an edge does not exist");
    const incoming = subEdges.filter((e) => e.target === id);
    const needed = neededBranches(id);

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
      default:
        throw new CompileError((node as any).id, "Unknown node type");
    }

    // Join emits an internal "_base" CTE that its branch CTEs select from.
    const nodeOutputs: NodeOutputs = {};
    const base = (branchSqls as any)._base as { sql: string; columns: ColRef[] } | undefined;
    let baseCteName: string | null = null;
    if (base) {
      baseCteName = nextCteName();
      cteParts.push(`${quoteIdent(baseCteName)} AS (${base.sql})`);
    }
    for (const [branch, { sql, columns }] of Object.entries(branchSqls)) {
      if (branch === "_base") continue;
      const cteName = nextCteName();
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
