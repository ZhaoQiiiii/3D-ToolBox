import { createLocalStorageHook } from "./use-local-storage";
import type { PcdColorScheme } from "./components/PointCloudLayer";

// ---------------------------------------------------------------------------
// ONE set of scene-visualization parameters shared by all three modes.
//
// Previously each mode kept its own pointSize in its own localStorage
// namespace (3dbbox_pointSize / traj_pointSize / sge_disp_pcdPtSize), so
// tuning the point size in one mode had no effect in the others even though
// it is the same scene being rendered. The shared key below makes the
// setting global across modes AND persistent across sessions.
//
// gridSize (gridHelper size) and showAxes were also per-mode before: the
// gridHelper size and the axes visibility were hardcoded independently in
// each mode's Scene component (and only SceneGraph rendered axes at all).
// They live here now so one slider / toggle drives all three modes.
// ---------------------------------------------------------------------------

const useSceneVisualsState = createLocalStorageHook("scene_");

export function useSceneVisuals() {
  const [pointSize, setPointSize] = useSceneVisualsState<number>(
    "pointSize",
    0.06,
  );
  // gridSize is the gridHelper's overall size with a FIXED division count
  // (see SceneGrid), so moving the slider changes the cell spacing — not just
  // the total footprint with cells that always stay 1 unit apart.
  const [gridSize, setGridSize] = useSceneVisualsState<number>("gridSize", 100);
  const [showAxes, setShowAxes] = useSceneVisualsState<boolean>(
    "showAxes",
    true,
  );
  // Point-cloud color scheme (flat / Z-height / X-ray …) shared by all three
  // modes — the "按高度着色" schemes (rainbow/coolwarm/gray) live here.
  const [colorScheme, setColorScheme] = useSceneVisualsState<PcdColorScheme>(
    "colorScheme",
    "flat",
  );
  // Point-cloud opacity — shared so the cloud looks the same in all three
  // modes (BBox/Trajectory used 0.85 while SceneGraph fell back to 0.7).
  const [opacity, setOpacity] = useSceneVisualsState<number>("opacity", 0.85);
  return {
    pointSize,
    setPointSize,
    gridSize,
    setGridSize,
    showAxes,
    setShowAxes,
    colorScheme,
    setColorScheme,
    opacity,
    setOpacity,
  };
}
