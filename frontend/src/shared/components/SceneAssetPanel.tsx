import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { SCHEME_LABELS, type PcdColorScheme } from "./PointCloudLayer";

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

  /** Available scenes (subdirectories of scenes/ on the backend). */
  scenes: string[];
  /** Current scene selection ("" while unresolved). */
  selectedScene: string;
  onSelectScene: (scene: string) => void;

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
  /**
   * 点云大小 — 三模式共用的场景可视化参数，只在「点云」渲染模式下显示。
   * 由 useSceneVisuals 提供（跨模式共享、跨会话持久化）。
   */
  pointSize?: number;
  onPointSizeChange?: (v: number) => void;
  /**
   * 栅格尺度与坐标系显示 — 三模式共用的场景可视化参数，两种渲染模式
   * 下都可见。由 useSceneVisuals 提供（跨模式共享、跨会话持久化）。
   */
  gridSize?: number;
  onGridSizeChange?: (v: number) => void;
  showAxes?: boolean;
  onShowAxesChange?: (v: boolean) => void;
  colorScheme?: PcdColorScheme;
  onColorSchemeChange?: (v: PcdColorScheme) => void;
  opacity?: number;
  onOpacityChange?: (v: number) => void;
  /** Mode-specific visualization parameters, rendered below the selectors. */
  children?: ReactNode;
}

/**
 * Unified scene-selection panel used by all three modes (BBox-styled):
 * 基本参数 — 场景名称 (subdirectory of scenes/), 原始文件 (cloud/splat
 * asset of the active scene) and 渲染模式 (Point Cloud / Gaussian
 * Splatting), followed by mode-specific visualization parameters.
 */
