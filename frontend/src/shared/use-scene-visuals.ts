import { createLocalStorageHook } from "./use-local-storage";

// ---------------------------------------------------------------------------
// ONE set of scene-visualization parameters shared by all three modes.
//
// Previously each mode kept its own pointSize in its own localStorage
// namespace (3dbbox_pointSize / traj_pointSize / sge_disp_pcdPtSize), so
// tuning the point size in one mode had no effect in the others even though
// it is the same scene being rendered. The shared key below makes the
// setting global across modes AND persistent across sessions.
// ---------------------------------------------------------------------------

const useSceneVisualsState = createLocalStorageHook("scene_");

export function useSceneVisuals() {
  const [pointSize, setPointSize] = useSceneVisualsState<number>(
    "pointSize",
    0.06,
  );
  return { pointSize, setPointSize };
}
