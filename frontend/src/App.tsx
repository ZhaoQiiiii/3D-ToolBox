import { Suspense, lazy, useEffect, useState } from "react";
import type { CSSProperties } from "react";

// Each mode is a self-contained subtree (own state, own panels, own canvas);
// they are lazily loaded so the initial bundle only contains the active one.
const BBoxMode = lazy(() =>
  import("./modes/bbox/BBoxMode").then((m) => ({ default: m.BBoxMode })),
);
const SceneGraphMode = lazy(() =>
  import("./modes/scenegraph/SceneGraphMode").then((m) => ({
    default: m.SceneGraphMode,
  })),
);
const TrajectoryMode = lazy(() =>
  import("./modes/traj/TrajectoryMode").then((m) => ({
    default: m.TrajectoryMode,
  })),
);

type AppMode = "bbox" | "scenegraph" | "traj";

const MODE_LABELS: Array<{ id: AppMode; label: string }> = [
  { id: "bbox", label: "3D-BBox Annotator" },
  { id: "scenegraph", label: "SceneGraph Editor" },
  { id: "traj", label: "3D-Trajectory Viewer" },
];

function loadStoredMode(): AppMode {
  try {
    // A `#mode=bbox|scenegraph|traj` hash deep-links straight into a mode
    // (also handy for screenshots/sharing); it wins over the stored choice.
    const h = new URLSearchParams(window.location.hash.slice(1)).get("mode");
    if (h === "bbox" || h === "scenegraph" || h === "traj") return h;
    const v = localStorage.getItem("3dbbox_appMode");
    if (v === "bbox" || v === "scenegraph" || v === "traj") return v;
  } catch {}
  return "bbox";
}

/**
 * Application shell: a top-right mode switcher plus the lazily loaded mode
 * subtree. The switcher floats at top-right (16,16) — free in both modes
 * (BBox panel is top-left, the SceneGraph edit toolbar is top-center).
 */
export function App() {
  const [mode, setMode] = useState<AppMode>(loadStoredMode);

  useEffect(() => {
    try {
      localStorage.setItem("3dbbox_appMode", mode);
    } catch {}
  }, [mode]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div style={switcherStyle}>
        {MODE_LABELS.map(({ id, label }) => (
          <button
            key={id}
            style={id === mode ? activeBtnStyle : btnStyle}
            onClick={() => setMode(id)}
            title={`切换到${label}模式`}
          >
            {label}
          </button>
        ))}
      </div>

      <Suspense fallback={<div style={fallbackStyle}>Loading…</div>}>
        {mode === "bbox" ? (
          <BBoxMode />
        ) : mode === "scenegraph" ? (
          <SceneGraphMode />
        ) : (
          <TrajectoryMode />
        )}
      </Suspense>
    </div>
  );
}

// Styled to match the dark floating panels used inside all three modes.
const switcherStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 40,
  display: "flex",
  gap: 4,
  padding: 4,
  borderRadius: 8,
  background: "rgba(10,12,24,0.88)",
  border: "1px solid rgba(52,152,219,0.35)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  userSelect: "none",
};

const btnStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  color: "#8ab4d8",
  fontFamily: "monospace",
  fontSize: 12,
  letterSpacing: 0.3,
  cursor: "pointer",
  transition: "background 0.15s, color 0.15s, border-color 0.15s",
};

const activeBtnStyle: CSSProperties = {
  ...btnStyle,
  background: "rgba(52,152,219,0.22)",
  borderColor: "#3498db",
  color: "#fff",
  fontWeight: 600,
};

const fallbackStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: 14,
  pointerEvents: "none",
};
