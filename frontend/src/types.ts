// Mirrors tools/etl/compiler.ts on the backend. Kept in sync by hand — see
// CLAUDE.md / the ETL plan notes for why this isn't a shared package.

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface SchemaTable {
  schema: string;
  name: string;
  type: "table" | "view";
  columns: ColumnInfo[];
}

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
   * read by the compiler. Populated by the join-chain importer's per-step
   * c0/c1/... renames (see tools/etl/importGraph.ts), whose real `from`
   * value is just the previous step's short synthetic name and so carries
   * no meaning on its own.
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
  value?: string | number | (string | number)[];
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
 * (a FULL OUTER JOIN internally) and exposes three outputs — see
 * JOIN_BRANCHES. Which outputs get wired up downstream is what determines
 * the effective join semantics. Multiple conditions are ANDed together
 * (composite-key joins).
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
 * N-input union (SQL UNION / UNION ALL). `inputs` lists this node's own
 * target-handle ids in order (like Join's fixed left/right, generalized to
 * N) — order matters because it's also the branch order in the compiled
 * SQL. `columns[].from[handle]` names the source column on that input feeding
 * this output column, or `null` to fill NULL for that branch (e.g. a column
 * only one branch has). Mirrors tools/etl/compiler.ts's UnionNodeData.
 */
export interface UnionNodeData {
  mode: "ALL" | "DISTINCT";
  inputs: string[];
  columns: { to: string; from: Record<string, string | null> }[];
}

/**
 * An escape hatch for SQL no native node can represent (window functions,
 * subqueries, CASE expressions, lateral-VALUES unpivots, ...) — typically
 * populated by the SQL import wizard, one node per CTE of a pasted view.
 * `sql` is spliced in verbatim on the backend, so it can reference sibling
 * `sql` nodes (or real tables) by whatever names the original SQL used.
 * `detectedColumns` starts empty and is filled in after the node is run
 * once (see columnInference.ts) — there's no way to know a raw SQL block's
 * output columns without asking the database.
 */
export interface SqlNodeData {
  sql: string;
  label: string;
  dependsOn: string[];
  detectedColumns: string[];
}

export type EtlNodeType =
  | "source"
  | "select"
  | "filter"
  | "join"
  | "aggregate"
  | "sort"
  | "limit"
  | "union"
  | "sql";

/**
 * A free-floating canvas note, optionally pinned to another node for
 * context. Deliberately NOT part of EtlNodeType/EtlNodeData — those mirror
 * the backend compiler's node types 1:1, and a comment is never compiled or
 * sent to it (see App.tsx's graphPayload, which filters "comment" nodes out
 * before every /etl/run call).
 */
export interface CommentNodeData {
  text: string;
  collapsed: boolean;
  attachedNodeId: string | null;
}

export function defaultCommentData(): CommentNodeData {
  return { text: "", collapsed: false, attachedNodeId: null };
}

export type EtlNodeData =
  | SourceNodeData
  | SelectNodeData
  | FilterNodeData
  | JoinNodeData
  | AggregateNodeData
  | SortNodeData
  | LimitNodeData
  | UnionNodeData
  | SqlNodeData;

export interface ColRef {
  sourceNodeId: string;
  originalName: string;
  outputName: string;
  sourceLabel?: string;
}

export const FILTER_OPERATORS: FilterOperator[] = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "IN",
  "IS NULL",
  "IS NOT NULL",
];

export const AGG_FUNCTIONS: AggFn[] = [
  "SUM",
  "COUNT",
  "COUNT_DISTINCT",
  "AVG",
  "MIN",
  "MAX",
];

/** The single implicit output branch for single-output node types. */
export const DEFAULT_BRANCH = "out";

export interface Branch {
  id: string;
  label: string;
}

/** Output branches a node produces. Must match tools/etl/compiler.ts. */
export function branchesFor(type: EtlNodeType): Branch[] {
  switch (type) {
    case "filter":
      return [
        { id: "true", label: "True" },
        { id: "false", label: "False" },
      ];
    case "join":
      // "matched" first so selecting/previewing a join defaults to the
      // most commonly useful branch (an inner-join-style result).
      return [
        { id: "matched", label: "Both" },
        { id: "left_only", label: "Left only" },
        { id: "right_only", label: "Right only" },
      ];
    default:
      return [{ id: DEFAULT_BRANCH, label: "Output" }];
  }
}

export function defaultDataFor(type: EtlNodeType): EtlNodeData {
  switch (type) {
    case "source":
      return { schema: "public", table: "", columns: [] };
    case "select":
      return { mappings: [] };
    case "filter":
      return { conjunction: "AND", conditions: [] };
    case "join":
      return { conditions: [{ leftKey: "", rightKey: "" }] };
    case "aggregate":
      return { groupBy: [], aggregations: [] };
    case "sort":
      return { fields: [] };
    case "limit":
      return { count: 100 };
    case "union":
      return { mode: "ALL", inputs: ["in0", "in1"], columns: [] };
    case "sql":
      return { sql: "", label: "", dependsOn: [], detectedColumns: [] };
  }
}
