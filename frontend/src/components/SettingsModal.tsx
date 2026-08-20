interface SettingsModalProps {
  showSourceLines: boolean;
  onShowSourceLinesChange: (value: boolean) => void;
  onClose: () => void;
}

export function SettingsModal({
  showSourceLines,
  onShowSourceLinesChange,
  onClose,
}: SettingsModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Settings</h2>
          <button className="btn btn--icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <label className="settings-row">
          <span className="settings-row__label">
            Show source lines
            <span className="hint">
              The dashed lines linking a SQL node to the tables it references.
            </span>
          </span>
          <span
            className={`toggle-switch${showSourceLines ? " toggle-switch--on" : ""}`}
            onClick={() => onShowSourceLinesChange(!showSourceLines)}
          >
            <span className="toggle-switch__thumb" />
          </span>
        </label>
        <div className="modal__footer">
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
