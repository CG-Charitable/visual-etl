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
  nodes: { id: string; type: string; data: unknown }[];
  edges: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
  targetNodeId: string;
  targetHandle?: string | null;
  limit?: number;
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
