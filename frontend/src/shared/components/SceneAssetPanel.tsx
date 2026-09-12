import type { CSSProperties, ReactNode } from "react";

export type SceneRenderMode = "pointcloud" | "3dgs";

/**
 * Left-side column shared by all three modes: it stacks the unified scene
 * panel (render mode + cloud/splat file selection) on top of any
 * mode-specific panels (Trajectory step info, SceneGraph snapshot selector).
 *
 * `pointerEvents` stays enabled: the column only wraps its children, and the
 * small gap areas behaving as overlay (data-overlay) matches the existing
 * floating-panel click filtering.
 */
export const SCENE_COLUMN_STYLE: CSSProperties = {
  position: "absolute",
  top: 64,
  left: 16,
  zIndex: 15,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: 380,
  maxHeight: "calc(100% - 80px)",
  overflowY: "auto",
  scrollbarWidth: "thin",
};

/**
 * Right-side column for mode-specific tool panels (BBox object list,
 * Trajectory path browser, SceneGraph layers/edit panels). Fixed to the
 * same width as the left scene column so both rails stay proportional.
 */
export const TOOLS_COLUMN_STYLE: CSSProperties = {
  position: "absolute",
  top: 64,
  right: 16,
  zIndex: 15,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: 380,
  maxHeight: "calc(100% - 80px)",
  overflowY: "auto",
  scrollbarWidth: "thin",
};

const PANEL: CSSProperties = {
  background: "rgba(10,12,24,0.88)",
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: 13,
  border: "1px solid rgba(52,152,219,0.35)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderRadius: 8,
  padding: "12px 14px",
  flexShrink: 0,
};

/**
 * Shared card style for the mode-specific visualization panel that stacks
 * below the SceneAssetPanel in the left column (BBox parameters, SceneGraph
 * snapshot/display panel).
 */
export const MODE_PANEL_STYLE: CSSProperties = {
  ...PANEL,
  width: "100%",
  boxSizing: "border-box",
};

/** Panel title row ("◈ Name") matching the SceneAssetPanel header. */
export const MODE_PANEL_TITLE: CSSProperties = {
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
  letterSpacing: 0.5,
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 8,
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 12,
  color: "#8ab4d8",
  marginBottom: 3,
  letterSpacing: 0.5,
};

const selectStyle: CSSProperties = {
  width: "100%",
  background: "#141428",
  color: "#e0e6f0",
  border: "1px solid #3a3a5c",
  borderRadius: 6,
  padding: "4px 6px",
  fontFamily: "monospace",
  fontSize: 13,
  cursor: "pointer",
  outline: "none",
};

interface Props {
  renderMode: SceneRenderMode;
  onRenderModeChange: (m: SceneRenderMode) => void;

  /** Files selectable in Point Cloud mode (typically .pcd/.ply). */
  cloudFiles: string[];
  /** Current selection. */
  selectedCloud: string;
  onSelectCloud: (name: string) => void;

  /** Files selectable in Gaussian Splatting mode (.ply/.splat/.ksplat/.spz). */
  splatFiles: string[];
  selectedSplat: string | null;
  onSelectSplat: (name: string | null) => void;

  loading?: boolean;
  error?: string | null;
  /** Mode-specific visualization parameters, rendered below the selectors. */
  children?: ReactNode;
}

/**
 * Unified scene-selection panel used by all three modes (BBox-styled):
 * render mode (Point Cloud / Gaussian Splatting) and a plain scene-file
 * list, followed by mode-specific visualization parameters.
 */
export function SceneAssetPanel({
  renderMode,
  onRenderModeChange,
  cloudFiles,
  selectedCloud,
  onSelectCloud,
  splatFiles,
  selectedSplat,
  onSelectSplat,
  loading = false,
  error = null,
  children = null,
}: Props) {
  // Keep a valid selection visible even when the active file is not part of
  // the listing (e.g. a locally imported asset in BBox mode).
  const cloudOptions =
    selectedCloud && !cloudFiles.includes(selectedCloud)
      ? [selectedCloud, ...cloudFiles]
      : cloudFiles;
  const splatOptions =
    selectedSplat && !splatFiles.includes(selectedSplat)
      ? [selectedSplat, ...splatFiles]
      : splatFiles;

  return (
    <div data-overlay style={PANEL}>
      <div
        style={{
          color: "#fff",
          fontWeight: 600,
          fontSize: 14,
          marginBottom: 8,
          letterSpacing: 0.5,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ color: "#3498db" }}>◈</span> 场景
      </div>

      <div style={SECTION_LABEL}>Render Mode</div>
      <select
        value={renderMode}
        onChange={(e) => onRenderModeChange(e.target.value as SceneRenderMode)}
        style={{ ...selectStyle, marginBottom: 8 }}
      >
        <option value="pointcloud">Point Cloud</option>
        <option value="3dgs" disabled={splatFiles.length === 0}>
          Gaussian Splatting {splatFiles.length === 0 ? "(no splat files)" : ""}
        </option>
      </select>

      {renderMode === "pointcloud" ? (
        <>
          <div style={SECTION_LABEL}>Point Cloud</div>
          <select
            value={selectedCloud}
            onChange={(e) => onSelectCloud(e.target.value)}
            style={selectStyle}
          >
            <optgroup label="Scene Clouds">
              {cloudOptions.map((name) => (
                <option key={name} value={name}>
                  ◆ {name}
                </option>
              ))}
            </optgroup>
          </select>
        </>
      ) : (
        <>
          <div style={SECTION_LABEL}>Gaussian Splat</div>
          <select
            value={selectedSplat ?? ""}
            onChange={(e) => onSelectSplat(e.target.value || null)}
            style={selectStyle}
          >
            {splatOptions.map((name) => (
              <option key={name} value={name}>
                ◆ {name}
              </option>
            ))}
          </select>
        </>
      )}

      {loading && (
        <div style={{ color: "#8ab4d8", marginTop: 6, fontSize: 12 }}>
          Loading…
        </div>
      )}
      {error && (
        <div
          style={{
            color: "#ff7b7b",
            marginTop: 6,
            fontSize: 12,
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}

      {children && (
        <div
          style={{
            marginTop: 10,
            borderTop: "1px solid rgba(52,152,219,0.25)",
            paddingTop: 8,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Label + value + range row used for the per-mode visualization parameters
 * shown under the scene selectors (BBox sizes, Trajectory point size, …).
 */
export function PanelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  decimals = 2,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  decimals?: number;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: "#8ab4d8",
          marginBottom: 2,
        }}
      >
        <span>{label}</span>
        <span style={{ color: "#ddd" }}>{value.toFixed(decimals)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          accentColor: "#3498db",
          height: 4,
          cursor: "pointer",
        }}
      />
    </div>
  );
}
