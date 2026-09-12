import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { FORMAT_TO_SCENE_FORMAT, type SplatFormat } from "../splat-format";

// ---------------------------------------------------------------------------
// Single-instance in-page cache.
//
// Loading a Gaussian splat scene (fetch + parse + GPU texture upload) is the
// expensive part — for a ~450MB PLY it takes many seconds. The library keeps
// the parsed buffers and uploaded textures alive as long as the DropInViewer
// instance lives, and simply re-attaching a kept-alive viewer renders
// instantly (no network, no re-parse, no texture re-upload).
//
// So we cache exactly ONE viewer (the currently-selected file). Unmounting a
// layer detaches the viewer from its parent group but does NOT dispose it, so
// toggling render mode back reuses it. Switching to a different file replaces
// the cached entry and disposes the previous one.
// ---------------------------------------------------------------------------

interface CacheEntry {
  src: string;
  format: SplatFormat;
  viewer: GaussianSplats3D.DropInViewer;
  ready: Promise<void>;
}

let cache: CacheEntry | null = null;

function createViewer(src: string, format: SplatFormat): CacheEntry {
  const viewer = new GaussianSplats3D.DropInViewer({
    // Avoid SharedArrayBuffer / cross-origin-isolation requirements
    // (the Vite dev server sends no COOP/COEP headers).
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
    integerBasedSort: false,
  });
  const ready = viewer
    .addSplatScene(src, {
      format: FORMAT_TO_SCENE_FORMAT[format],
      showLoadingUI: false,
    })
    .then(() => undefined);
  return { src, format, viewer, ready };
}

/** Get the cached viewer for `src`, creating (and caching) it if needed. */
function getViewer(src: string, format: SplatFormat): CacheEntry {
  if (cache && cache.src === src) {
    return cache;
  }
  // Replacing the cache with a different file: dispose the previous viewer to
  // free its GPU textures / workers. Only the single current entry is kept.
  if (cache) {
    try {
      void cache.viewer.viewer.dispose().catch(() => undefined);
    } catch {
      /* teardown may throw during in-flight download; ignore */
    }
  }
  cache = createViewer(src, format);
  return cache;
}

/**
 * Dispose the module-level splat cache. Called when a mode that uses this
 * layer unmounts (mode switch): the cached viewer holds GPU textures for the
 * currently-loaded file (~450MB PLY parsed + uploaded), and other modes load
 * their own copy of the same scene — keeping both would double GPU memory.
 * Disposing here means switching back re-parses the file, which is the
 * accepted trade-off.
 */
export function disposeSplatCache(): void {
  if (!cache) return;
  const entry = cache;
  cache = null;
  // Detach from any parent group first so a mid-flight render can't touch
  // disposed GPU resources.
  if (entry.viewer.parent) entry.viewer.parent.remove(entry.viewer);
  try {
    void entry.viewer.viewer.dispose().catch(() => undefined);
  } catch {
    /* teardown may throw during in-flight download; ignore */
  }
}

/**
 * 3DGS render layer for the R3F canvas.
 *
 * Uses the library's DropInViewer (a THREE.Group subclass), mounted inside a
 * plain <group> so the splat scene shares the host scene graph — same camera,
 * same OrbitControls, and (crucially) the same Z-up→Y-up rotated group as
 * the PCD layers, keeping coordinates aligned between render modes. No
 * self-driven RAF: sorting is driven by the host render loop through the
 * viewer's internal onBeforeRender callback mesh.
 *
 * The viewer is kept in a module-level single-instance cache (see above), so
 * unmounting this layer only detaches the viewer — switching back re-renders
 * instantly without re-downloading/re-parsing the scene.
 */
export function GaussianSplatLayer({
  src,
  format,
  onLoadingChange,
  onError,
  onViewer,
}: {
  src: string;
  format: SplatFormat;
  onLoadingChange?: (loading: boolean) => void;
  onError?: (message: string | null) => void;
  /**
   * Notified with the internal DropInViewer when it becomes active (so
   * consumers can raycast against the splat surface) and with null on
   * cleanup / source change.
   */
  onViewer?: (viewer: GaussianSplats3D.DropInViewer | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  // Keep the callback in a ref: the effect below intentionally only re-runs
  // on src/format changes, so it must always see the latest callback.
  const onViewerRef = useRef(onViewer);
  onViewerRef.current = onViewer;

  useEffect(() => {
    const parent = groupRef.current;
    if (!parent) return;

    let disposed = false;
    let attached = false;

    // Reuse (or create) the cached viewer for this file.
    const entry = getViewer(src, format);
    onViewerRef.current?.(entry.viewer);

    onLoadingChange?.(true);
    onError?.(null);

    entry.ready
      .then(() => {
        if (disposed) return;
        parent.add(entry.viewer);
        attached = true;
        onLoadingChange?.(false);
      })
      .catch((e: unknown) => {
        if (disposed) return;
        onLoadingChange?.(false);
        onError?.(e instanceof Error ? e.message : String(e));
        // Evict the failed entry: otherwise re-selecting the same file hits
        // the cache and replays this same rejected promise forever, making a
        // retry (e.g. after a transient network error) impossible.
        if (cache === entry) {
          cache = null;
          try {
            void entry.viewer.viewer.dispose().catch(() => undefined);
          } catch {
            /* teardown may throw during in-flight download; ignore */
          }
        }
      });

    return () => {
      disposed = true;
      onViewerRef.current?.(null);
      // Detach only — do NOT dispose. The cached viewer stays alive so
      // toggling render mode back renders instantly from its GPU buffers.
      if (attached) parent.remove(entry.viewer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, format]);

  return <group ref={groupRef} />;
}
