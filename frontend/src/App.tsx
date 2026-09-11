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

type AppMode = "bbox" | "scenegraph";

const MODE_LABELS: Array<{ id: AppMode; label: string }> = [
  { id: "bbox", label: "3D-BBox 标注" },
  { id: "scenegraph", label: "SceneGraph 编辑" },
];

function loadStoredMode(): AppMode {
  try {
    const v = localStorage.getItem("3dbbox_appMode");
    if (v === "bbox" || v === "scenegraph") return v;
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
        {mode === "bbox" ? <BBoxMode /> : <SceneGraphMode />}
      </Suspense>
    </div>
  );
}

// Styled to match the dark floating panels used inside both modes.
const switcherStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 40,
  display: "flex",
  gap: 4,
  padding: 4,
  borderRadius: 6,
  background: "rgba(0,0,0,0.82)",
  border: "1px solid rgba(52,152,219,0.28)",
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  userSelect: "none",
};

const btnStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "#999",
  fontFamily: "monospace",
  fontSize: 13,
  cursor: "pointer",
};

const activeBtnStyle: CSSProperties = {
  ...btnStyle,
  background: "#3498db",
  color: "#fff",
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
