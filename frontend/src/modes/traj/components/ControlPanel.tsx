import type { CSSProperties } from "react";
import type { TrajBrowseResult, TrajStep } from "../lib/traj-types";
import { CloudRootPicker } from "../../../shared/components/CloudRootPicker";

const PANEL: CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 20,
  width: 300,
  maxHeight: "calc(100% - 96px)",
  overflowY: "auto",
  background: "rgba(0,0,0,0.82)",
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: 12,
  border: "1px solid rgba(52,152,219,0.28)",
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  borderRadius: 6,
  padding: "10px 12px",
  userSelect: "none",
};

const SECTION_TITLE: CSSProperties = {
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  margin: "8px 0 6px",
};

const inputStyle: CSSProperties = {
  flex: 1,
  height: 26,
  background: "#1a1a2e",
  color: "#eee",
  border: "1px solid #3498db",
  borderRadius: 4,
  padding: "2px 6px",
  fontFamily: "monospace",
  fontSize: 12,
  minWidth: 0,
};

const btnStyle: CSSProperties = {
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "4px 10px",
};

const listBtnStyle: CSSProperties = {
  ...btnStyle,
  display: "block",
  width: "100%",
  textAlign: "left",
  color: "#ccc",
  borderColor: "#333",
  marginBottom: 3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const selectedListBtnStyle: CSSProperties = {
  ...listBtnStyle,
  borderColor: "#3498db",
  color: "#fff",
  background: "rgba(52,152,219,0.25)",
};

const numInputStyle: CSSProperties = {
  ...inputStyle,
  height: 24,
  textAlign: "right",
};

interface Props {
  inputPath: string;
  onInputPathChange: (v: string) => void;
  onBrowse: () => void;
  browse: TrajBrowseResult | null;
  browsing: boolean;
  browseError: string | null;
  selectedStep: TrajStep | null;
  onSelectStep: (s: TrajStep) => void;
  /** Re-browse another path (e.g. a flight_ entry from a dir listing). */
  onNavigate: (path: string) => void;
  recentPaths: string[];

  renderMode: "pointcloud" | "3dgs";
  onRenderModeChange: (m: "pointcloud" | "3dgs") => void;
  sceneOptions: string[];
  sceneFile: string;
  onSceneFileChange: (f: string) => void;
  onCloudRootChanged?: () => void;
  sceneLoading: boolean;
  sceneError: string | null;
  pointSize: number;
  onPointSizeChange: (v: number) => void;

  offset: [number, number, number];
  yawDeg: number;
  onPlacementChange: (offset: [number, number, number], yawDeg: number) => void;
  onResetPlacement: () => void;
  hasTrajectory: boolean;
}

/**
 * Left-side control column: server path input + browse results, scene
 * selection (point cloud / 3DGS) and manual trajectory placement.
 */
export function ControlPanel(p: Props) {
  return (
    <div data-overlay style={PANEL}>
      <div style={SECTION_TITLE}>轨迹数据</div>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          style={inputStyle}
          value={p.inputPath}
          placeholder="/abs/path/to/flight_…"
          onChange={(e) => p.onInputPathChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") p.onBrowse();
          }}
        />
        <button style={btnStyle} onClick={p.onBrowse} disabled={p.browsing}>
          {p.browsing ? "…" : "浏览"}
        </button>
      </div>
      {p.recentPaths.length > 0 && (
        <select
          style={{ ...inputStyle, marginTop: 4, cursor: "pointer" }}
          value=""
          onChange={(e) => e.target.value && p.onNavigate(e.target.value)}
        >
          <option value="">— 最近路径 —</option>
          {p.recentPaths.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      )}
      {p.browseError && <div style={{ color: "#e55", marginTop: 4 }}>{p.browseError}</div>}
      <BrowseList {...p} />

      <div style={{ ...SECTION_TITLE, marginTop: 12 }}>场景</div>
      <div style={{ marginBottom: 6 }}>
        <CloudRootPicker onRootChanged={p.onCloudRootChanged} />
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <button
          style={p.renderMode === "pointcloud" ? { ...btnStyle, background: "#3498db", color: "#fff" } : btnStyle}
          onClick={() => p.onRenderModeChange("pointcloud")}
        >
          点云
        </button>
        <button
          style={p.renderMode === "3dgs" ? { ...btnStyle, background: "#3498db", color: "#fff" } : btnStyle}
          onClick={() => p.onRenderModeChange("3dgs")}
        >
          3DGS
        </button>
      </div>
      <select
        style={{ ...inputStyle, cursor: "pointer" }}
        value={p.sceneFile}
        onChange={(e) => p.onSceneFileChange(e.target.value)}
      >
        {p.sceneOptions.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      {p.renderMode === "pointcloud" && (
        <label style={{ display: "block", marginTop: 6, color: "#999" }}>
          点大小 {p.pointSize.toFixed(3)}
          <input
            type="range"
            min={0.002}
            max={0.1}
            step={0.002}
            value={p.pointSize}
            onChange={(e) => p.onPointSizeChange(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
      )}
      {p.sceneLoading && <div style={{ color: "#888", marginTop: 4 }}>场景加载中…</div>}
      {p.sceneError && <div style={{ color: "#e55", marginTop: 4 }}>{p.sceneError}</div>}

      <div style={{ ...SECTION_TITLE, marginTop: 12 }}>轨迹摆放</div>
      {!p.hasTrajectory ? (
        <div style={{ color: "#888" }}>选择一个含 trajectory.json 的 step 后可摆放</div>
      ) : (
        <>
          <PlacementRow
            label="X 偏移"
            value={p.offset[0]}
            onChange={(v) => p.onPlacementChange([v, p.offset[1], p.offset[2]], p.yawDeg)}
          />
          <PlacementRow
            label="Y 偏移"
            value={p.offset[1]}
            onChange={(v) => p.onPlacementChange([p.offset[0], v, p.offset[2]], p.yawDeg)}
          />
          <PlacementRow
            label="Z 偏移"
            value={p.offset[2]}
            onChange={(v) => p.onPlacementChange([p.offset[0], p.offset[1], v], p.yawDeg)}
          />
          <PlacementRow
            label="Yaw°"
            value={p.yawDeg}
            onChange={(v) => p.onPlacementChange(p.offset, v)}
          />
          <button style={{ ...btnStyle, width: "100%", marginTop: 4 }} onClick={p.onResetPlacement}>
            重置摆放
          </button>
        </>
      )}
    </div>
  );
}

function BrowseList(p: Props) {
  if (!p.browse) return null;
  const steps = p.browse.steps ?? (p.browse.step ? [p.browse.step] : []);
  return (
    <div style={{ marginTop: 6 }}>
      {(p.browse.flights ?? []).map((f) => (
        <button
          key={f.path}
          style={listBtnStyle}
          onClick={() => p.onNavigate(f.path)}
          title={f.path}
        >
          📁 {f.name}
        </button>
      ))}
      {steps.map((s) => (
        <button
          key={s.path}
          style={
            p.selectedStep?.path === s.path ? selectedListBtnStyle : listBtnStyle
          }
          disabled={!s.hasTrajectory}
          title={s.hasTrajectory ? s.path : `${s.path}（无 trajectory.json）`}
          onClick={() => p.onSelectStep(s)}
        >
          {p.selectedStep?.path === s.path ? "◉ " : "○ "}
          {s.name}
          {!s.hasTrajectory && "（无轨迹）"}
          {s.hasTrajectory && s.hasVideo && " 🎬"}
        </button>
      ))}
    </div>
  );
}

function PlacementRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
      <span style={{ width: 48, color: "#aaa" }}>{label}</span>
      <input
        type="number"
        step={0.1}
        style={numInputStyle}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}
