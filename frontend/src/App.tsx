import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas } from "@react-three/fiber";
import { CanvasSlot } from "./shared/canvas-slot";

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
 * Application shell: ONE persistent WebGL canvas plus the lazily loaded mode
 * subtree. The canvas never unmounts on a mode switch — each mode renders
 * its 3D content into it through useCanvasSlot() and keeps only its DOM
 * overlays in its own subtree. This preserves the WebGL context (and with it
 * the 3DGS viewers' GPU resources and the point-cloud buffers) across mode
 * switches, so switching modes never reloads the scene.
 *
 * The mode overlays sit ABOVE the canvas with pointer-events disabled on the
 * root and re-enabled per panel (.mode-overlay > *); canvas orbit/zoom/drag
 * keeps working everywhere the panels don't cover.
 */
export function App() {
  const [mode, setMode] = useState<AppMode>(loadStoredMode);
  // True while a mode switch is in flight — shown as a centered "Loading..."
  // overlay so every switch has explicit feedback (the lazy chunks may
  // already be cached, so the Suspense fallback alone would not always
  // appear; the canvas is also shared, making the switch near-instant).
  const [switching, setSwitching] = useState(false);

  const switchMode = useCallback(
    (id: AppMode) => {
      if (id === mode) return;
      setSwitching(true);
      setMode(id);
    },
    [mode],
  );

  useEffect(() => {
    try {
      localStorage.setItem("3dbbox_appMode", mode);
    } catch {}
  }, [mode]);

  // Clear the switch indicator shortly after the new mode mounts, giving the
  // overlay a perceptible presence even for instant switches.
  useEffect(() => {
    if (!switching) return;
    const t = setTimeout(() => setSwitching(false), 250);
    return () => clearTimeout(t);
  }, [switching, mode]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#0b0b12" }}>
      <style>{`.mode-overlay > * { pointer-events: auto; }`}</style>

      {/* The persistent render surface shared by all three modes. */}
      <Canvas
        style={{ position: "absolute", inset: 0 }}
        dpr={[1, 2]}
        onContextMenu={(e) => e.preventDefault()}
      >
        <CanvasSlot />
      </Canvas>

      <div style={switcherStyle}>
        {MODE_LABELS.map(({ id, label }) => (
          <button
            key={id}
            style={id === mode ? activeBtnStyle : btnStyle}
            onClick={() => switchMode(id)}
            title={`切换到${label}模式`}
          >
            {label}
          </button>
        ))}
      </div>

      <Suspense fallback={<div style={loadingOverlayStyle}>Loading...</div>}>
        {mode === "bbox" ? (
          <BBoxMode />
        ) : mode === "scenegraph" ? (
          <SceneGraphMode />
        ) : (
          <TrajectoryMode />
        )}
      </Suspense>

      {switching && <div style={loadingOverlayStyle}>Loading...</div>}
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

const loadingOverlayStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  zIndex: 50,
  background: "rgba(10,12,24,0.9)",
  color: "#3498db",
  fontFamily: "monospace",
  fontSize: 14,
  padding: "10px 22px",
  borderRadius: 8,
  border: "1px solid rgba(52,152,219,0.4)",
  pointerEvents: "none",
};
