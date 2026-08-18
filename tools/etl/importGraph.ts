import { parseSqlForImport, type ParsedSql, type TableRef } from "./sqlImportParser.ts";
import { assertReadOnlySql, SqlSafetyError } from "./sqlGuard.ts";
import { getIntrospection } from "./introspect.ts";
import { tryParseSimpleSelect, type SimpleSelectPlan } from "./simpleSelectParser.ts";

export class ImportError extends Error {}

export type ImportedNode = (
  | {
      id: string;
      type: "sql";
      position: { x: number; y: number };
      data: { sql: string; label: string; dependsOn: string[]; detectedColumns: string[] };
    }
  | {
      id: string;
      type: "source";
      position: { x: number; y: number };
      data: { schema: string; table: string; columns: string[] };
    }
  | {
      id: string;
      type: "filter";
      position: { x: number; y: number };
      data: {
        conjunction: "AND" | "OR";
        conditions: { column: string; operator: string; value?: unknown }[];
      };
    }
  | {
      id: string;
      type: "select";
      position: { x: number; y: number };
      data: { mappings: { from: string; to: string }[] };
    }
  | {
      id: string;
      type: "sort";
      position: { x: number; y: number };
      data: { fields: { column: string; direction: "ASC" | "DESC" }[] };
    }
  | {
      id: string;
      type: "limit";
      position: { x: number; y: number };
      data: { count: number };
    }
) & {
  // Only ever set on a native chain's tail, and only when some opaque
  // sibling's verbatim SQL text still references this stage by its
  // original CTE name — see GraphNode.label in compiler.ts.
  label?: string;
};

export interface ImportedEdge {
  id: string;
  source: string;
  target: string;
  targetHandle?: string;
  sourceHandle?: string;
  kind?: "dependency" | "reference";
}

const MAIN_QUERY_LABEL = "import_result";

