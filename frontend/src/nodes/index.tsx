import type { NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import type {
  SourceNodeData,
  SelectNodeData,
  FilterNodeData,
  JoinNodeData,
  AggregateNodeData,
  SortNodeData,
  LimitNodeData,
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

export const nodeTypes = {
  source: SourceNode,
  select: SelectNode,
  filter: FilterNode,
  join: JoinNode,
  aggregate: AggregateNode,
  sort: SortNode,
  limit: LimitNode,
};
