import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { FORMAT_TO_SCENE_FORMAT, type SplatFormat } from "../splat-format";

// ---------------------------------------------------------------------------
// Per-file, per-Canvas in-page cache.
//
// Loading a Gaussian splat scene (fetch + parse + GPU texture upload) is the
// expensive part — for a ~450MB PLY it takes many seconds. The library keeps
// the parsed buffers and uploaded textures alive as long as the DropInViewer
// instance lives, and re-attaching a kept-alive viewer to the SAME Canvas
// renders instantly (no network, no re-parse, no texture re-upload).
//
// Viewers are, however, bound to the WebGL context of the Canvas they were
// first rendered in: R3F force-losses the context when a Canvas unmounts,
// so a cached viewer is DEAD GPU-wise after a mode switch (each mode owns
// its own <Canvas>). Re-attaching a dead viewer shows nothing AND never
// loads (its ready promise is already resolved) — so cache entries are
// keyed by FILE and validated against the current renderer. A mismatch
// (new Canvas) evicts the dead viewer and takes the normal load path;
// the same renderer (render-mode toggle within one mode) re-attaches
// instantly.
//
// The cache key is the SCENE + FILE NAME, not the request URL: the three
// modes fetch the same scenes/<scene>/ asset through different query shapes
// (/api/pcd?scene=X&name=Y vs /api/pcd?scene=X&source=scene&name=Y), so
// keying by URL would re-download the same file on every mode switch; and
// keying by file name alone would collide across scenes holding an asset
// with the same name.
// ---------------------------------------------------------------------------

interface CacheEntry {
  src: string;
  format: SplatFormat;
  /** The Canvas (WebGL renderer) this viewer's GPU resources live in. */
  renderer: THREE.WebGLRenderer;
  viewer: GaussianSplats3D.DropInViewer;
  ready: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Normalize a splat src to a per-file cache key. Scene assets always carry
 * the file name in the `name` query param (plus the `scene` bucket); anything
 * else keys by full URL.
 */
function cacheKeyOf(src: string): string {
  try {
    const u = new URL(src, "http://local");
    const name = u.searchParams.get("name");
    if (name) {
      const scene = u.searchParams.get("scene");
      return scene ? `scene:${scene}/${name}` : `scene:${name}`;
    }
  } catch {
    /* fall through to raw src */
  }
  return src;
}

function createViewer(
  src: string,
  format: SplatFormat,
  renderer: THREE.WebGLRenderer,
): CacheEntry {
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
  return { src, format, renderer, viewer, ready };
}

/**
 * Get the cached viewer for `src` on the CURRENT Canvas (`renderer`),
 * creating (and caching) it if needed. A cached entry bound to a different
 * renderer belongs to an unmounted Canvas whose WebGL context R3F has
 * force-lossed — its GPU resources are gone, so it is disposed and replaced
 * (the fresh viewer takes the normal load path, with loading UI).
 */
function getViewer(
  src: string,
  format: SplatFormat,
  renderer: THREE.WebGLRenderer,
): CacheEntry {
  const key = cacheKeyOf(src);
  const existing = cache.get(key);
  if (existing) {
    if (existing.renderer === renderer) {
      return existing;
    }
    cache.delete(key);
    try {
      // The typings don't expose DropInViewer.dispose(); the internal
      // viewer has the same async teardown (see the error-eviction path).
      void existing.viewer.viewer.dispose().catch(() => undefined);
    } catch {
      /* teardown may throw for a dead-context viewer; ignore */
    }
  }
  const entry = createViewer(src, format, renderer);
  cache.set(key, entry);
  return entry;
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
 * The viewer is kept in a module-level per-file cache (see above), so
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
  // The host Canvas's WebGL renderer — identity of the WebGL context the
  // viewer's GPU resources must live in (see the cache notes above).
  const { gl } = useThree();
  // Keep the callback in a ref: the effect below intentionally only re-runs
  // on src/format/renderer changes, so it must always see the latest callback.
  const onViewerRef = useRef(onViewer);
  onViewerRef.current = onViewer;

  useEffect(() => {
    const parent = groupRef.current;
    if (!parent) return;

    let disposed = false;
    let attached = false;

    // Reuse (or create) the cached viewer for this file on this Canvas.
    const entry = getViewer(src, format, gl);
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
        const key = cacheKeyOf(src);
        if (cache.get(key) === entry) {
          cache.delete(key);
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
  }, [src, format, gl]);

  return <group ref={groupRef} />;
}
