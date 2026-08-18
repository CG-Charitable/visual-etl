import { useMemo, useState } from "react";
import type { SchemaTable } from "../types";

interface SchemaBrowserProps {
  tables: SchemaTable[];
  loading: boolean;
  error: string | null;
}

export function SchemaBrowser({ tables, loading, error }: SchemaBrowserProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) => t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q),
    );
  }, [tables, query]);

  return (
    <div className="schema-browser">
      <div className="schema-browser__header">Tables &amp; Views</div>
      <input
        className="schema-browser__search"
        placeholder="Search..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <div className="schema-browser__status">Loading schema…</div>}
      {error && <div className="schema-browser__status schema-browser__status--error">{error}</div>}
      <div className="schema-browser__list">
        {filtered.map((t) => (
          <div
            key={`${t.schema}.${t.name}`}
            className="schema-browser__item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                "application/x-etl-table",
                JSON.stringify({ schema: t.schema, table: t.name }),
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            title={`Drag onto the canvas to add as a source (${t.columns.length} columns)`}
          >
            <span className={`schema-browser__badge schema-browser__badge--${t.type}`}>
              {t.type === "view" ? "V" : "T"}
            </span>
            <span className="schema-browser__name">
              {t.schema}.{t.name}
            </span>
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="schema-browser__status">No matches</div>
        )}
      </div>
    </div>
  );
}
