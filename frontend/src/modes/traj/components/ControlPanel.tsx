import type { CSSProperties } from "react";
import type { TrajBrowseResult, TrajStep } from "../lib/traj-types";

const PANEL: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
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
  userSelect: "none",
  flexShrink: 0,
};

const SECTION_TITLE: CSSProperties = {
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
  margin: "10px 0 6px",
  letterSpacing: 0.5,
};

const inputStyle: CSSProperties = {
  flex: 1,
  height: 26,
  background: "#141428",
  color: "#e0e6f0",
  border: "1px solid #3a3a5c",
  borderRadius: 6,
  padding: "2px 6px",
  fontFamily: "monospace",
  fontSize: 12,
  minWidth: 0,
  outline: "none",
};

const btnStyle: CSSProperties = {
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "4px 10px",
  transition: "background 0.15s",
};

const listBtnStyle: CSSProperties = {
  ...btnStyle,
  display: "block",
  width: "100%",
  textAlign: "left",
  color: "#ccc",
  borderColor: "#3a3a5c",
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
  /** Fixed browsing root reported by the backend (project directory). */
  rootPath: string;
  browse: TrajBrowseResult | null;
  browsing: boolean;
  browseError: string | null;
  selectedStep: TrajStep | null;
  onSelectStep: (s: TrajStep) => void;
  /** Re-browse another path (e.g. a flight_ entry from a dir listing). */
  onNavigate: (path: string) => void;

  offset: [number, number, number];
  yawDeg: number;
  onPlacementChange: (offset: [number, number, number], yawDeg: number) => void;
  onResetPlacement: () => void;
  hasTrajectory: boolean;
}

/**
 * Left-side control column: fixed-root trajectory browser and manual
 * trajectory placement. Scene selection lives in the shared right-side
 * SceneAssetPanel.
 */
export function ControlPanel(p: Props) {
  const inSubdir = !!p.browse && !!p.rootPath && p.browse.path !== p.rootPath;
  return (
    <div data-overlay style={PANEL}>
      <div style={SECTION_TITLE}>轨迹数据</div>
      {/* Back button only appears while browsing a flight_/step_ subdir —
          the root itself is fixed and needs no picker. */}
      {inSubdir && (
        <button
          style={{ ...btnStyle, marginBottom: 4 }}
          onClick={() => p.onNavigate(p.rootPath)}
          disabled={p.browsing}
          title="返回根目录"
        >
          ← 返回根目录
        </button>
      )}
      {p.browseError && <div style={{ color: "#e55", marginTop: 4 }}>{p.browseError}</div>}
      <BrowseList {...p} />

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
