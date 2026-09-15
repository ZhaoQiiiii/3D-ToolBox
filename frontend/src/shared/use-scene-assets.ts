import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { loadPcd, loadPly } from "./pcd-loader";
import { detectCloudFormat, splatFormatOf } from "./splat-format";
import { useScene } from "./use-scene";
import { useCloudFiles } from "./use-cloud-files";
import type { SceneRenderMode } from "./components/SceneAssetPanel";

/**
 * The ONE implementation of every scene-rendering concern shared by all
 * three modes (BBox / SceneGraph / Trajectory): scene bucket resolution,
 * asset listing, cloud/splat selection, render mode, and point-cloud
 * loading. Modes only keep their mode-specific state (boxes, snapshots,
 * trajectory steps) on top of this hook.
 *
 * Selection model: dual — one cloud selection (.pcd/.ply, rendered as a
 * point cloud) and one splat selection (.ply/.splat/.ksplat/.spz, rendered
 * as 3DGS); the active render mode decides which one is the "active asset".
 * The selections + render mode live in a module-level store (see below), so
 * they survive mode switches; they are NOT persisted across sessions —
 * files are scene-scoped, and the stale-selection fallbacks below keep the
 * selection valid against the live listing.
 */

// Module-level cache of parsed scene clouds, keyed by
// "<scene>/<file>@<maxPoints>" (the scene prefix disambiguates same-named
// assets in different scenes; the cap suffix disambiguates modes that parse
// the same file at different point budgets).
// App.tsx conditionally renders the mode subtrees, so a useRef cache would
// be destroyed on every mode switch and huge clouds (e.g. a ~6.5M-point
// elec.pcd) would be re-downloaded + re-parsed on each round-trip. Same
// trade-off as GaussianSplatLayer's viewer cache: entries live for the page
// session and are bounded by the number of files under scenes/ — memory
// residency in exchange for instant switching.
const scenePcdCache = new Map<string, Float32Array>();

// ---------------------------------------------------------------------------
// Module-level shared selection store (render mode + cloud/splat selections).
//
// App.tsx conditionally renders the mode subtrees — only ONE of BBox /
// SceneGraph / Trajectory is mounted at a time, so a useState here would be
// destroyed on every mode switch and reset to defaults on remount. The
// user's pick made in one mode (e.g. flyfield.ply + 高斯泼溅) would silently
// revert to the default pointcloud render mode in the next, which reads as
// a bug: "I chose 3DGS, why am I looking at a point cloud now?"
//
// Keeping the selections in this module-level store makes them survive mode
// switches AND stay consistent across every useSceneAssets consumer (only
// one is alive at a time, so there is no cross-instance write contention).
// Like the pcd cache, entries live for the page session only.
// ---------------------------------------------------------------------------

interface SceneSelectionState {
  renderMode: SceneRenderMode;
  selectedCloud: string;
  selectedSplat: string | null;
}

let sceneSelectionState: SceneSelectionState = {
  renderMode: "pointcloud",
  selectedCloud: "",
  selectedSplat: null,
};

const sceneSelectionListeners = new Set<() => void>();

function setSceneSelection(patch: Partial<SceneSelectionState>) {
  sceneSelectionState = { ...sceneSelectionState, ...patch };
  for (const notify of sceneSelectionListeners) notify();
}

function subscribeSceneSelection(notify: () => void) {
  sceneSelectionListeners.add(notify);
  return () => {
    sceneSelectionListeners.delete(notify);
  };
}

function getSceneSelectionState(): SceneSelectionState {
  return sceneSelectionState;
}

export interface UseSceneAssetsOptions {
  /**
   * Fired synchronously before any USER-initiated switch that abandons the
   * currently active asset: scene, cloud file, splat file or render-mode
   * switch. This is the single per-mode hook point — every mode wires the
   * SAME switchers (selectScene/selectCloud/selectSplat/setRenderMode)
   * straight into SceneAssetPanel and only differs in what happens when
   * the annotated asset is left:
   *   - BBox registers this to flush unsaved boxes + reset its edit state;
   *   - SceneGraph's snapshot state is reset by its [scene] effect (which
   *     must also run on the initial scene resolution), so it passes nothing;
   *   - Trajectory is read-only, so it passes nothing.
   * The stale-selection fallbacks inside this hook auto-resolve a vanished
   * file and are NOT user switches — they never fire this callback.
   */
  onAssetLeave?: () => void;
}

