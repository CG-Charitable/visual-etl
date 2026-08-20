import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { nodeTypes } from "./nodes";
import { SchemaBrowser } from "./components/SchemaBrowser";
import { Inspector } from "./components/Inspector";
import { ResultsPanel } from "./components/ResultsPanel";
import { Login } from "./components/Login";
import { ImportSqlModal } from "./components/ImportSqlModal";
import { SettingsModal } from "./components/SettingsModal";
import { ContextMenu } from "./components/ContextMenu";
import {
  currentUser,
  fetchSchema,
  logout,
  runGraph,
  runGraphCount,
  type RunGraphResponse,
  type ImportedGraph,
} from "./api";
import {
  branchesFor,
  defaultDataFor,
  DEFAULT_BRANCH,
  type Branch,
  type EtlNodeType,
  type SchemaTable,
} from "./types";
import "./styles.css";

let nodeIdCounter = 0;
function nextId(prefix: string) {
  nodeIdCounter += 1;
  return `${prefix}_${Date.now()}_${nodeIdCounter}`;
}

const ADDABLE_TYPES: { type: EtlNodeType; label: string }[] = [
  { type: "select", label: "Select" },
  { type: "filter", label: "Filter" },
  { type: "join", label: "Join" },
  { type: "aggregate", label: "Aggregate" },
  { type: "sort", label: "Sort" },
  { type: "limit", label: "Limit" },
  { type: "union", label: "Union" },
];

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeBranch, setActiveBranch] = useState<string>(DEFAULT_BRANCH);
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunGraphResponse | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [countingRows, setCountingRows] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSourceLines, setShowSourceLines] = useState(true);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; flowPosition: { x: number; y: number }; nodeId?: string } | null
  >(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    fetchSchema()
      .then((res) => setSchema(res.tables))
      .catch((err) => setSchemaError((err as Error).message))
      .finally(() => setSchemaLoading(false));
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const { clientX, clientY } = e as React.MouseEvent;
      setContextMenu({
        x: clientX,
        y: clientY,
        flowPosition: screenToFlowPosition({ x: clientX, y: clientY }),
      });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      if (node.type === "comment") return;
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        flowPosition: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        nodeId: node.id,
      });
    },
    [screenToFlowPosition],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-etl-table");
      if (!raw) return;
      const { schema: schemaName, table } = JSON.parse(raw);
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = nextId("source");
      setNodes((nds) => [
        ...nds,
        {
          id,
          type: "source",
          position,
          data: { schema: schemaName, table, columns: [] } as Record<string, unknown>,
        } satisfies Node,
      ]);
    },
    [screenToFlowPosition, setNodes],
  );

  function addNode(type: EtlNodeType) {
    const id = nextId(type);
    const wrapper = wrapperRef.current;
    const center = wrapper
      ? screenToFlowPosition({
          x: wrapper.getBoundingClientRect().left + wrapper.clientWidth / 2,
          y: wrapper.getBoundingClientRect().top + wrapper.clientHeight / 2,
        })
      : { x: 0, y: 0 };
    setNodes((nds) => [
      ...nds,
      {
        id,
        type,
        position: { x: center.x + Math.random() * 60 - 30, y: center.y + Math.random() * 60 - 30 },
        data: defaultDataFor(type) as unknown as Record<string, unknown>,
      } satisfies Node,
    ]);
  }

  // A comment is a canvas-only annotation, not an EtlNodeType — it's never
  // compiled (see graphPayload), so it's added separately from addNode
  // rather than being one more entry in ADDABLE_TYPES.
  // `opts` lets the right-click context menu override where/what a comment
  // attaches to; a plain call (the toolbar "+ Comment" button) keeps the
  // original behavior of attaching to whatever's currently selected.
  function addComment(opts?: { position?: { x: number; y: number }; attachedNodeId?: string }) {
    const id = nextId("comment");
    const targetId = opts ? opts.attachedNodeId : (selectedId ?? undefined);
    const attachedTo = targetId ? (nodes.find((n) => n.id === targetId) ?? null) : null;
    let position: { x: number; y: number };
    if (attachedTo) {
      // Straight above with enough clearance to sit clear of the target
      // node's own box instead of overlapping it (nodes run up to ~240px
      // wide, ~140px tall including a comment's own header+textarea).
      position = { x: attachedTo.position.x, y: attachedTo.position.y - 160 };
    } else if (opts?.position) {
      position = opts.position;
    } else {
      const wrapper = wrapperRef.current;
      const center = wrapper
        ? screenToFlowPosition({
            x: wrapper.getBoundingClientRect().left + wrapper.clientWidth / 2,
            y: wrapper.getBoundingClientRect().top + wrapper.clientHeight / 2,
          })
        : { x: 0, y: 0 };
      position = { x: center.x + Math.random() * 60 - 30, y: center.y + Math.random() * 60 - 30 };
    }
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "comment",
        position,
        data: {
          text: "",
          collapsed: false,
          attachedNodeId: attachedTo?.id ?? null,
        } as Record<string, unknown>,
      } satisfies Node,
    ]);
  }

  function updateNodeData(nodeId: string, data: unknown) {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: data as any } : n)));
  }

  function deleteNode(nodeId: string) {
    setNodes((nds) =>
      nds
        .filter((n) => n.id !== nodeId)
        // A comment attached to the node being deleted just goes unattached,
        // rather than pointing at an id that no longer exists.
        .map((n) =>
          n.type === "comment" && (n.data as any)?.attachedNodeId === nodeId
            ? { ...n, data: { ...(n.data as any), attachedNodeId: null } }
            : n,
        ),
    );
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    if (selectedId === nodeId) {
      setSelectedId(null);
      setResult(null);
    }
  }

  function graphPayload() {
    // Comments are canvas-only annotations the compiler doesn't know about
    // — never sent as part of the pipeline being run.
    const compileNodes = nodes.filter((n) => n.type !== "comment");
    const compileIds = new Set(compileNodes.map((n) => n.id));
    return {
      nodes: compileNodes.map((n) => ({
        id: n.id,
        type: n.type!,
        data: n.data,
        label: (n as any).label,
      })),
      edges: edges
        .filter((e) => compileIds.has(e.source) && compileIds.has(e.target))
        .map((e) => ({
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          kind: (e.data as any)?.kind,
        })),
    };
  }

  async function runPreview(nodeId: string, branch: string) {
    setRunning(true);
    setRunError(null);
    setRowCount(null);
    try {
      const res = await runGraph({
        ...graphPayload(),
        targetNodeId: nodeId,
        targetHandle: branch,
        limit: 200,
      });
      setResult(res);
      // A sql node's output columns aren't known statically — record what we
      // just learned so downstream dropdowns (and this node's own inspector)
      // can use them without another round trip.
      const node = nodes.find((n) => n.id === nodeId);
      if (node?.type === "sql") {
        updateNodeData(nodeId, {
          ...(node.data as any),
          detectedColumns: res.columns.map((c) => c.outputName),
        });
      }
    } catch (err) {
      setRunError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function runRowCount() {
    if (!selectedId) return;
    setCountingRows(true);
    try {
      const res = await runGraphCount({
        ...graphPayload(),
        targetNodeId: selectedId,
        targetHandle: activeBranch,
      });
      setRowCount(res.count);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setCountingRows(false);
    }
  }

  function selectNode(nodeId: string) {
    setSelectedId(nodeId);
    setRowCount(null);
    const node = nodes.find((n) => n.id === nodeId);
    // Comments aren't compilable — nothing to preview.
    if (node?.type === "comment") {
      setResult(null);
      setRunError(null);
      return;
    }
    const branches = node ? branchesFor(node.type as EtlNodeType) : [];
    const branch = branches[0]?.id ?? DEFAULT_BRANCH;
    setActiveBranch(branch);
    runPreview(nodeId, branch);
  }

  function changeBranch(branch: string) {
    setActiveBranch(branch);
    setRowCount(null);
    if (selectedId) runPreview(selectedId, branch);
  }

  function handleImported(graph: ImportedGraph) {
    const offsetX = nodes.length > 0 ? Math.max(...nodes.map((n) => n.position.x)) + 320 : 0;
    setNodes((nds) => [
      ...nds,
      ...graph.nodes.map(
        (n) =>
          ({
            id: n.id,
            type: n.type,
            position: { x: n.position.x + offsetX, y: n.position.y },
            data: n.data as Record<string, unknown>,
            // Not part of React Flow's Node type — carried through verbatim
            // by updateNodeData (which only ever touches `data`) and
            // flattened back out in graphPayload() for the compiler.
            label: n.label,
          }) as unknown as Node,
      ),
    ]);
    setEdges((eds) => [
      ...eds,
      ...graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        targetHandle: e.targetHandle,
        sourceHandle: e.sourceHandle,
        data: { kind: e.kind },
        // Reference edges are visual lineage only (a real table wired into
        // a sql node that already names it directly) — dashed to read as
        // informational, not a real data dependency.
        ...(e.kind === "reference"
          ? { style: { strokeDasharray: "4 4", stroke: "#bbb" } }
          : {}),
      })),
    ]);
  }

  function saveGraph() {
    const payload = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        // Not part of React Flow's Node type — see handleImported/graphPayload
        // for why this is carried as a top-level sibling of `data` rather
        // than inside it. Dropping it here breaks any sql node that
        // references a native chain's tail CTE by this name.
        label: (n as any).label,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        data: e.data,
        style: e.style,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadGraph(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      const parsed = JSON.parse(text);
      setNodes(parsed.nodes ?? []);
      setEdges(parsed.edges ?? []);
      setSelectedId(null);
      setResult(null);
    });
    e.target.value = "";
  }

  // Reference edges (source-line lineage) can be hidden without dropping them
  // from state — a plain `hidden` flag on the rendered edge, computed fresh
  // each render, keeps saveGraph/onEdgesChange working off the real edges.
  const displayEdges = showSourceLines
    ? edges
    : edges.map((e) => ((e.data as any)?.kind === "reference" ? { ...e, hidden: true } : e));

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const isCommentSelected = selectedNode?.type === "comment";
  const branches: Branch[] =
    selectedNode && !isCommentSelected ? branchesFor(selectedNode.type as EtlNodeType) : [];

  return (
    <div className="app">
      <div className="toolbar">
        <span className="toolbar__brand">Visual ETL</span>
        {ADDABLE_TYPES.map((t) => (
          <button key={t.type} className="btn" onClick={() => addNode(t.type)}>
            + {t.label}
          </button>
        ))}
        <button className="btn" onClick={addComment}>
          + Comment
        </button>
        <button className="btn" onClick={() => setImportOpen(true)}>
          Import SQL
        </button>
        <div className="toolbar__spacer" />
        <button className="btn btn--icon" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
        <button className="btn" onClick={saveGraph}>
          Save pipeline
        </button>
        <label className="btn btn--file">
          Load pipeline
          <input type="file" accept="application/json" onChange={loadGraph} hidden />
        </label>
        <button className="btn" onClick={() => logout().then(() => window.location.reload())}>
          Log out
        </button>
      </div>
      <div className="app__body">
        <SchemaBrowser tables={schema} loading={schemaLoading} error={schemaError} />
        <div className="canvas-wrap" ref={wrapperRef} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <ReactFlow
            nodes={nodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => selectNode(node.id)}
            onPaneClick={() => {
              setSelectedId(null);
              setResult(null);
              setRowCount(null);
            }}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            onMoveStart={() => setContextMenu(null)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
        {selectedNode && (
          <Inspector
            node={selectedNode}
            nodes={nodes}
            edges={edges}
            schema={schema}
            onChange={updateNodeData}
            onDelete={deleteNode}
          />
        )}
      </div>
      <ResultsPanel
        selectedNodeId={isCommentSelected ? null : selectedId}
        branches={branches}
        activeBranch={activeBranch}
        onBranchChange={changeBranch}
        running={running}
        error={runError}
        result={result}
        onRun={() => selectedId && runPreview(selectedId, activeBranch)}
        rowCount={rowCount}
        countingRows={countingRows}
        onCountRows={runRowCount}
      />
      {importOpen && (
        <ImportSqlModal onClose={() => setImportOpen(false)} onImported={handleImported} />
      )}
      {settingsOpen && (
        <SettingsModal
          showSourceLines={showSourceLines}
          onShowSourceLinesChange={setShowSourceLines}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Add comment",
              onClick: () =>
                addComment(
                  contextMenu.nodeId
                    ? { attachedNodeId: contextMenu.nodeId }
                    : { position: contextMenu.flowPosition },
                ),
            },
          ]}
        />
      )}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    currentUser()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="app-loading">Loading…</div>;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