export function SceneAssetPanel({
  renderMode,
  onRenderModeChange,
  scenes,
  selectedScene,
  onSelectScene,
  cloudFiles,
  selectedCloud,
  onSelectCloud,
  splatFiles,
  selectedSplat,
  onSelectSplat,
  loading = false,
  error = null,
  pointSize,
  onPointSizeChange,
  gridSize,
  onGridSizeChange,
  showAxes,
  onShowAxesChange,
  colorScheme,
  onColorSchemeChange,
  opacity,
  onOpacityChange,
  children = null,
}: Props) {
  // Keep a valid selection visible even when the active file is not part of
  // the listing (e.g. a stale persisted selection before the listing
  // arrives).
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
        <span style={{ color: "#3498db" }}>◈</span> 基本参数
      </div>

      <div style={SECTION_LABEL}>场景名称</div>
      <select
        value={selectedScene}
        onChange={(e) => onSelectScene(e.target.value)}
        style={{ ...selectStyle, marginBottom: 8 }}
      >
        {scenes.length === 0 && <option value="">{selectedScene || "…"}</option>}
        {scenes.map((name) => (
          <option key={name} value={name}>
            ◆ {name}
          </option>
        ))}
      </select>

      {renderMode === "pointcloud" ? (
        <>
          <div style={SECTION_LABEL}>原始文件</div>
          <select
            value={selectedCloud}
            onChange={(e) => onSelectCloud(e.target.value)}
            style={{ ...selectStyle, marginBottom: 8 }}
          >
            <optgroup label="场景文件">
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
          <div style={SECTION_LABEL}>原始文件</div>
          <select
            value={selectedSplat ?? ""}
            onChange={(e) => onSelectSplat(e.target.value || null)}
            style={{ ...selectStyle, marginBottom: 8 }}
          >
            {splatOptions.map((name) => (
              <option key={name} value={name}>
                ◆ {name}
              </option>
            ))}
          </select>
        </>
      )}

      <div style={SECTION_LABEL}>渲染模式</div>
      <select
        value={renderMode}
        onChange={(e) => onRenderModeChange(e.target.value as SceneRenderMode)}
        style={selectStyle}
      >
        <option value="pointcloud">点云</option>
        <option value="3dgs" disabled={splatFiles.length === 0}>
          高斯泼溅
        </option>
      </select>

      {loading && (
        <div style={{ color: "#8ab4d8", marginTop: 6, fontSize: 12 }}>
          Loading...
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

      {(gridSize !== undefined && onGridSizeChange) ||
      (showAxes !== undefined && onShowAxesChange) ? (
        <div
          style={{
            marginTop: 10,
            borderTop: "1px solid rgba(52,152,219,0.25)",
            paddingTop: 8,
          }}
        >
          {gridSize !== undefined && onGridSizeChange && (
            <PanelSlider
              label="栅格尺度"
              value={gridSize}
              min={20}
              max={200}
              step={10}
              onChange={onGridSizeChange}
              decimals={0}
            />
          )}
          {showAxes !== undefined && onShowAxesChange && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={showAxes}
                onChange={(e) => onShowAxesChange(e.target.checked)}
                style={{ accentColor: "#3498db" }}
              />
              <span>坐标系</span>
            </label>
          )}
        </div>
      ) : null}

      {renderMode === "pointcloud" &&
        ((pointSize !== undefined && onPointSizeChange) ||
          (colorScheme !== undefined && onColorSchemeChange) ||
          (opacity !== undefined && onOpacityChange)) && (
          <div
            style={{
              marginTop: 10,
              borderTop: "1px solid rgba(52,152,219,0.25)",
              paddingTop: 8,
            }}
          >
            {pointSize !== undefined && onPointSizeChange && (
              <PanelSlider
                label="点大小"
                value={pointSize}
                min={0.01}
                max={0.3}
                step={0.01}
                onChange={onPointSizeChange}
              />
            )}
            {opacity !== undefined && onOpacityChange && (
              <PanelSlider
                label="不透明度"
                value={opacity}
                min={0.05}
                max={1}
                step={0.05}
                onChange={onOpacityChange}
                decimals={2}
              />
            )}
            {colorScheme !== undefined && onColorSchemeChange && (
              <div style={{ marginTop: 8 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "#8ab4d8",
                    marginBottom: 2,
                  }}
                >
                  配色方案
                </div>
                <select
                  value={colorScheme}
                  onChange={(e) =>
                    onColorSchemeChange(e.target.value as PcdColorScheme)
                  }
                  style={{ ...selectStyle, padding: "3px 6px", fontSize: 12 }}
                >
                  {Object.entries(SCHEME_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
 * Label + value + stepper row for per-mode visualization parameters, styled
 * to match BBoxPanel's NumberStepper (numeric input + ▲/▼ buttons).
 */
const STEPPER_BTN_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
};

function roundTo(n: number, decimals: number) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

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
  const [draft, setDraft] = useState(value.toFixed(decimals));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value.toFixed(decimals));
  }, [value, decimals]);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const v = roundTo(clamp(n), decimals);
      onChange(v);
      setDraft(v.toFixed(decimals));
    } else {
      setDraft(value.toFixed(decimals));
    }
  };

  const stepBy = (delta: number) => {
    const v = roundTo(clamp(value + delta), decimals);
    onChange(v);
    // Keep the draft in sync even while focused: without this, blur()
    // commits the stale draft and silently undoes this step.
    setDraft(v.toFixed(decimals));
  };

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
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
        <input
          className="panel-stepper-input"
          type="number"
          step={step}
          min={min}
          max={max}
          value={draft}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            focusedRef.current = false;
            commit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{
            flex: 1,
            height: 28,
            background: "#1a1a2e",
            color: "#eee",
            border: "1px solid #3498db",
            borderRadius: 4,
            padding: "2px 6px",
            fontFamily: "monospace",
            fontSize: 13,
            textAlign: "right",
          }}
        />
        <button
          type="button"
          aria-label="increase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(step)}
          style={STEPPER_BTN_STYLE}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label="decrease"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(-step)}
          style={STEPPER_BTN_STYLE}
        >
          ▼
        </button>
      </div>
    </div>
  );
}