/**
 * The single point-cloud sampling budget shared by every mode. Point size /
 * colour / opacity are shared user controls; the NUMBER of points actually
 * parsed must also be identical or the same scene renders at clearly
 * different densities between modes (BBox used to parse at 180k while
 * SceneGraph/Trajectory used 2M).
 */
const SCENE_PCD_MAX_POINTS = 2_000_000;

export function useSceneAssets(options?: UseSceneAssetsOptions) {
  // ---- scene bucket ----
  const { scenes, scene, setScene } = useScene();

  // ---- asset listing of the active scene ----
  const {
    files: allFiles,
    loaded: listingLoaded,
  } = useCloudFiles(
    scene ? `/api/pointcloud-files?scene=${encodeURIComponent(scene)}` : null,
  );
  /** Files the point-cloud loader can parse (.pcd / .ply). */
  const cloudFiles = useMemo(
    () =>
      allFiles.filter((n) => {
        const f = detectCloudFormat(n);
        return f === "pcd" || f === "ply";
      }),
    [allFiles],
  );
  /** Splat-capable assets (superset overlap: .ply is in both lists). */
  const splatFiles = useMemo(
    () => allFiles.filter((n) => splatFormatOf(n) !== null),
    [allFiles],
  );

  // ---- selections + render mode (module-level shared store) ----
  const { renderMode, selectedCloud, selectedSplat } = useSyncExternalStore(
    subscribeSceneSelection,
    getSceneSelectionState,
  );

  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Latest-value ref so the inline options object (recreated every render)
  // never invalidates the switcher callbacks below.
  const onAssetLeaveRef = useRef(options?.onAssetLeave);
  onAssetLeaveRef.current = options?.onAssetLeave;
  const leaveAsset = useCallback(() => {
    onAssetLeaveRef.current?.();
  }, []);

  // Stale-selection fallback: a file that disappears from (or never was in)
  // the listing would 404 — fall back to the first available file. This
  // also picks the initial selection once the listing arrives.
  useEffect(() => {
    if (cloudFiles.length > 0 && !cloudFiles.includes(selectedCloud)) {
      setSceneSelection({ selectedCloud: cloudFiles[0]! });
    }
  }, [cloudFiles, selectedCloud]);

  // Same for the splat side: auto-pick the first splat asset once, and keep
  // the selection valid if the underlying file disappears. Guarded by
  // `listingLoaded`: while the listing is still being fetched (every mode
  // remount) splatFiles is transiently empty, and acting on that would wipe
  // the persisted selection and blank the 3DGS view for no reason.
  useEffect(() => {
    if (!listingLoaded) return;
    if (splatFiles.length === 0) {
      if (selectedSplat !== null) setSceneSelection({ selectedSplat: null });
      return;
    }
    if (!selectedSplat || !splatFiles.includes(selectedSplat)) {
      setSceneSelection({ selectedSplat: splatFiles[0]! });
    }
  }, [listingLoaded, splatFiles, selectedSplat]);

  // A 3dgs render mode is useless (and would show an empty scene) when the
  // scene holds no splat assets — fall back to pointcloud. Only fires once
  // the listing actually resolved.
  useEffect(() => {
    if (renderMode === "3dgs" && allFiles.length > 0 && splatFiles.length === 0) {
      setSceneSelection({ renderMode: "pointcloud" });
    }
  }, [renderMode, allFiles, splatFiles]);

  // User-facing switchers — the ONE switching pipeline shared by all three
  // modes. Each of them abandons the currently active asset, so each fires
  // the mode's onAssetLeave first (flush of per-asset edit state); the
  // scene switch additionally resets the per-scene selections (the
  // fallback effects above re-resolve them against the new scene's
  // listing).
  const selectScene = useCallback(
    (next: string) => {
      if (next === sceneRef.current) return;
      leaveAsset();
      setSceneSelection({ selectedCloud: "", selectedSplat: null });
      setScene(next);
    },
    [setScene, leaveAsset],
  );

  const selectCloud = useCallback(
    (name: string) => {
      leaveAsset();
      setSceneSelection({ selectedCloud: name });
    },
    [leaveAsset],
  );

  const selectSplat = useCallback(
    (name: string | null) => {
      if (name === null) return;
      leaveAsset();
      setSceneSelection({ selectedSplat: name });
    },
    [leaveAsset],
  );

  const setRenderMode = useCallback(
    (mode: SceneRenderMode) => {
      const current = getSceneSelectionState();
      const prevName =
        current.renderMode === "pointcloud"
          ? current.selectedCloud
          : (current.selectedSplat ?? "");
      const nextName =
        mode === "pointcloud"
          ? current.selectedCloud
          : (current.selectedSplat ?? "");
      // Only treat it as an asset leave when the render-mode switch actually
      // changes the active asset. A .ply file is both a point cloud and a
      // splat, so toggling render mode for the SAME file must not fire
      // onAssetLeave — otherwise BBox flushes+clears its boxes while
      // activeName stays unchanged, so the auto-load never re-runs and the
      // boxes vanish until a full reload.
      if (prevName !== nextName) {
        leaveAsset();
      }
      setSceneSelection({ renderMode: mode });
    },
    [leaveAsset],
  );

  // ---- the active asset (per render mode) ----
  const activeName =
    renderMode === "pointcloud" ? selectedCloud : (selectedSplat ?? "");
  const activeFormat = activeName ? detectCloudFormat(activeName) : null;
  const activeUrl =
    activeName && scene
      ? `/api/pcd?scene=${encodeURIComponent(scene)}&name=${encodeURIComponent(activeName)}`
      : null;

  // ---- point-cloud loading (module-cached) ----
  // Lazy initial state: on a mode-switch remount the scene + selections are
  // already resolved (module-level store) and the parsed cloud is usually
  // cached — seeding the state from the cache means the FIRST render (the
  // one whose scene content goes into the shared canvas) already has the
  // points, instead of a mount → effect → setState round-trip during which
  // the canvas would briefly show nothing.
  const [positions, setPositions] = useState<Float32Array | null>(() =>
    scene && selectedCloud && renderMode === "pointcloud"
      ? (scenePcdCache.get(`${scene}/${selectedCloud}@${SCENE_PCD_MAX_POINTS}`) ?? null)
      : null,
  );
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  useEffect(() => {
    // No selection / unresolved scene: nothing to render — drop the previous
    // scene's points so they can't bleed into the new scene's view.
    if (!selectedCloud || !scene) {
      setPositions(null);
      setCloudLoading(false);
      setCloudError(null);
      return;
    }
    // While the 3DGS renderer is active there is nothing to render into;
    // keep the already-loaded positions so switching back is instant. The
    // effect re-runs and refreshes on the switch back.
    if (renderMode !== "pointcloud") {
      setCloudLoading(false);
      return;
    }

    // Stale-response guard: switching files mid-load must not let the old
    // (slower) fetch overwrite the new one's result.
    let cancelled = false;

    const cacheKey = `${scene}/${selectedCloud}@${SCENE_PCD_MAX_POINTS}`;
    const cached = scenePcdCache.get(cacheKey);
    if (cached) {
      setPositions(cached);
      setCloudLoading(false);
      return;
    }
    setCloudLoading(true);
    setCloudError(null);
    const url = `/api/pcd?scene=${encodeURIComponent(scene)}&name=${encodeURIComponent(selectedCloud)}`;
    (selectedCloud.toLowerCase().endsWith(".pcd")
      ? loadPcd(url, SCENE_PCD_MAX_POINTS)
      : loadPly(url, SCENE_PCD_MAX_POINTS)
    )
      .then((r) => {
        // The parsed cloud is a pure function of the file content, so cache
        // it even when this run was cancelled — a quick A→B→A switch then
        // hits the cache instead of re-downloading/re-parsing A. Only the
        // state updates below need the cancelled guard.
        scenePcdCache.set(cacheKey, r.positions);
        if (cancelled) return;
        setPositions(r.positions);
        setCloudLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Drop the previous asset's points: rendering them under the error
        // banner would look like the new file loaded fine.
        setPositions(null);
        setCloudError(e instanceof Error ? e.message : String(e));
        setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [renderMode, selectedCloud, scene]);

  return {
    // scene bucket
    scenes,
    scene,
    selectScene,
    // listings
    cloudFiles,
    splatFiles,
    // render mode
    renderMode,
    setRenderMode,
    // selections (user-facing switchers; all fire onAssetLeave)
    selectedCloud,
    selectCloud,
    selectedSplat,
    selectSplat,
    // active asset (per render mode)
    activeName,
    activeFormat,
    activeUrl,
    // pointcloud loading (module-cached)
    positions,
    cloudLoading,
    cloudError,
  };
}
