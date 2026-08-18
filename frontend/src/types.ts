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

export type EtlNodeType =
  | "source"
  | "select"
  | "filter"
  | "join"
  | "aggregate"
  | "sort"
  | "limit";

export type EtlNodeData =
  | SourceNodeData
  | SelectNodeData
  | FilterNodeData
  | JoinNodeData
  | AggregateNodeData
  | SortNodeData
  | LimitNodeData;

export interface ColRef {
  sourceNodeId: string;
  originalName: string;
  outputName: string;
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
  }
}
