import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";

interface NamedHandle {
  id: string;
  label: string;
  top: string;
}

interface NodeShellProps {
  icon: string;
  title: string;
  children: ReactNode;
  selected?: boolean;
  hasInput?: boolean;
  /** For the join node: two named target handles instead of one. */
  namedInputs?: NamedHandle[];
  /** For filter/join nodes: multiple named source handles instead of one. */
  namedOutputs?: NamedHandle[];
}

export function NodeShell({
  icon,
  title,
  children,
  selected,
  hasInput = true,
  namedInputs,
  namedOutputs,
}: NodeShellProps) {
  return (
    <div className={`etl-node${selected ? " etl-node--selected" : ""}`}>
      {namedInputs
        ? namedInputs.map((h) => (
            <Handle
              key={h.id}
              type="target"
              position={Position.Left}
              id={h.id}
              style={{ top: h.top }}
              className="etl-handle"
            />
          ))
        : hasInput && (
            <Handle type="target" position={Position.Left} className="etl-handle" />
          )}
      <div className="etl-node__header">
        <span className="etl-node__icon">{icon}</span>
        <span className="etl-node__title">{title}</span>
      </div>
      <div className="etl-node__body">{children}</div>
      {namedInputs && (
        <div className="etl-node__handle-labels etl-node__handle-labels--left">
          {namedInputs.map((h) => (
            <span key={h.id} style={{ top: h.top }} className="etl-node__handle-label">
              {h.label}
            </span>
          ))}
        </div>
      )}
      {namedOutputs
        ? namedOutputs.map((h) => (
            <Handle
              key={h.id}
              type="source"
              position={Position.Right}
              id={h.id}
              style={{ top: h.top }}
              className="etl-handle"
            />
          ))
        : (
            <Handle type="source" position={Position.Right} className="etl-handle" />
          )}
      {namedOutputs && (
        <div className="etl-node__handle-labels etl-node__handle-labels--right">
          {namedOutputs.map((h) => (
            <span key={h.id} style={{ top: h.top }} className="etl-node__handle-label">
              {h.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
