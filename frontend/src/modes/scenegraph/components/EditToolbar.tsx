import type { EditMode } from "../lib/types";

interface Props {
  editMode: EditMode;
  changeCount: number;
  dirty: boolean;
  exporting: boolean;
  showDiff: boolean;
  showShortcuts: boolean;
  /**
   * A scene graph is actually loaded (a snapshot was picked and fetched). The
   * Add Node / Add Object buttons create mutations that can only ever be
   * exported against a snapshot, so with none loaded they are disabled instead
   * of letting the user build edits whose Export silently does nothing.
   */
  hasGraph: boolean;
  /** Short-lived status message (e.g. "Undo applied"), pinned to the right. */
  notice?: string | null;
  onToggleEdit: () => void;
  onReset: () => void;
  onExport: () => void;
  onAddNode: () => void;
  onAddObject: () => void;
  onShowDiff?: () => void;
  onHideDiff?: () => void;
  onToggleShortcuts: () => void;
}

export function EditToolbar({
  editMode,
  changeCount,
  dirty,
  exporting,
  showDiff,
  showShortcuts,
  hasGraph,
  notice,
  onToggleEdit,
  onReset,
  onExport,
  onAddNode,
  onAddObject,
  onShowDiff,
  onHideDiff,
  onToggleShortcuts,
}: Props) {
  const editing = editMode === "edit";

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        background: "rgba(0,0,0,0.85)",
        borderRadius: 8,
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: "monospace",
        fontSize: 14,
        userSelect: "none",
      }}
    >
      <button
        onClick={onToggleEdit}
        style={editing ? btnActiveStyle : btnStyle}
      >
        {editing ? "Editing" : "Edit"}
      </button>

      {!editing && !showDiff && onShowDiff && (
        <>
          <span style={{ color: "#888" }}>|</span>
          <button onClick={onShowDiff} style={btnStyle}>
            Diff
          </button>
        </>
      )}

      {editing && (
        <>
          <span style={{ color: "#888" }}>|</span>

          <button
            onClick={onAddNode}
            disabled={!hasGraph}
            style={hasGraph ? btnStyle : btnDisabledStyle}
            title={
              hasGraph
                ? "Add a new node at arbitrary XYZ"
                : "No scene graph loaded — pick a Snapshot first"
            }
          >
            Add Node
          </button>

          <button
            onClick={onAddObject}
            disabled={!hasGraph}
            style={hasGraph ? btnStyle : btnDisabledStyle}
            title={
              hasGraph
                ? "Add a new marker object at arbitrary XYZ"
                : "No scene graph loaded — pick a Snapshot first"
            }
          >
            Add Object
          </button>

          <button
            onClick={onReset}
            style={btnStyle}
            title="Discard all changes and reload"
          >
            Reset
          </button>

          <button
            onClick={onToggleShortcuts}
            style={showShortcuts ? btnActiveStyle : btnStyle}
            title="Toggle shortcut help panel"
          >
            Shortcuts
          </button>

          <button
            onClick={onExport}
            disabled={!dirty || exporting}
            style={dirty && !exporting ? btnStyle : btnDisabledStyle}
          >
            {exporting ? "Exporting..." : "Export"}
          </button>

          {changeCount > 0 && (
            <span style={{ color: "#f90", fontSize: 13 }}>
              {changeCount} changes
            </span>
          )}
        </>
      )}

      {showDiff && onHideDiff && (
        <>
          <span style={{ color: "#888" }}>|</span>
          <button onClick={onHideDiff} style={btnActiveStyle}>
            Diff
          </button>
        </>
      )}

      {notice && (
        <span style={{ color: "#2ecc71", fontSize: 13, marginLeft: 4 }}>
          {notice}
        </span>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  color: "#ccc",
  padding: "5px 14px",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 14,
};

const btnActiveStyle: React.CSSProperties = {
  ...btnStyle,
  background: "rgba(52,152,219,0.3)",
  border: "1px solid rgba(52,152,219,0.5)",
  color: "#3498db",
};

const btnDisabledStyle: React.CSSProperties = {
  ...btnStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};
