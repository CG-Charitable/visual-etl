import type { ColRef, SchemaTable } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as any).error || `Request failed (${res.status})`);
  }
  return body as T;
}

export function login(username: string, password: string) {
  return request<{ message: string }>("/auth", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ message: string }>("/auth", { method: "DELETE" });
}

export function currentUser() {
  return request<Record<string, unknown>>("/user");
}

export function fetchSchema() {
  return request<{ tables: SchemaTable[] }>("/etl/schema");
}

export interface RunGraphRequest {
  nodes: { id: string; type: string; data: unknown; label?: string }[];
  edges: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    kind?: "dependency" | "reference";
  }[];
  targetNodeId: string;
  targetHandle?: string | null;
  limit?: number;
  mode?: "rows" | "count";
}

export interface RunGraphResponse {
  sql: string;
  columns: ColRef[];
  rows: Record<string, unknown>[];
}

export function runGraph(payload: RunGraphRequest) {
  return request<RunGraphResponse>("/etl/run", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function runGraphCount(payload: Omit<RunGraphRequest, "mode">) {
  return request<{ count: number }>("/etl/run", {
    method: "POST",
    body: JSON.stringify({ ...payload, mode: "count" }),
  });
}

export interface ImportedGraph {
  nodes: {
    id: string;
    // Genuinely simple, single-table CTEs get mapped onto native nodes
    // (Source -> Filter -> Select -> Sort -> Limit) instead of one opaque
    // "sql" node — see tools/etl/simpleSelectParser.ts.
    type: "sql" | "source" | "filter" | "select" | "sort" | "limit";
    position: { x: number; y: number };
    data: unknown;
    // Only set on a native chain's tail when an opaque sibling's SQL text
    // still references this stage by its original CTE name.
    label?: string;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    targetHandle?: string;
    sourceHandle?: string;
    kind?: "dependency" | "reference";
  }[];
}

export function importSql(sql: string) {
  return request<ImportedGraph>("/etl/import", {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
}
