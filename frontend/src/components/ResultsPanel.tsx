import { useState } from "react";
import type { RunGraphResponse } from "../api";
import type { Branch } from "../types";

interface ResultsPanelProps {
  selectedNodeId: string | null;
  branches: Branch[];
  activeBranch: string;
  onBranchChange: (branch: string) => void;
  running: boolean;
  error: string | null;
  result: RunGraphResponse | null;
  onRun: () => void;
}

export function ResultsPanel({
  selectedNodeId,
  branches,
  activeBranch,
  onBranchChange,
  running,
  error,
  result,
  onRun,
}: ResultsPanelProps) {
  const [showSql, setShowSql] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  function exportCsv() {
    if (!result) return;
    const headers = result.columns.map((c) => c.outputName);
    const lines = [
      headers.join(","),
      ...result.rows.map((row) =>
        headers
          .map((h) => {
            const v = row[h];
            if (v === null || v === undefined) return "";
            const s = String(v).replace(/"/g, '""');
            return /[",\n]/.test(s) ? `"${s}"` : s;
          })
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "preview.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="results-panel">
      <div className="results-panel__toolbar">
        <button className="btn btn--primary" disabled={!selectedNodeId || running} onClick={onRun}>
          {running ? "Running…" : "Run"}
        </button>
        {selectedNodeId && branches.length > 1 && (
          <div className="branch-tabs">
            {branches.map((b) => (
              <button
                key={b.id}
                className={`branch-tab${b.id === activeBranch ? " branch-tab--active" : ""}`}
                onClick={() => onBranchChange(b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        {result && (
          <>
            <button className="btn" onClick={() => setShowSql((v) => !v)}>
              {showSql ? "Hide SQL" : "Show SQL"}
            </button>
            <button className="btn" onClick={exportCsv}>
              Export CSV (previewed rows)
            </button>
            <span className="results-panel__count">{result.rows.length} row(s)</span>
          </>
        )}
        {!selectedNodeId && <span className="hint">Select a node to preview it</span>}
        <div className="toolbar__spacer" />
        <button
          className="btn btn--icon"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand results" : "Collapse results"}
        >
          {collapsed ? "▲" : "▼"}
        </button>
      </div>
      {!collapsed && (
        <>
          {error && <div className="results-panel__error">{error}</div>}
          {showSql && result && <pre className="results-panel__sql">{result.sql}</pre>}
          {result && (
            <div className="results-panel__table-wrap">
              <table className="results-panel__table">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.outputName}>{c.outputName}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.columns.map((c) => (
                        <td key={c.outputName}>{formatCell(row[c.outputName])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