function sourceNodeId(ref: TableRef): string {
  return `source_${ref.schema}_${ref.table}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Turns a pasted SQL view/query into a ready-to-drop-in graph fragment.
 *
 * For each CTE (plus the trailing main query), first tries to represent it
 * with native nodes (Source -> Filter -> Select -> Sort -> Limit) via
 * `tryParseSimpleSelect` — this only succeeds for genuinely simple,
 * single-table SELECTs; anything with a JOIN, an expression, DISTINCT, a
 * subquery, etc. falls back to one opaque `sql`-type node holding the
 * verbatim CTE body, exactly as before. Every real table any stage reads
 * from — whether embedded in an opaque node's text or the source of a
 * native chain — gets its own `source`-type node, deduplicated, so it can
 * be clicked and inspected on its own.
 */
export async function buildImportedGraph(rawSql: string): Promise<{
  nodes: ImportedNode[];
  edges: ImportedEdge[];
}> {
  let parsed: ParsedSql;
  try {
    parsed = parseSqlForImport(rawSql);
  } catch (e) {
    throw new ImportError((e as Error).message);
  }

  const mainLabel = parsed.ctes.some((c) => c.name === MAIN_QUERY_LABEL)
    ? `${MAIN_QUERY_LABEL}_2`
    : MAIN_QUERY_LABEL;

  const stages = [
    ...parsed.ctes.map((c) => ({
      name: c.name,
      body: c.body,
      dependsOn: c.dependsOn,
      tableRefs: c.tableRefs,
    })),
    {
      name: mainLabel,
      body: parsed.mainQuery.body,
      dependsOn: parsed.mainQuery.dependsOn,
      tableRefs: parsed.mainQuery.tableRefs,
    },
  ];
  const stageNames = new Set(stages.map((s) => s.name));

  // Reject the whole import up front if anything mutates, naming the stage
  // — don't wait for someone to click "Run" on the offending node later.
  for (const stage of stages) {
    try {
      assertReadOnlySql(
        stage.body,
        stage.name === mainLabel ? "Main query" : `CTE "${stage.name}"`,
      );
    } catch (e) {
      if (e instanceof SqlSafetyError) throw new ImportError(e.message);
      throw e;
    }
  }

  // Only surface a table ref (from an opaque stage's text, or a native
  // chain's FROM target) as its own Source node if it's a real,
  // currently-introspectable table/view — a heuristic false positive (e.g.
  // a function call the scanner mistook for a table) just gets silently
  // dropped rather than producing a broken node.
  const knownTables = await getIntrospection();
  const knownTableKeys = new Set(knownTables.map((t) => `${t.schema}.${t.name}`));
  for (const stage of stages) {
    stage.tableRefs = stage.tableRefs.filter((t) => knownTableKeys.has(`${t.schema}.${t.table}`));
  }

  // Try the native-node mapping for every stage up front. A plan whose FROM
  // target is a real table that isn't actually a known table is treated the
  // same as "not simple" — fall back to the opaque node rather than wire up
  // a broken Source.
  const simplePlans = new Map<string, SimpleSelectPlan>();
  for (const stage of stages) {
    const plan = tryParseSimpleSelect(stage.body, stageNames);
    if (!plan) continue;
    if ("schema" in plan.from && !knownTableKeys.has(`${plan.from.schema}.${plan.from.table}`)) {
      continue;
    }
    simplePlans.set(stage.name, plan);
  }

  // A native-mapped stage only needs to keep resolving under its original
  // CTE name if some OPAQUE sibling's verbatim SQL text still mentions it
  // (native siblings reference it through a real graph edge instead, which
  // doesn't care what it's named) — so only those get the extra bookkeeping.
  const namesReferencedByOpaqueSiblings = new Set<string>();
  for (const stage of stages) {
    if (simplePlans.has(stage.name)) continue;
    for (const dep of stage.dependsOn) {
      if (stageNames.has(dep)) namesReferencedByOpaqueSiblings.add(dep);
    }
  }

  const idOf = (name: string) => `sql_${name}`;

  // Layered layout for CTE stages: layer = 1 + max(layer of local CTE
  // dependencies), 0 for roots — then shifted by +1 below to leave layer 0
  // for the extracted table Source nodes. Native/opaque representation
  // doesn't affect this — it's purely about CTE-to-CTE dependency depth.
  const layerOf = new Map<string, number>();
  function computeLayer(name: string, stack: Set<string>): number {
    if (layerOf.has(name)) return layerOf.get(name)!;
    if (stack.has(name)) {
      throw new ImportError(`Circular reference involving "${name}"`);
    }
    stack.add(name);
    const stage = stages.find((s) => s.name === name)!;
    const localDeps = stage.dependsOn.filter((d) => stageNames.has(d));
    const layer =
      localDeps.length === 0
        ? 0
        : 1 + Math.max(...localDeps.map((d) => computeLayer(d, stack)));
    stack.delete(name);
    layerOf.set(name, layer);
    return layer;
  }
  for (const stage of stages) computeLayer(stage.name, new Set());

  const nodes: ImportedNode[] = [];
  const edges: ImportedEdge[] = [];

  // One Source node per distinct real table referenced anywhere (opaque
  // stages' scanned tableRefs, plus native-mapped stages' FROM targets), at
  // layer 0.
  const sourceRefs = new Map<string, TableRef>();
  for (const stage of stages) {
    const plan = simplePlans.get(stage.name);
    if (plan && "schema" in plan.from) {
      sourceRefs.set(`${plan.from.schema}.${plan.from.table}`, plan.from);
    } else if (!plan) {
      for (const ref of stage.tableRefs) sourceRefs.set(`${ref.schema}.${ref.table}`, ref);
    }
  }
  [...sourceRefs.values()].forEach((ref, index) => {
    nodes.push({
      id: sourceNodeId(ref),
      type: "source",
      position: { x: 0, y: index * 160 },
      data: { schema: ref.schema, table: ref.table, columns: [] },
    });
  });

  let nativeIdCounter = 0;
  const nextNativeId = (prefix: string) => `native_${prefix}_${nativeIdCounter++}`;

  /**
   * Builds Filter -> Select -> Sort -> Limit off of a given input
   * node/handle, skipping any step the plan doesn't need. If `neededLabel`
   * is set, the chain is guaranteed to end on a node that's safe to label
   * with it (never a shared Source node or another stage's own output) —
   * inserting a trivial identity Select (empty mappings = passthrough) if
   * the chain would otherwise be empty.
   */
  function buildNativeChain(
    plan: SimpleSelectPlan,
    inputNodeId: string,
    inputHandle: string | undefined,
    baseX: number,
    y: number,
    neededLabel: string | undefined,
  ): { nodes: ImportedNode[]; edges: ImportedEdge[]; outputNodeId: string; outputHandle: string | undefined } {
    const chainNodes: ImportedNode[] = [];
    const chainEdges: ImportedEdge[] = [];
    let currentId = inputNodeId;
    let currentHandle = inputHandle;
    let x = baseX;

    function link(id: string, type: ImportedNode["type"], data: any) {
      chainNodes.push({ id, type, position: { x, y }, data } as ImportedNode);
      chainEdges.push({
        id: `${currentId}->${id}`,
        source: currentId,
        target: id,
        sourceHandle: currentHandle,
        kind: "dependency",
      });
      currentId = id;
      currentHandle = undefined;
      x += 240;
    }

    if (plan.filter) {
      link(nextNativeId("filter"), "filter", {
        conjunction: plan.filter.conjunction,
        conditions: plan.filter.conditions,
      });
      currentHandle = "true"; // the passing-rows branch is what a plain WHERE clause means
    }
    // Sort BEFORE Select: a non-DISTINCT, non-set-operation SELECT's ORDER
    // BY is evaluated against the underlying FROM-clause row, so it can
    // (and often does) reference a column that isn't in the SELECT list at
    // all — e.g. a helper sort key computed by an upstream CTE. Projecting
    // first would drop that column before Sort ever sees it.
    if (plan.sort && plan.sort.length > 0) {
      link(nextNativeId("sort"), "sort", { fields: plan.sort });
    }
    if (!plan.selectAll) {
      link(nextNativeId("select"), "select", {
        mappings: plan.selectItems.map((i) => ({ from: i.column, to: i.alias })),
      });
    }
    if (plan.limit !== null) {
      link(nextNativeId("limit"), "limit", { count: plan.limit });
    }

    if (neededLabel) {
      if (chainNodes.length === 0) {
        // Pure passthrough (e.g. `SELECT * FROM x` with nothing else) — the
        // current tail is a shared Source node or another stage's own
        // output, neither of which we can safely relabel, so give this
        // stage its own dedicated identity node to hang the label on.
        link(nextNativeId("select"), "select", { mappings: [] });
      }
      chainNodes[chainNodes.length - 1].label = neededLabel;
    }

    return { nodes: chainNodes, edges: chainEdges, outputNodeId: currentId, outputHandle: currentHandle };
  }

  // What node/handle represents each stage's output — whichever of a native
  // chain's tail or an opaque sql node it ended up being.
  const stageOutput = new Map<string, { nodeId: string; handle: string | undefined }>();

  const countPerLayer = new Map<number, number>();
  for (const stage of stages) {
    const layer = layerOf.get(stage.name)! + 1; // +1 to make room for Source nodes at layer 0
    const plan = simplePlans.get(stage.name);

    if (plan) {
      let inputNodeId: string;
      let inputHandle: string | undefined;
      if ("cteName" in plan.from) {
        const upstream = stageOutput.get(plan.from.cteName);
        if (!upstream) {
          throw new ImportError(
            `"${stage.name}" reads from "${plan.from.cteName}" before it's defined`,
          );
        }
        inputNodeId = upstream.nodeId;
        inputHandle = upstream.handle;
      } else {
        inputNodeId = sourceNodeId(plan.from);
        inputHandle = undefined;
      }

      const index = countPerLayer.get(layer) ?? 0;
      const neededLabel = namesReferencedByOpaqueSiblings.has(stage.name) ? stage.name : undefined;
      const chain = buildNativeChain(
        plan,
        inputNodeId,
        inputHandle,
        layer * 280,
        index * 160,
        neededLabel,
      );
      if (chain.nodes.length > 0) {
        countPerLayer.set(layer, index + 1);
      }
      nodes.push(...chain.nodes);
      edges.push(...chain.edges);
      stageOutput.set(stage.name, { nodeId: chain.outputNodeId, handle: chain.outputHandle });
      continue;
    }

    // Fall back to an opaque sql node holding the verbatim CTE body.
    const index = countPerLayer.get(layer) ?? 0;
    countPerLayer.set(layer, index + 1);
    nodes.push({
      id: idOf(stage.name),
      type: "sql",
      position: { x: layer * 280, y: index * 160 },
      data: {
        sql: stage.body,
        label: stage.name,
        dependsOn: [
          ...stage.dependsOn.filter((d) => stageNames.has(d)),
          ...stage.tableRefs.map((t) => t.table),
        ],
        detectedColumns: [],
      },
    });
    stageOutput.set(stage.name, { nodeId: idOf(stage.name), handle: undefined });

    for (const dep of stage.dependsOn) {
      if (!stageNames.has(dep)) continue; // a real table/view reference, not a local CTE
      const upstream = stageOutput.get(dep);
      if (!upstream) {
        throw new ImportError(`"${stage.name}" reads from "${dep}" before it's defined`);
      }
      edges.push({
        id: `${upstream.nodeId}->${idOf(stage.name)}`,
        source: upstream.nodeId,
        target: idOf(stage.name),
        targetHandle: dep,
        sourceHandle: upstream.handle,
        kind: "dependency",
      });
    }
    for (const ref of stage.tableRefs) {
      edges.push({
        id: `${sourceNodeId(ref)}->${idOf(stage.name)}`,
        source: sourceNodeId(ref),
        target: idOf(stage.name),
        targetHandle: ref.table,
        kind: "reference",
      });
    }
  }

  return { nodes, edges };
}
