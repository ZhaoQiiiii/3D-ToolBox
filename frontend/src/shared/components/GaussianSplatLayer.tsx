import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { FORMAT_TO_SCENE_FORMAT, type SplatFormat } from "../splat-format";

// ---------------------------------------------------------------------------
// Per-file in-page cache.
//
// Loading a Gaussian splat scene (fetch + parse + GPU texture upload) is the
// expensive part — for a ~450MB PLY it takes many seconds. The library keeps
// the parsed buffers and uploaded textures alive as long as the DropInViewer
// instance lives, and simply re-attaching a kept-alive viewer renders
// instantly (no network, no re-parse, no texture re-upload).
//
// So we cache one viewer PER FILE: unmounting a layer detaches the viewer
// from its parent group but does NOT dispose it, and switching between splat
// files or modes re-attaches the cached viewer instantly. Entries live for
// the whole page session (single boot) and are only released when the page
// is reloaded / the tab is closed.
//
// The cache key is the FILE NAME, not the request URL: the three modes fetch
// the same scenes/ asset through different query shapes
// (/api/pcd?name=X vs /api/pcd?source=scene&name=X), so keying by URL would
// re-download the same file on every mode switch.
// ---------------------------------------------------------------------------

interface CacheEntry {
  src: string;
  format: SplatFormat;
  viewer: GaussianSplats3D.DropInViewer;
  ready: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Normalize a splat src to a per-file cache key. Scene assets always carry
 * the file name in the `name` query param; anything else keys by full URL.
 */
function cacheKeyOf(src: string): string {
  try {
    const name = new URL(src, "http://local").searchParams.get("name");
    if (name) return `scene:${name}`;
  } catch {
    /* fall through to raw src */
  }
  return src;
}

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
  const key = cacheKeyOf(src);
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const entry = createViewer(src, format);
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
  }, [src, format]);

  return <group ref={groupRef} />;
}
