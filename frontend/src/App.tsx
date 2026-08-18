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
import { currentUser, fetchSchema, logout, runGraph, type RunGraphResponse } from "./api";
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

  function updateNodeData(nodeId: string, data: unknown) {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: data as any } : n)));
  }

  function deleteNode(nodeId: string) {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    if (selectedId === nodeId) {
      setSelectedId(null);
      setResult(null);
    }
  }

  async function runPreview(nodeId: string, branch: string) {
    setRunning(true);
    setRunError(null);
    try {
      const res = await runGraph({
        nodes: nodes.map((n) => ({ id: n.id, type: n.type!, data: n.data })),
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        })),
        targetNodeId: nodeId,
        targetHandle: branch,
        limit: 200,
      });
      setResult(res);
    } catch (err) {
      setRunError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function selectNode(nodeId: string) {
    setSelectedId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    const branches = node ? branchesFor(node.type as EtlNodeType) : [];
    const branch = branches[0]?.id ?? DEFAULT_BRANCH;
    setActiveBranch(branch);
    runPreview(nodeId, branch);
  }

  function changeBranch(branch: string) {
    setActiveBranch(branch);
    if (selectedId) runPreview(selectedId, branch);
  }

  function saveGraph() {
    const payload = {
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
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

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const branches: Branch[] = selectedNode
    ? branchesFor(selectedNode.type as EtlNodeType)
    : [];

  return (
    <div className="app">
      <div className="toolbar">
        <span className="toolbar__brand">Visual ETL</span>
        {ADDABLE_TYPES.map((t) => (
          <button key={t.type} className="btn" onClick={() => addNode(t.type)}>
            + {t.label}
          </button>
        ))}
        <div className="toolbar__spacer" />
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
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => selectNode(node.id)}
            onPaneClick={() => {
              setSelectedId(null);
              setResult(null);
            }}
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
        selectedNodeId={selectedId}
        branches={branches}
        activeBranch={activeBranch}
        onBranchChange={changeBranch}
        running={running}
        error={runError}
        result={result}
        onRun={() => selectedId && runPreview(selectedId, activeBranch)}
      />
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
