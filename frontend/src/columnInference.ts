import type { Node, Edge } from "@xyflow/react";
import type {
  ColRef,
  SchemaTable,
  SourceNodeData,
  SelectNodeData,
  AggregateNodeData,
  UnionNodeData,
  SqlNodeData,
} from "./types";

/**
 * Pure-JS mirror of tools/etl/compiler.ts's column-tracking rules (source ->
 * passthrough -> join `<side>_<name>` prefixing -> aggregate). Used only to
 * populate inspector dropdowns instantly, without a round trip to the
 * backend. Keep in sync by hand with the backend compiler.
 */

/** Columns a node itself produces (its own output). */
export function computeNodeOutput(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  schema: SchemaTable[],
): ColRef[] {
  const cache = new Map<string, ColRef[]>();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  function tableOf(schemaName: string, tableName: string) {
    return schema.find((t) => t.schema === schemaName && t.name === tableName);
  }

  function singleUpstream(id: string): ColRef[] {
    const edge = edges.find((e) => e.target === id);
    return edge ? compute(edge.source) : [];
  }

  function compute(id: string): ColRef[] {
    if (cache.has(id)) return cache.get(id)!;
    const node = nodeMap.get(id);
    if (!node) return [];
    let result: ColRef[] = [];

    switch (node.type) {
      case "source": {
        const data = node.data as unknown as SourceNodeData;
        const table = tableOf(data.schema, data.table);
        const allCols = table ? table.columns.map((c) => c.name) : [];
        const chosen = data.columns.length > 0 ? data.columns : allCols;
        result = chosen.map((c) => ({
          sourceNodeId: id,
          originalName: c,
          outputName: c,
        }));
        break;
      }
      case "select": {
        const data = node.data as unknown as SelectNodeData;
        result = data.mappings.map((m) => ({
          sourceNodeId: id,
          originalName: m.from,
          outputName: m.to,
        }));
        break;
      }
      case "filter":
      case "sort":
      case "limit": {
        result = singleUpstream(id);
        break;
      }
      case "join": {
        const leftEdge = edges.find(
          (e) => e.target === id && e.targetHandle === "left",
        );
        const rightEdge = edges.find(
          (e) => e.target === id && e.targetHandle === "right",
        );
        const leftCols = leftEdge ? compute(leftEdge.source) : [];
        const rightCols = rightEdge ? compute(rightEdge.source) : [];
        result = [
          ...leftCols.map((c) => ({
            sourceNodeId: id,
            originalName: c.outputName,
            outputName: `left_${c.outputName}`,
          })),
          ...rightCols.map((c) => ({
            sourceNodeId: id,
            originalName: c.outputName,
            outputName: `right_${c.outputName}`,
          })),
        ];
        break;
      }
      case "aggregate": {
        const data = node.data as unknown as AggregateNodeData;
        result = [
          ...data.groupBy.map((g) => ({
            sourceNodeId: id,
            originalName: g,
            outputName: g,
          })),
          ...data.aggregations.map((a) => ({
            sourceNodeId: id,
            originalName: a.alias,
            outputName: a.alias,
          })),
        ];
        break;
      }
      case "union": {
        // A union node's own output is exactly what its column mapping
        // declares — like select/aggregate, it doesn't need to inspect its
        // upstreams to know its own output shape.
        const data = node.data as unknown as UnionNodeData;
        result = data.columns.map((c) => ({
          sourceNodeId: id,
          originalName: c.to,
          outputName: c.to,
        }));
        break;
      }
      case "sql": {
        // Unlike every other node type, a sql node's output columns can't be
        // computed from its config — only the database knows what a raw SQL
        // block returns. Populated after the node is run once (see
        // App.tsx's runPreview), empty until then.
        const data = node.data as unknown as SqlNodeData;
        result = (data.detectedColumns ?? []).map((name) => ({
          sourceNodeId: id,
          originalName: name,
          outputName: name,
        }));
        break;
      }
      default:
        result = [];
    }

    cache.set(id, result);
    return result;
  }

  return compute(nodeId);
}

/** Columns available AT nodeId as input (its single upstream's output). */
export function computeUpstreamColumns(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  schema: SchemaTable[],
): ColRef[] {
  const edge = edges.find((e) => e.target === nodeId);
  if (!edge) return [];
  return computeNodeOutput(edge.source, nodes, edges, schema);
}

/** The two named inputs feeding a join node. */
export function computeJoinInputs(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  schema: SchemaTable[],
): { left: ColRef[]; right: ColRef[] } {
  const leftEdge = edges.find(
    (e) => e.target === nodeId && e.targetHandle === "left",
  );
  const rightEdge = edges.find(
    (e) => e.target === nodeId && e.targetHandle === "right",
  );
  return {
    left: leftEdge
      ? computeNodeOutput(leftEdge.source, nodes, edges, schema)
      : [],
    right: rightEdge
      ? computeNodeOutput(rightEdge.source, nodes, edges, schema)
      : [],
  };
}

/** Every named input feeding a union node, keyed by target handle id. */
export function computeUnionInputs(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  schema: SchemaTable[],
): Record<string, ColRef[]> {
  const result: Record<string, ColRef[]> = {};
  for (const e of edges) {
    if (e.target !== nodeId || !e.targetHandle) continue;
    result[e.targetHandle] = computeNodeOutput(e.source, nodes, edges, schema);
  }
  return result;
}
