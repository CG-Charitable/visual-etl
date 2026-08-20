import {
  parseSqlForImport,
  splitTopLevelUnion,
  type ParsedSql,
  type TableRef,
  type UnionBranch,
} from "./sqlImportParser.ts";
import { assertReadOnlySql, SqlSafetyError } from "./sqlGuard.ts";
import { getIntrospection } from "./introspect.ts";
import { tryParseSimpleSelect, type SimpleSelectPlan } from "./simpleSelectParser.ts";
import {
  tryParseJoinChain,
  rewriteQualifiedColumns,
  findNullLiteralSelectItems,
  quoteIdent,
  type JoinChainPlan,
  type JoinChainFrom,
} from "./joinChainParser.ts";
import { compileGraph, type GraphNode, type GraphEdge } from "./compiler.ts";

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
      data: { mappings: { from: string; to: string; sourceLabel?: string }[] };
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
  | {
      id: string;
      type: "union";
      position: { x: number; y: number };
      data: {
        mode: "ALL" | "DISTINCT";
        inputs: string[];
        columns: { to: string; from: Record<string, string | null> }[];
      };
    }
  | {
      id: string;
      type: "join";
      position: { x: number; y: number };
      data: { conditions: { leftKey: string; rightKey: string }[] };
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

  // A stage whose top-level shape is `... UNION [ALL] ...` splits into one
  // sub-node per branch feeding a native Union node, instead of one big
  // opaque box — tried only for stages that aren't already a simple single-
  // table SELECT (which a union-shaped body could never match anyway, since
  // its grammar requires exactly one SELECT ... FROM ... up to EOF).
  const unionSplits = new Map<string, ReturnType<typeof splitTopLevelUnion>>();
  for (const stage of stages) {
    if (simplePlans.has(stage.name)) continue;
    const split = splitTopLevelUnion(
      stage.body,
      [...stageNames].filter((n) => n !== stage.name),
    );
    if (split) unionSplits.set(stage.name, split);
  }
  // Same "drop anything that isn't a real, currently-introspectable table"
  // rule as the stage-level tableRefs filtering above, applied per branch —
  // a branch's own tableRefs are computed fresh by splitTopLevelUnion and
  // haven't been through that filter yet.
  for (const split of unionSplits.values()) {
    for (const branch of split!.branches) {
      branch.tableRefs = branch.tableRefs.filter((t) => knownTableKeys.has(`${t.schema}.${t.table}`));
    }
  }

  // Real table columns, keyed the same way as knownTableKeys — used to
  // auto-populate a split-by-union stage's Union node column mapping when a
  // branch's shape is simple enough to know its output columns without
  // running anything (see buildUnionBranch's `knownColumns` below).
  const tableColumnsMap = new Map<string, string[]>();
  for (const t of knownTables) {
    tableColumnsMap.set(`${t.schema}.${t.name}`, t.columns.map((c) => c.name));
  }

  // A stage shaped like `SELECT <list> FROM t1 JOIN t2 ON ... [WHERE ...]
  // [ORDER BY ...] [LIMIT ...]` decomposes into a chain of native Join
  // nodes instead of one opaque box — tried only for stages that are
  // neither a single-table SELECT nor a top-level union (both already
  // excluded above; a join-shaped body could never match either anyway).
  const joinChainPlans = new Map<string, JoinChainPlan>();
  for (const stage of stages) {
    if (simplePlans.has(stage.name) || unionSplits.has(stage.name)) continue;
    const plan = tryParseJoinChain(stage.body, stageNames);
    if (!plan) continue;
    const allFromsValid = [plan.base.from, ...plan.joins.map((j) => j.from)].every(
      (f) => "cteName" in f || knownTableKeys.has(`${f.schema}.${f.table}`),
    );
    if (!allFromsValid) continue;
    joinChainPlans.set(stage.name, plan);
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
  // A stage's own output columns, when they're knowable without running
  // anything (only ever set for a fully-native stage/branch) — used to
  // auto-populate a downstream union's column mapping. Absent/null means
  // "unknown until run once", same convention as a sql node's detectedColumns.
  const stageKnownColumns = new Map<string, string[] | null>();

  /**
   * Builds one branch of a split-by-union stage: the same native-simple-
   * select-or-opaque choice a whole stage gets, just for one UNION arm.
   * Never referenced by name from elsewhere (a union branch has no name of
   * its own in the original SQL), so `neededLabel` never applies here and an
   * opaque branch's label only needs to be unique, not meaningful.
   */
  async function buildUnionBranch(
    branch: UnionBranch,
    branchIndex: number,
    stageName: string,
    layer: number,
    y: number,
  ): Promise<{
    nodes: ImportedNode[];
    edges: ImportedEdge[];
    outputNodeId: string;
    outputHandle: string | undefined;
    knownColumns: string[] | null;
    // Position i is true when that output column is a bare NULL literal in
    // this branch's own text — see findNullLiteralSelectItems. Undefined
    // (native happy path) means "never applicable", not "no nulls".
    nullLiteralPositions?: boolean[];
  }> {
    const plan = tryParseSimpleSelect(branch.body, stageNames);
    const validPlan =
      plan && (!("schema" in plan.from) || knownTableKeys.has(`${plan.from.schema}.${plan.from.table}`))
        ? plan
        : null;

    if (validPlan) {
      let inputNodeId: string;
      let inputHandle: string | undefined;
      if ("cteName" in validPlan.from) {
        const upstream = stageOutput.get(validPlan.from.cteName);
        if (!upstream) {
          throw new ImportError(
            `A branch of "${stageName}" reads from "${validPlan.from.cteName}" before it's defined`,
          );
        }
        inputNodeId = upstream.nodeId;
        inputHandle = upstream.handle;
      } else {
        inputNodeId = sourceNodeId(validPlan.from);
        inputHandle = undefined;
      }
      const chain = buildNativeChain(validPlan, inputNodeId, inputHandle, layer * 280, y, undefined);
      const knownColumns: string[] | null = !validPlan.selectAll
        ? validPlan.selectItems.map((i) => i.alias)
        : "schema" in validPlan.from
          ? (tableColumnsMap.get(`${validPlan.from.schema}.${validPlan.from.table}`) ?? null)
          : (stageKnownColumns.get(validPlan.from.cteName) ?? null);
      return {
        nodes: chain.nodes,
        edges: chain.edges,
        outputNodeId: chain.outputNodeId,
        outputHandle: chain.outputHandle,
        knownColumns,
      };
    }

    const joinChainPlan = tryParseJoinChain(branch.body, stageNames);
    const validJoinChainPlan =
      joinChainPlan &&
      [joinChainPlan.base.from, ...joinChainPlan.joins.map((j) => j.from)].every(
        (f) => "cteName" in f || knownTableKeys.has(`${f.schema}.${f.table}`),
      )
        ? joinChainPlan
        : null;

    if (validJoinChainPlan) {
      const result = await buildJoinChainChain(
        validJoinChainPlan,
        `${stageName}_u${branchIndex}`,
        branch.body,
        branch.dependsOn,
        branch.tableRefs,
        undefined,
        layer * 280,
        y,
      );
      if (result) return result;
      // Couldn't resolve some table's known columns (e.g. a sibling CTE
      // that's itself still fully opaque) — fall through to the opaque
      // fallback below, nothing lost.
    }

    // Fall back to an opaque sql node holding this branch's verbatim text.
    const opaqueId = `sql_${stageName}_u${branchIndex}`;
    const opaqueLabel = `${stageName}_u${branchIndex}`;
    const branchNodes: ImportedNode[] = [
      {
        id: opaqueId,
        type: "sql",
        position: { x: layer * 280, y },
        data: {
          sql: branch.body,
          label: opaqueLabel,
          dependsOn: [
            ...branch.dependsOn.filter((d) => stageNames.has(d)),
            ...branch.tableRefs.map((t) => t.table),
          ],
          detectedColumns: [],
        },
      },
    ];
    const branchEdges: ImportedEdge[] = [];
    for (const dep of branch.dependsOn) {
      if (!stageNames.has(dep)) continue;
      const upstream = stageOutput.get(dep);
      if (!upstream) {
        throw new ImportError(`A branch of "${stageName}" reads from "${dep}" before it's defined`);
      }
      branchEdges.push({
        id: `${upstream.nodeId}->${opaqueId}`,
        source: upstream.nodeId,
        target: opaqueId,
        targetHandle: dep,
        sourceHandle: upstream.handle,
        kind: "dependency",
      });
    }
    for (const ref of branch.tableRefs) {
      branchEdges.push({
        id: `${sourceNodeId(ref)}->${opaqueId}`,
        source: sourceNodeId(ref),
        target: opaqueId,
        targetHandle: ref.table,
        kind: "reference",
      });
    }

    // An opaque branch's real columns can't be known from its text alone —
    // unlike a native branch, whose SELECT list is already fully parsed.
    // Reuse the exact same compile-and-describe path a `sql` node's own
    // preview run would take (compileGraph's sql-node handling calls
    // describeColumns internally), scoped to just this branch and whatever
    // it depends on, so the union's column mapping can still be
    // auto-populated instead of leaving the analyst to run every branch by
    // hand before the final combined result is even wireable. Best-effort:
    // any failure here (e.g. this branch genuinely can't compile in
    // isolation for some reason) just means the mapping stays empty for
    // manual configuration — the import itself still succeeds.
    let knownColumns: string[] | null = null;
    try {
      const probe = await compileGraph(
        [...nodes, ...branchNodes] as unknown as GraphNode[],
        [...edges, ...branchEdges] as unknown as GraphEdge[],
        opaqueId,
      );
      knownColumns = probe.columns.map((c) => c.outputName);
    } catch {
      knownColumns = null;
    }

    return {
      nodes: branchNodes,
      edges: branchEdges,
      outputNodeId: opaqueId,
      outputHandle: undefined,
      knownColumns,
      nullLiteralPositions: findNullLiteralSelectItems(branch.body) ?? undefined,
    };
  }

  function resolveJoinChainFrom(from: JoinChainFrom): { nodeId: string; handle: string | undefined } | null {
    if ("cteName" in from) return stageOutput.get(from.cteName) ?? null;
    return { nodeId: sourceNodeId(from), handle: undefined };
  }

  function knownColumnsForFrom(from: JoinChainFrom): string[] | null {
    if ("cteName" in from) return stageKnownColumns.get(from.cteName) ?? null;
    return tableColumnsMap.get(`${from.schema}.${from.table}`) ?? null;
  }

  /**
   * Builds a chain of native Join nodes (INNER -> just the "matched"
   * branch; LEFT/RIGHT/FULL -> a native Union of the relevant branches,
   * whose column sets are always identical across a single join's branches
   * so the mapping is trivial identity) off of `plan`'s base table, tracking
   * each alias's columns' *current* compiled name (compileJoin's own
   * left_/right_ prefixing, computed here so no DB round-trip is needed to
   * know it) so the trailing SELECT list can be resolved against it.
   *
   * Returns null when some table's columns aren't known without running
   * anything (e.g. the chain reads from a sibling CTE that's itself still
   * fully opaque) — the caller falls back to the existing opaque node with
   * nothing lost, same as any other "not confident enough" bail elsewhere
   * in this importer.
   */
  /**
   * Probes an arbitrary already-wired node's real output columns — the same
   * compile-and-describe path a `sql` node's own preview run takes, applied
   * to whatever's in `extraNodes`/`extraEdges` on top of everything compiled
   * so far. Used both for an opaque union branch (buildUnionBranch) and for
   * getting Postgres's own authoritative column names for a chunk of
   * verbatim SQL (buildJoinChainChain's fallback path, below).
   */
  async function probeColumns(
    targetId: string,
    extraNodes: ImportedNode[],
    extraEdges: ImportedEdge[],
  ): Promise<string[] | null> {
    try {
      const probe = await compileGraph(
        [...nodes, ...extraNodes] as unknown as GraphNode[],
        [...edges, ...extraEdges] as unknown as GraphEdge[],
        targetId,
      );
      return probe.columns.map((c) => c.outputName);
    } catch {
      return null;
    }
  }

  async function buildJoinChainChain(
    plan: JoinChainPlan,
    stageName: string,
    originalBody: string,
    originalDependsOn: string[],
    originalTableRefs: TableRef[],
    neededLabel: string | undefined,
    baseX: number,
    y: number,
  ): Promise<{
    nodes: ImportedNode[];
    edges: ImportedEdge[];
    outputNodeId: string;
    outputHandle: string | undefined;
    knownColumns: string[] | null;
    nullLiteralPositions?: boolean[];
  } | null> {
    const baseInput = resolveJoinChainFrom(plan.base.from);
    const baseCols = knownColumnsForFrom(plan.base.from);
    if (!baseInput || !baseCols) return null;

    const chainNodes: ImportedNode[] = [];
    const chainEdges: ImportedEdge[] = [];
    let currentId = baseInput.nodeId;
    let currentHandle = baseInput.handle;
    let x = baseX;

    const tracking = new Map<string, Map<string, string>>();
    tracking.set(plan.base.alias, new Map(baseCols.map((c) => [c, c])));

    for (const step of plan.joins) {
      const rightInput = resolveJoinChainFrom(step.from);
      const rightCols = knownColumnsForFrom(step.from);
      if (!rightInput || !rightCols) return null;

      const joinId = nextNativeId("join");
      const resolvedConditions: { leftKey: string; rightKey: string }[] = [];
      for (const c of step.conditions) {
        const leftKey = tracking.get(c.leftAlias)?.get(c.leftCol);
        if (leftKey === undefined) return null;
        resolvedConditions.push({ leftKey, rightKey: c.rightCol });
      }

      chainNodes.push({
        id: joinId,
        type: "join",
        position: { x, y },
        data: { conditions: resolvedConditions },
      });
      chainEdges.push({
        id: `${currentId}->${joinId}:left`,
        source: currentId,
        target: joinId,
        sourceHandle: currentHandle,
        targetHandle: "left",
        kind: "dependency",
      });
      chainEdges.push({
        id: `${rightInput.nodeId}->${joinId}:right`,
        source: rightInput.nodeId,
        target: joinId,
        sourceHandle: rightInput.handle,
        targetHandle: "right",
        kind: "dependency",
      });
      x += 240;

      // Mirrors compileJoin's own prefixing: every alias tracked so far
      // moves to the "left_" side, the table just joined becomes the
      // "right_" side.
      for (const [alias, cols] of tracking) {
        tracking.set(alias, new Map([...cols].map(([orig, cur]) => [orig, "left_" + cur])));
      }
      tracking.set(step.alias, new Map(rightCols.map((c) => [c, "right_" + c])));

      if (step.type === "INNER") {
        currentId = joinId;
        currentHandle = "matched";
      } else {
        const branches =
          step.type === "LEFT"
            ? ["matched", "left_only"]
            : step.type === "RIGHT"
              ? ["matched", "right_only"]
              : ["matched", "left_only", "right_only"];
        const allCols = [...tracking.values()].flatMap((m) => [...m.values()]);
        const unionId = nextNativeId("union");
        const unionInputs = branches.map((_, i) => `in${i}`);
        chainNodes.push({
          id: unionId,
          type: "union",
          position: { x, y },
          data: {
            mode: "ALL",
            inputs: unionInputs,
            columns: allCols.map((name) => ({
              to: name,
              from: Object.fromEntries(unionInputs.map((h) => [h, name])),
            })),
          },
        });
        branches.forEach((branch, i) => {
          chainEdges.push({
            id: `${joinId}:${branch}->${unionId}`,
            source: joinId,
            target: unionId,
            sourceHandle: branch,
            targetHandle: `in${i}`,
            kind: "dependency",
          });
        });
        x += 240;
        currentId = unionId;
        currentHandle = undefined;
      }

      // Rename every tracked column to a short, bounded-length synthetic
      // name right away. Without this, left_/right_ prefixes stack up with
      // every join step, and a long enough chain (8+ joins on real files)
      // exceeds Postgres's 63-byte identifier limit — two different
      // columns silently truncate to the same name and become ambiguous.
      // Keeping names short and flat after each step means depth never
      // matters, however many joins are chained.
      const entries: { alias: string; orig: string }[] = [];
      for (const [alias, cols] of tracking) {
        for (const orig of cols.keys()) entries.push({ alias, orig });
      }
      const shortenId = nextNativeId("select");
      const shortenMappings = entries.map((e, i) => ({
        from: tracking.get(e.alias)!.get(e.orig)!,
        to: `c${i}`,
        // `e.alias`/`e.orig` are the table alias and column name from the
        // moment this column first entered the chain, and never change
        // afterwards — unlike `from`, which after the first rename is just
        // the previous step's own `c{i}`. Carrying this forward is what lets
        // a display label stay meaningful arbitrarily deep into the chain.
        sourceLabel: `${e.alias}.${e.orig}`,
      }));
      chainNodes.push({
        id: shortenId,
        type: "select",
        position: { x, y },
        data: { mappings: shortenMappings },
      });
      chainEdges.push({
        id: `${currentId}->${shortenId}`,
        source: currentId,
        target: shortenId,
        sourceHandle: currentHandle,
        kind: "dependency",
      });
      entries.forEach((e, i) => tracking.get(e.alias)!.set(e.orig, `c${i}`));
      currentId = shortenId;
      currentHandle = undefined;
      x += 240;
    }

    function resolve(alias: string, column: string): string | null {
      return tracking.get(alias)?.get(column) ?? null;
    }

    if (plan.selectItems) {
      const selectItems = plan.selectItems.map((i) => ({ column: resolve(i.qualifier, i.column), alias: i.alias }));
      const filterConditions = plan.filter
        ? plan.filter.conditions.map((c) => ({
            column: resolve(c.qualifier, c.column),
            operator: c.operator,
            value: c.value,
          }))
        : null;
      const sortFields = plan.sort
        ? plan.sort.map((s) => ({ column: resolve(s.qualifier, s.column), direction: s.direction }))
        : null;
      const anyUnresolved =
        selectItems.some((i) => i.column === null) ||
        (filterConditions?.some((c) => c.column === null) ?? false) ||
        (sortFields?.some((s) => s.column === null) ?? false);
      if (anyUnresolved) return null; // a resolve() came back empty — bail to opaque rather than emit broken SQL

      const fakePlan: SimpleSelectPlan = {
        from: plan.base.from,
        selectAll: false,
        selectItems: selectItems as { column: string; alias: string }[],
        filter: filterConditions
          ? { conjunction: plan.filter!.conjunction, conditions: filterConditions as any }
          : null,
        sort: sortFields as { column: string; direction: "ASC" | "DESC" }[] | null,
        limit: plan.limit,
      };
      const chain = buildNativeChain(fakePlan, currentId, currentHandle, x, y, neededLabel);
      return {
        nodes: [...chainNodes, ...chain.nodes],
        edges: [...chainEdges, ...chain.edges],
        outputNodeId: chain.outputNodeId,
        outputHandle: chain.outputHandle,
        knownColumns: fakePlan.selectItems.map((i) => i.alias),
      };
    }

    // Fallback: the select list has real expressions this grammar can't
    // parse. Push understood WHERE/ORDER BY into native Filter/Sort ahead of
    // one small synthetic sql node holding just the (qualifier-rewritten)
    // select list, then LIMIT after — LIMIT always applies to the final
    // projected/sorted result, never to a pre-projection row.
    if (plan.filter) {
      const conditions = plan.filter.conditions.map((c) => ({
        column: resolve(c.qualifier, c.column),
        operator: c.operator,
        value: c.value,
      }));
      if (conditions.some((c) => c.column === null)) return null;
      const filterId = nextNativeId("filter");
      chainNodes.push({
        id: filterId,
        type: "filter",
        position: { x, y },
        data: { conjunction: plan.filter.conjunction, conditions: conditions as any },
      });
      chainEdges.push({
        id: `${currentId}->${filterId}`,
        source: currentId,
        target: filterId,
        sourceHandle: currentHandle,
        kind: "dependency",
      });
      currentId = filterId;
      currentHandle = "true";
      x += 240;
    }
    if (plan.sort && plan.sort.length > 0) {
      const fields = plan.sort.map((s) => ({ column: resolve(s.qualifier, s.column), direction: s.direction }));
      if (fields.some((f) => f.column === null)) return null;
      const sortId = nextNativeId("sort");
      chainNodes.push({ id: sortId, type: "sort", position: { x, y }, data: { fields: fields as any } });
      chainEdges.push({
        id: `${currentId}->${sortId}`,
        source: currentId,
        target: sortId,
        sourceHandle: currentHandle,
        kind: "dependency",
      });
      currentId = sortId;
      currentHandle = undefined;
      x += 240;
    }

    const tailLabel = `${stageName}_chain`;
    chainNodes[chainNodes.length - 1].label = tailLabel;

    function resolveStar(alias: string): string[] | null {
      const cols = tracking.get(alias);
      return cols ? [...cols.values()] : null;
    }
    const rewritten = rewriteQualifiedColumns(plan.rawSelectListText, resolve, resolveStar);
    const syntheticId = nextNativeId("sql");
    chainNodes.push({
      id: syntheticId,
      type: "sql",
      position: { x, y },
      data: {
        // Always its own synthetic name — a sql node's `data.label` is a
        // required internal CTE identifier, not necessarily this stage's
        // *public* name: if a rename Select or Limit ends up after it (see
        // below), `neededLabel` belongs on whichever node is actually last,
        // exactly like buildNativeChain's own convention.
        sql: `SELECT ${rewritten} FROM ${quoteIdent(tailLabel)}`,
        label: `${stageName}_raw`,
        dependsOn: [tailLabel],
        detectedColumns: [],
      },
    });
    chainEdges.push({
      id: `${currentId}->${syntheticId}`,
      source: currentId,
      target: syntheticId,
      sourceHandle: currentHandle,
      targetHandle: tailLabel,
      kind: "dependency",
    });
    currentId = syntheticId;
    currentHandle = undefined;
    x += 240;

    // A select item with no explicit alias relies on Postgres's own
    // "unaliased alias.column -> bare column name" naming convention — but
    // after substituting the qualifier for its mangled tracked name, that
    // same convention would now name the output column after the MANGLED
    // name instead of the analyst's original intent (e.g. `e."TotAssetsUSD"`
    // with no alias should produce a column named "TotAssetsUSD", not
    // "left_left_...TotAssetsUSD"). Rather than replicate Postgres's own
    // (fairly intricate) unaliased-expression naming rules by hand, probe
    // BOTH the synthetic node (what it actually produced) and the stage's
    // untouched original body (what Postgres would have called it) and
    // rename positionally — correct regardless of how each item is written,
    // aliased or not.
    const [actualNames, authoritativeNames] = await Promise.all([
      probeColumns(syntheticId, chainNodes, chainEdges),
      (async () => {
        const probeId = `probe_${stageName}`;
        const probeNode: ImportedNode = {
          id: probeId,
          type: "sql",
          position: { x: 0, y: 0 },
          data: { sql: originalBody, label: probeId, dependsOn: [], detectedColumns: [] },
        };
        const probeEdges: ImportedEdge[] = [];
        for (const dep of originalDependsOn) {
          if (!stageNames.has(dep)) continue;
          const upstream = stageOutput.get(dep);
          if (!upstream) return null;
          probeEdges.push({
            id: `${upstream.nodeId}->${probeId}`,
            source: upstream.nodeId,
            target: probeId,
            targetHandle: dep,
            sourceHandle: upstream.handle,
            kind: "dependency",
          });
        }
        for (const ref of originalTableRefs) {
          probeEdges.push({
            id: `${sourceNodeId(ref)}->${probeId}`,
            source: sourceNodeId(ref),
            target: probeId,
            targetHandle: ref.table,
            kind: "reference",
          });
        }
        return probeColumns(probeId, [probeNode], probeEdges);
      })(),
    ]);

    let knownColumns: string[] | null = null;
    if (actualNames && authoritativeNames && actualNames.length === authoritativeNames.length) {
      const renameId = nextNativeId("select");
      chainNodes.push({
        id: renameId,
        type: "select",
        position: { x, y },
        data: { mappings: actualNames.map((from, i) => ({ from, to: authoritativeNames[i] })) },
      });
      chainEdges.push({
        id: `${syntheticId}->${renameId}`,
        source: syntheticId,
        target: renameId,
        kind: "dependency",
      });
      currentId = renameId;
      currentHandle = undefined;
      knownColumns = authoritativeNames;
    }
    // If the probe failed or the column counts disagree (shouldn't happen
    // for valid SQL, but best-effort is best-effort), the chain still works
    // — it just keeps whatever names the synthetic node's own unaliased
    // items happened to get, same risk profile as an ordinary opaque node
    // whose columns are only knowable by running it.
    x += 240;

    if (plan.limit !== null) {
      const limitId = nextNativeId("limit");
      chainNodes.push({ id: limitId, type: "limit", position: { x, y }, data: { count: plan.limit } });
      chainEdges.push({
        id: `${currentId}->${limitId}`,
        source: currentId,
        target: limitId,
        sourceHandle: currentHandle,
        kind: "dependency",
      });
      currentId = limitId;
      currentHandle = undefined;
      // Limit doesn't change columns — knownColumns from the rename step
      // (or lack thereof) still applies.
    }

    if (neededLabel) chainNodes[chainNodes.length - 1].label = neededLabel;

    return {
      nodes: chainNodes,
      edges: chainEdges,
      outputNodeId: currentId,
      outputHandle: currentHandle,
      knownColumns,
      nullLiteralPositions: plan.nullLiteralPositions,
    };
  }

  const countPerLayer = new Map<number, number>();
  for (const stage of stages) {
    const layer = layerOf.get(stage.name)! + 1; // +1 to make room for Source nodes at layer 0
    const plan = simplePlans.get(stage.name);
    const unionSplit = unionSplits.get(stage.name);

    if (unionSplit) {
      const branchOutputs: Awaited<ReturnType<typeof buildUnionBranch>>[] = [];
      for (let i = 0; i < unionSplit.branches.length; i++) {
        const index = countPerLayer.get(layer) ?? 0;
        const result = await buildUnionBranch(unionSplit.branches[i], i, stage.name, layer, index * 160);
        if (result.nodes.length > 0) countPerLayer.set(layer, index + 1);
        nodes.push(...result.nodes);
        edges.push(...result.edges);
        branchOutputs.push(result);
      }

      const unionLayer = layer + 1;
      const unionIndex = countPerLayer.get(unionLayer) ?? 0;
      countPerLayer.set(unionLayer, unionIndex + 1);
      const unionId = `union_${stage.name}`;
      const inputs = branchOutputs.map((_, i) => `in${i}`);

      // Only auto-populate the column mapping when every branch's output
      // columns are known without running anything, and they all agree on
      // column count — otherwise leave it empty (the union node still
      // compiles; it just needs "+ Add output column" filled in by hand
      // after running each branch once, same as any other sql node's
      // detectedColumns bootstrapping).
      const allKnown = branchOutputs.every((b) => b.knownColumns !== null);
      const sameLength =
        allKnown &&
        branchOutputs.every((b) => b.knownColumns!.length === branchOutputs[0].knownColumns!.length);
      // A bare NULL literal at this position in a branch's own text needs a
      // genuine untyped NULL in the union's SQL, not a reference to a real
      // (concretely, often wrongly, typed) column — see
      // findNullLiteralSelectItems.
      const columns =
        allKnown && sameLength
          ? branchOutputs[0].knownColumns!.map((name, colIdx) => ({
              to: name,
              from: Object.fromEntries(
                inputs.map((h, bi) => [
                  h,
                  branchOutputs[bi].nullLiteralPositions?.[colIdx] ? null : branchOutputs[bi].knownColumns![colIdx],
                ]),
              ),
            }))
          : [];

      const unionNode: ImportedNode = {
        id: unionId,
        type: "union",
        position: { x: unionLayer * 280, y: unionIndex * 160 },
        data: { mode: unionSplit.mode, inputs, columns },
      };
      if (namesReferencedByOpaqueSiblings.has(stage.name)) {
        unionNode.label = stage.name;
      }
      nodes.push(unionNode);
      branchOutputs.forEach((b, i) => {
        edges.push({
          id: `${b.outputNodeId}->${unionId}`,
          source: b.outputNodeId,
          target: unionId,
          targetHandle: `in${i}`,
          sourceHandle: b.outputHandle,
          kind: "dependency",
        });
      });
      stageOutput.set(stage.name, { nodeId: unionId, handle: undefined });
      stageKnownColumns.set(stage.name, allKnown && sameLength ? branchOutputs[0].knownColumns : null);
      continue;
    }

    const joinChainPlan = joinChainPlans.get(stage.name);
    if (joinChainPlan) {
      const index = countPerLayer.get(layer) ?? 0;
      const neededLabel = namesReferencedByOpaqueSiblings.has(stage.name) ? stage.name : undefined;
      const result = await buildJoinChainChain(
        joinChainPlan,
        stage.name,
        stage.body,
        stage.dependsOn,
        stage.tableRefs,
        neededLabel,
        layer * 280,
        index * 160,
      );
      if (result) {
        countPerLayer.set(layer, index + 1);
        nodes.push(...result.nodes);
        edges.push(...result.edges);
        stageOutput.set(stage.name, { nodeId: result.outputNodeId, handle: result.outputHandle });
        stageKnownColumns.set(stage.name, result.knownColumns);
        continue;
      }
      // Couldn't resolve some table's known columns (e.g. this chain reads
      // from a sibling CTE that's itself still fully opaque) — fall through
      // to the fully-opaque path below, nothing lost.
    }

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
      stageKnownColumns.set(
        stage.name,
        !plan.selectAll
          ? plan.selectItems.map((i) => i.alias)
          : "schema" in plan.from
            ? (tableColumnsMap.get(`${plan.from.schema}.${plan.from.table}`) ?? null)
            : (stageKnownColumns.get(plan.from.cteName) ?? null),
      );
      continue;
    }

    // Fall back to an opaque sql node holding the verbatim CTE body.
    const index = countPerLayer.get(layer) ?? 0;
    countPerLayer.set(layer, index + 1);
    const opaqueNode: ImportedNode = {
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
    };
    const opaqueEdges: ImportedEdge[] = [];
    for (const dep of stage.dependsOn) {
      if (!stageNames.has(dep)) continue; // a real table/view reference, not a local CTE
      const upstream = stageOutput.get(dep);
      if (!upstream) {
        throw new ImportError(`"${stage.name}" reads from "${dep}" before it's defined`);
      }
      opaqueEdges.push({
        id: `${upstream.nodeId}->${idOf(stage.name)}`,
        source: upstream.nodeId,
        target: idOf(stage.name),
        targetHandle: dep,
        sourceHandle: upstream.handle,
        kind: "dependency",
      });
    }
    for (const ref of stage.tableRefs) {
      opaqueEdges.push({
        id: `${sourceNodeId(ref)}->${idOf(stage.name)}`,
        source: sourceNodeId(ref),
        target: idOf(stage.name),
        targetHandle: ref.table,
        kind: "reference",
      });
    }
    // A downstream native select/union may reference this stage's columns by
    // name without ever running anything first (e.g. a native `SELECT *
    // FROM this_cte` passthrough, or a split-by-union branch built the same
    // way) — probe once now so that works instead of requiring a manual
    // "run it, then map columns by hand" step. Best-effort: any failure
    // just means downstream consumers fall back to their own empty-mapping
    // safety net, same as before this existed. Probed BEFORE pushing into
    // the shared `nodes`/`edges` arrays — probeColumns adds its own copy on
    // top of whatever's already there, so pushing first would double it up.
    const knownColumns = await probeColumns(idOf(stage.name), [opaqueNode], opaqueEdges);
    nodes.push(opaqueNode);
    edges.push(...opaqueEdges);
    stageOutput.set(stage.name, { nodeId: idOf(stage.name), handle: undefined });
    stageKnownColumns.set(stage.name, knownColumns);
  }

  return { nodes, edges };
}
