import type { Node, Edge } from "@xyflow/react";
import {
  computeUpstreamColumns,
  computeJoinInputs,
  computeUnionInputs,
} from "../columnInference";
import {
  FILTER_OPERATORS,
  AGG_FUNCTIONS,
  type SchemaTable,
  type SourceNodeData,
  type SelectNodeData,
  type FilterNodeData,
  type JoinNodeData,
  type AggregateNodeData,
  type SortNodeData,
  type LimitNodeData,
  type UnionNodeData,
  type SqlNodeData,
  type FilterOperator,
  type AggFn,
} from "../types";

interface InspectorProps {
  node: Node;
  nodes: Node[];
  edges: Edge[];
  schema: SchemaTable[];
  onChange: (nodeId: string, data: unknown) => void;
  onDelete: (nodeId: string) => void;
}

export function Inspector({
  node,
  nodes,
  edges,
  schema,
  onChange,
  onDelete,
}: InspectorProps) {
  const upstream = computeUpstreamColumns(node.id, nodes, edges, schema);

  return (
    <div className="inspector">
      <div className="inspector__header">
        <span>{node.type}</span>
        <button className="btn btn--danger" onClick={() => onDelete(node.id)}>
          Delete node
        </button>
      </div>
      {node.type === "source" && (
        <SourceForm
          data={node.data as unknown as SourceNodeData}
          schema={schema}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "select" && (
        <SelectForm
          data={node.data as unknown as SelectNodeData}
          upstream={upstream}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "filter" && (
        <FilterForm
          data={node.data as unknown as FilterNodeData}
          upstream={upstream}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "join" && (
        <JoinForm
          data={node.data as unknown as JoinNodeData}
          nodeId={node.id}
          nodes={nodes}
          edges={edges}
          schema={schema}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "aggregate" && (
        <AggregateForm
          data={node.data as unknown as AggregateNodeData}
          upstream={upstream}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "sort" && (
        <SortForm
          data={node.data as unknown as SortNodeData}
          upstream={upstream}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "limit" && (
        <LimitForm
          data={node.data as unknown as LimitNodeData}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "union" && (
        <UnionForm
          data={node.data as unknown as UnionNodeData}
          nodeId={node.id}
          nodes={nodes}
          edges={edges}
          schema={schema}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
      {node.type === "sql" && (
        <SqlForm
          data={node.data as unknown as SqlNodeData}
          onChange={(d) => onChange(node.id, d)}
        />
      )}
    </div>
  );
}

function SourceForm({
  data,
  schema,
  onChange,
}: {
  data: SourceNodeData;
  schema: SchemaTable[];
  onChange: (d: SourceNodeData) => void;
}) {
  const schemas = [...new Set(schema.map((t) => t.schema))].sort();
  const tablesInSchema = schema.filter((t) => t.schema === data.schema);
  const table = schema.find((t) => t.schema === data.schema && t.name === data.table);

  return (
    <div className="inspector__section">
      <label className="field">
        <span>Schema</span>
        <select
          value={data.schema}
          onChange={(e) => onChange({ ...data, schema: e.target.value, table: "", columns: [] })}
        >
          {schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Table / View</span>
        <select
          value={data.table}
          onChange={(e) => onChange({ ...data, table: e.target.value, columns: [] })}
        >
          <option value="">(choose)</option>
          {tablesInSchema.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} {t.type === "view" ? "(view)" : ""}
            </option>
          ))}
        </select>
      </label>
      {table && (
        <div className="field">
          <span>
            Columns ({data.columns.length === 0 ? "all" : data.columns.length} of{" "}
            {table.columns.length})
          </span>
          <div className="checkbox-list">
            {table.columns.map((c) => {
              const checked = data.columns.length === 0 || data.columns.includes(c.name);
              return (
                <label key={c.name} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const base =
                        data.columns.length === 0
                          ? table.columns.map((c2) => c2.name)
                          : data.columns;
                      const next = e.target.checked
                        ? [...base, c.name]
                        : base.filter((n) => n !== c.name);
                      onChange({ ...data, columns: next });
                    }}
                  />
                  <span>{c.name}</span>
                  <span className="checkbox-row__type">{c.dataType}</span>
                </label>
              );
            })}
          </div>
          <button
            className="btn btn--link"
            onClick={() => onChange({ ...data, columns: [] })}
          >
            Reset to all columns
          </button>
        </div>
      )}
    </div>
  );
}

function SelectForm({
  data,
  upstream,
  onChange,
}: {
  data: SelectNodeData;
  upstream: { outputName: string }[];
  onChange: (d: SelectNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      <span className="field__label">Output columns</span>
      <div className="checkbox-list">
        {upstream.map((c) => {
          const mapping = data.mappings.find((m) => m.from === c.outputName);
          return (
            <div key={c.outputName} className="checkbox-row">
              <input
                type="checkbox"
                checked={!!mapping}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange({
                      mappings: [...data.mappings, { from: c.outputName, to: c.outputName }],
                    });
                  } else {
                    onChange({
                      mappings: data.mappings.filter((m) => m.from !== c.outputName),
                    });
                  }
                }}
              />
              <span>{c.outputName}</span>
              {mapping && (
                <input
                  className="alias-input"
                  value={mapping.to}
                  placeholder="alias"
                  onChange={(e) =>
                    onChange({
                      mappings: data.mappings.map((m) =>
                        m.from === c.outputName ? { ...m, to: e.target.value } : m,
                      ),
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterForm({
  data,
  upstream,
  onChange,
}: {
  data: FilterNodeData;
  upstream: { outputName: string }[];
  onChange: (d: FilterNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      <label className="field">
        <span>Combine with</span>
        <select
          value={data.conjunction}
          onChange={(e) =>
            onChange({ ...data, conjunction: e.target.value as "AND" | "OR" })
          }
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
      </label>
      {data.conditions.map((cond, i) => {
        const needsValue = cond.operator !== "IS NULL" && cond.operator !== "IS NOT NULL";
        return (
          <div key={i} className="condition-row">
            <select
              value={cond.column}
              onChange={(e) => {
                const next = [...data.conditions];
                next[i] = { ...cond, column: e.target.value };
                onChange({ ...data, conditions: next });
              }}
            >
              <option value="">(column)</option>
              {upstream.map((c) => (
                <option key={c.outputName} value={c.outputName}>
                  {c.outputName}
                </option>
              ))}
            </select>
            <select
              value={cond.operator}
              onChange={(e) => {
                const next = [...data.conditions];
                next[i] = { ...cond, operator: e.target.value as FilterOperator };
                onChange({ ...data, conditions: next });
              }}
            >
              {FILTER_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            {needsValue && (
              <input
                value={
                  Array.isArray(cond.value) ? cond.value.join(", ") : (cond.value ?? "")
                }
                placeholder={cond.operator === "IN" ? "comma-separated" : "value"}
                onChange={(e) => {
                  const next = [...data.conditions];
                  const value =
                    cond.operator === "IN"
                      ? e.target.value.split(",").map((s) => s.trim())
                      : e.target.value;
                  next[i] = { ...cond, value };
                  onChange({ ...data, conditions: next });
                }}
              />
            )}
            <button
              className="btn btn--icon"
              onClick={() =>
                onChange({
                  ...data,
                  conditions: data.conditions.filter((_, idx) => idx !== i),
                })
              }
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        className="btn btn--link"
        onClick={() =>
          onChange({
            ...data,
            conditions: [...data.conditions, { column: "", operator: "=", value: "" }],
          })
        }
      >
        + Add condition
      </button>
      <p className="hint">
        Two outputs: "True" for rows matching this condition, "False" for the rest —
        every row goes to exactly one.
      </p>
    </div>
  );
}

function JoinForm({
  data,
  nodeId,
  nodes,
  edges,
  schema,
  onChange,
}: {
  data: JoinNodeData;
  nodeId: string;
  nodes: Node[];
  edges: Edge[];
  schema: SchemaTable[];
  onChange: (d: JoinNodeData) => void;
}) {
  const { left, right } = computeJoinInputs(nodeId, nodes, edges, schema);
  return (
    <div className="inspector__section">
      <span className="field__label">
        Join keys ({left.length} left cols, {right.length} right cols available)
      </span>
      {data.conditions.map((cond, i) => (
        <div key={i} className="condition-row">
          <select
            value={cond.leftKey}
            onChange={(e) => {
              const next = [...data.conditions];
              next[i] = { ...cond, leftKey: e.target.value };
              onChange({ ...data, conditions: next });
            }}
          >
            <option value="">(left key)</option>
            {left.map((c) => (
              <option key={c.outputName} value={c.outputName}>
                {c.outputName}
              </option>
            ))}
          </select>
          <span className="condition-row__eq">=</span>
          <select
            value={cond.rightKey}
            onChange={(e) => {
              const next = [...data.conditions];
              next[i] = { ...cond, rightKey: e.target.value };
              onChange({ ...data, conditions: next });
            }}
          >
            <option value="">(right key)</option>
            {right.map((c) => (
              <option key={c.outputName} value={c.outputName}>
                {c.outputName}
              </option>
            ))}
          </select>
          {data.conditions.length > 1 && (
            <button
              className="btn btn--icon"
              onClick={() =>
                onChange({
                  ...data,
                  conditions: data.conditions.filter((_, idx) => idx !== i),
                })
              }
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        className="btn btn--link"
        onClick={() =>
          onChange({
            ...data,
            conditions: [...data.conditions, { leftKey: "", rightKey: "" }],
          })
        }
      >
        + Add condition
      </button>
      <p className="hint">
        Multiple conditions are ANDed together (composite key). Feeds a "left" and
        "right" input, and always joins every row (like Alteryx) — connect the "Left"
        output for unmatched left rows, "Both" for matched rows, and "Right" for
        unmatched right rows. Wire up just "Both" for an inner join, "Both" + "Left" for
        a left join, etc.
      </p>
    </div>
  );
}

function UnionForm({
  data,
  nodeId,
  nodes,
  edges,
  schema,
  onChange,
}: {
  data: UnionNodeData;
  nodeId: string;
  nodes: Node[];
  edges: Edge[];
  schema: SchemaTable[];
  onChange: (d: UnionNodeData) => void;
}) {
  const inputCols = computeUnionInputs(nodeId, nodes, edges, schema);

  function addInput() {
    let i = data.inputs.length;
    while (data.inputs.includes(`in${i}`)) i++;
    onChange({ ...data, inputs: [...data.inputs, `in${i}`] });
  }

  function removeInput(handle: string) {
    onChange({
      ...data,
      inputs: data.inputs.filter((h) => h !== handle),
      columns: data.columns.map((c) => {
        const { [handle]: _removed, ...rest } = c.from;
        return { ...c, from: rest };
      }),
    });
  }

  function addColumn() {
    onChange({ ...data, columns: [...data.columns, { to: "", from: {} }] });
  }

  function removeColumn(i: number) {
    onChange({ ...data, columns: data.columns.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="inspector__section">
      <label className="field">
        <span>Mode</span>
        <select
          value={data.mode}
          onChange={(e) => onChange({ ...data, mode: e.target.value as "ALL" | "DISTINCT" })}
        >
          <option value="ALL">UNION ALL (keep duplicates)</option>
          <option value="DISTINCT">UNION (drop duplicate rows)</option>
        </select>
      </label>

      <span className="field__label">Inputs ({data.inputs.length})</span>
      {data.inputs.map((handle, i) => (
        <div key={handle} className="condition-row">
          <span>
            Input {i + 1} — {(inputCols[handle]?.length ?? 0)} column(s) available
          </span>
          {data.inputs.length > 2 && (
            <button className="btn btn--icon" onClick={() => removeInput(handle)}>
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="btn btn--link" onClick={addInput}>
        + Add input
      </button>

      <span className="field__label">Output columns</span>
      {data.columns.map((col, i) => (
        <div key={i} className="condition-row" style={{ flexWrap: "wrap" }}>
          <input
            value={col.to}
            placeholder="output name"
            onChange={(e) => {
              const next = [...data.columns];
              next[i] = { ...col, to: e.target.value };
              onChange({ ...data, columns: next });
            }}
          />
          {data.inputs.map((handle, hi) => (
            <select
              key={handle}
              value={col.from[handle] ?? ""}
              onChange={(e) => {
                const next = [...data.columns];
                next[i] = {
                  ...col,
                  from: { ...col.from, [handle]: e.target.value || null },
                };
                onChange({ ...data, columns: next });
              }}
            >
              <option value="">— NULL (in {hi + 1}) —</option>
              {(inputCols[handle] ?? []).map((c) => (
                <option key={c.outputName} value={c.outputName}>
                  in {hi + 1}: {c.outputName}
                </option>
              ))}
            </select>
          ))}
          <button className="btn btn--icon" onClick={() => removeColumn(i)}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn--link" onClick={addColumn}>
        + Add output column
      </button>
      <p className="hint">
        Combines every input's rows into one output. Each output column picks which
        source column feeds it per input — leave an input as "NULL" for a column it
        doesn't have.
      </p>
    </div>
  );
}

function AggregateForm({
  data,
  upstream,
  onChange,
}: {
  data: AggregateNodeData;
  upstream: { outputName: string }[];
  onChange: (d: AggregateNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      <span className="field__label">Group by</span>
      <div className="checkbox-list">
        {upstream.map((c) => (
          <label key={c.outputName} className="checkbox-row">
            <input
              type="checkbox"
              checked={data.groupBy.includes(c.outputName)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...data.groupBy, c.outputName]
                  : data.groupBy.filter((g) => g !== c.outputName);
                onChange({ ...data, groupBy: next });
              }}
            />
            <span>{c.outputName}</span>
          </label>
        ))}
      </div>

      <span className="field__label">Aggregations</span>
      {data.aggregations.map((agg, i) => (
        <div key={i} className="condition-row">
          <select
            value={agg.column}
            onChange={(e) => {
              const next = [...data.aggregations];
              next[i] = { ...agg, column: e.target.value };
              onChange({ ...data, aggregations: next });
            }}
          >
            <option value="">(column)</option>
            {upstream.map((c) => (
              <option key={c.outputName} value={c.outputName}>
                {c.outputName}
              </option>
            ))}
          </select>
          <select
            value={agg.fn}
            onChange={(e) => {
              const next = [...data.aggregations];
              next[i] = { ...agg, fn: e.target.value as AggFn };
              onChange({ ...data, aggregations: next });
            }}
          >
            {AGG_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
          <input
            value={agg.alias}
            placeholder="alias"
            onChange={(e) => {
              const next = [...data.aggregations];
              next[i] = { ...agg, alias: e.target.value };
              onChange({ ...data, aggregations: next });
            }}
          />
          <button
            className="btn btn--icon"
            onClick={() =>
              onChange({
                ...data,
                aggregations: data.aggregations.filter((_, idx) => idx !== i),
              })
            }
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn btn--link"
        onClick={() =>
          onChange({
            ...data,
            aggregations: [
              ...data.aggregations,
              { column: "", fn: "COUNT", alias: `agg_${data.aggregations.length + 1}` },
            ],
          })
        }
      >
        + Add aggregation
      </button>
    </div>
  );
}

function SortForm({
  data,
  upstream,
  onChange,
}: {
  data: SortNodeData;
  upstream: { outputName: string }[];
  onChange: (d: SortNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      {data.fields.map((f, i) => (
        <div key={i} className="condition-row">
          <select
            value={f.column}
            onChange={(e) => {
              const next = [...data.fields];
              next[i] = { ...f, column: e.target.value };
              onChange({ fields: next });
            }}
          >
            <option value="">(column)</option>
            {upstream.map((c) => (
              <option key={c.outputName} value={c.outputName}>
                {c.outputName}
              </option>
            ))}
          </select>
          <select
            value={f.direction}
            onChange={(e) => {
              const next = [...data.fields];
              next[i] = { ...f, direction: e.target.value as "ASC" | "DESC" };
              onChange({ fields: next });
            }}
          >
            <option value="ASC">ASC</option>
            <option value="DESC">DESC</option>
          </select>
          <button
            className="btn btn--icon"
            onClick={() => onChange({ fields: data.fields.filter((_, idx) => idx !== i) })}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn btn--link"
        onClick={() =>
          onChange({ fields: [...data.fields, { column: "", direction: "ASC" }] })
        }
      >
        + Add field
      </button>
    </div>
  );
}

function LimitForm({
  data,
  onChange,
}: {
  data: LimitNodeData;
  onChange: (d: LimitNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      <label className="field">
        <span>Row count</span>
        <input
          type="number"
          min={0}
          value={data.count}
          onChange={(e) => onChange({ count: parseInt(e.target.value, 10) || 0 })}
        />
      </label>
    </div>
  );
}

function SqlForm({
  data,
  onChange,
}: {
  data: SqlNodeData;
  onChange: (d: SqlNodeData) => void;
}) {
  return (
    <div className="inspector__section">
      <label className="field">
        <span>Name (CTE identifier)</span>
        <input value={data.label} onChange={(e) => onChange({ ...data, label: e.target.value })} />
      </label>
      <label className="field">
        <span>SQL</span>
        <textarea
          className="sql-textarea"
          rows={16}
          value={data.sql}
          onChange={(e) => onChange({ ...data, sql: e.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="field">
        <span className="field__label">References</span>
        {data.dependsOn.length > 0 ? (
          <ul className="sql-deps">
            {data.dependsOn.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <p className="hint">No detected references to other nodes — reads only from real tables/views.</p>
        )}
      </div>
      <p className="hint">
        This runs exactly as written (read-only) — edits here don't add or remove input
        connections; rewire the diagram if you need a different set of inputs.
      </p>
    </div>
  );
}
