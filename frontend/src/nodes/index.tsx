import type { NodeProps } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import type {
  SourceNodeData,
  SelectNodeData,
  FilterNodeData,
  JoinNodeData,
  AggregateNodeData,
  SortNodeData,
  LimitNodeData,
  UnionNodeData,
  SqlNodeData,
  CommentNodeData,
} from "../types";

export function SourceNode({ data, selected }: NodeProps) {
  const d = data as unknown as SourceNodeData;
  return (
    <NodeShell icon="📄" title="Source" selected={selected} hasInput={false}>
      <div className="etl-node__line">
        {d.table ? `${d.schema}.${d.table}` : "(no table selected)"}
      </div>
      <div className="etl-node__sub">
        {d.columns.length > 0 ? `${d.columns.length} columns` : "all columns"}
      </div>
    </NodeShell>
  );
}

export function SelectNode({ data, selected }: NodeProps) {
  const d = data as unknown as SelectNodeData;
  return (
    <NodeShell icon="🎯" title="Select" selected={selected}>
      <div className="etl-node__line">
        {d.mappings.length > 0
          ? `${d.mappings.length} column${d.mappings.length === 1 ? "" : "s"}`
          : "(no columns chosen)"}
      </div>
    </NodeShell>
  );
}

export function FilterNode({ data, selected }: NodeProps) {
  const d = data as unknown as FilterNodeData;
  return (
    <NodeShell
      icon="🔍"
      title="Filter"
      selected={selected}
      namedOutputs={[
        { id: "true", label: "True", top: "35%" },
        { id: "false", label: "False", top: "70%" },
      ]}
    >
      <div className="etl-node__line">
        {d.conditions.length > 0
          ? `${d.conditions.length} condition${d.conditions.length === 1 ? "" : "s"} (${d.conjunction})`
          : "(no conditions)"}
      </div>
    </NodeShell>
  );
}

export function JoinNode({ data, selected }: NodeProps) {
  const d = data as unknown as JoinNodeData;
  return (
    <NodeShell
      icon="🔗"
      title="Join"
      selected={selected}
      namedInputs={[
        { id: "left", label: "left", top: "35%" },
        { id: "right", label: "right", top: "70%" },
      ]}
      namedOutputs={[
        { id: "left_only", label: "Left", top: "20%" },
        { id: "matched", label: "Both", top: "50%" },
        { id: "right_only", label: "Right", top: "80%" },
      ]}
    >
      <div className="etl-node__line">
        {d.conditions.length > 0 && d.conditions[0].leftKey
          ? d.conditions
              .map((c) => `${c.leftKey || "?"} = ${c.rightKey || "?"}`)
              .join(" AND ")
          : "(keys not set)"}
      </div>
      <div className="etl-node__sub">Left / Both / Right outputs</div>
    </NodeShell>
  );
}

export function AggregateNode({ data, selected }: NodeProps) {
  const d = data as unknown as AggregateNodeData;
  return (
    <NodeShell icon="Σ" title="Aggregate" selected={selected}>
      <div className="etl-node__line">
        Group by {d.groupBy.length}, {d.aggregations.length} agg
        {d.aggregations.length === 1 ? "" : "s"}
      </div>
    </NodeShell>
  );
}

export function SortNode({ data, selected }: NodeProps) {
  const d = data as unknown as SortNodeData;
  return (
    <NodeShell icon="↕️" title="Sort" selected={selected}>
      <div className="etl-node__line">
        {d.fields.length > 0 ? `${d.fields.length} field(s)` : "(no fields)"}
      </div>
    </NodeShell>
  );
}

export function LimitNode({ data, selected }: NodeProps) {
  const d = data as unknown as LimitNodeData;
  return (
    <NodeShell icon="⏹️" title="Limit" selected={selected}>
      <div className="etl-node__line">{d.count} rows</div>
    </NodeShell>
  );
}

export function UnionNode({ data, selected }: NodeProps) {
  const d = data as unknown as UnionNodeData;
  const namedInputs = d.inputs.map((handle, i) => ({
    id: handle,
    label: `in ${i + 1}`,
    top: `${((i + 1) / (d.inputs.length + 1)) * 100}%`,
  }));
  return (
    <NodeShell
      icon="🔀"
      title="Union"
      selected={selected}
      namedInputs={namedInputs}
    >
      <div className="etl-node__line">
        {d.inputs.length} input{d.inputs.length === 1 ? "" : "s"} · UNION{" "}
        {d.mode === "ALL" ? "ALL" : ""}
      </div>
      <div className="etl-node__sub">
        {d.columns.length > 0 ? `${d.columns.length} output column(s)` : "(no columns mapped)"}
      </div>
    </NodeShell>
  );
}

export function SqlNode({ data, selected }: NodeProps) {
  const d = data as unknown as SqlNodeData;
  const namedInputs = d.dependsOn.map((name, i) => ({
    id: name,
    label: name,
    top: `${((i + 1) / (d.dependsOn.length + 1)) * 100}%`,
  }));
  const firstLine = d.sql.trim().split("\n")[0]?.slice(0, 40) ?? "";
  const lineCount = d.sql.trim().split("\n").length;
  return (
    <NodeShell
      icon="🧩"
      title={d.label || "Custom SQL"}
      selected={selected}
      hasInput={namedInputs.length > 0}
      namedInputs={namedInputs.length > 0 ? namedInputs : undefined}
    >
      <div className="etl-node__line etl-node__line--mono">
        {firstLine}
        {lineCount > 1 ? "…" : ""}
      </div>
      <div className="etl-node__sub">
        {lineCount} line{lineCount === 1 ? "" : "s"} of SQL
        {(d.detectedColumns?.length ?? 0) === 0 && " · run once to detect columns"}
      </div>
    </NodeShell>
  );
}

export function CommentNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as CommentNodeData;
  const { updateNodeData, getNode } = useReactFlow();
  const attached = d.attachedNodeId ? getNode(d.attachedNodeId) : undefined;
  const firstLine = d.text.trim().split("\n")[0]?.slice(0, 60) ?? "";

  return (
    <div className={`comment-node${selected ? " comment-node--selected" : ""}`}>
      <div className="comment-node__header">
        <span className="comment-node__icon">🗒️</span>
        {attached && (
          <span className="comment-node__attached" title={`Attached to ${attached.id}`}>
            → {attached.type}
          </span>
        )}
        <button
          type="button"
          className="comment-node__toggle nodrag"
          onClick={(e) => {
            e.stopPropagation();
            updateNodeData(id, { collapsed: !d.collapsed });
          }}
          title={d.collapsed ? "Expand note" : "Collapse note"}
        >
          {d.collapsed ? "▸" : "▾"}
        </button>
      </div>
      {d.collapsed ? (
        <div className="comment-node__preview">{firstLine || "(empty note)"}</div>
      ) : (
        <textarea
          className="comment-node__textarea nodrag nowheel"
          value={d.text}
          placeholder="Write a note…"
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
        />
      )}
    </div>
  );
}

export const nodeTypes = {
  source: SourceNode,
  select: SelectNode,
  filter: FilterNode,
  join: JoinNode,
  aggregate: AggregateNode,
  sort: SortNode,
  limit: LimitNode,
  union: UnionNode,
  sql: SqlNode,
  comment: CommentNode,
};
