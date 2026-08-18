import { useState } from "react";
import { importSql, type ImportedGraph } from "../api";

interface ImportSqlModalProps {
  onClose: () => void;
  onImported: (graph: ImportedGraph) => void;
}

export function ImportSqlModal({ onClose, onImported }: ImportSqlModalProps) {
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setText(await file.text());
  }

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await importSql(text);
      onImported(graph);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Import SQL</h2>
          <button className="btn btn--icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="hint">
          Drop a .sql file or paste a view/query below. Each CTE becomes its own node you
          can click through — nothing about the SQL itself is rewritten, so results match
          running it directly. Read-only only: anything that mutates data is rejected.
        </p>
        <div
          className={`import-dropzone${dragOver ? " import-dropzone--active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          <textarea
            className="sql-textarea import-textarea"
            rows={16}
            placeholder="Drop a .sql file here, or paste SQL..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        </div>
        <label className="btn btn--file">
          Choose file
          <input
            type="file"
            accept=".sql,text/plain"
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        {error && <div className="results-panel__error">{error}</div>}
        <div className="modal__footer">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!text.trim() || busy} onClick={submit}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
