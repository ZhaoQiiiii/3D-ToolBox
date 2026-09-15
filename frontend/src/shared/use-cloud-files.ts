import { useCallback, useEffect, useState } from "react";

// Module-level listing cache (stale-while-revalidate): every mode switch
// remounts the useSceneAssets consumer, and without this cache the fresh
// component starts with an EMPTY listing until the fetch round-trips —
// the scene panel would flash empty and the stale-selection fallbacks
// would run against nothing. Serving the cached list immediately (and
// revalidating in the background) makes the panel — and the selections
// resolved against it — continuous across mode switches.
const listingCache = new Map<string, string[]>();

/**
 * Fetch the cloud/splat file listing served by the backend
 * (`/api/pointcloud-files` and its `/api/scene-pcds` alias). Returns the file
 * names plus a `reload()` that re-fetches (e.g. after switching the cloud
 * data root); filtering by format and stale-selection fallbacks stay with
 * the caller because the modes need different subsets.
 *
 * `loaded` tells whether a listing for the CURRENT endpoint has completed
 * successfully (from cache counts too) — consumers use it to distinguish
 * "listing still loading" from "listing resolved, and it's genuinely
 * empty". On failure it stays false (the stale-selection fallbacks then
 * keep the previous selection instead of wiping it against an unknown
 * listing).
 *
 * Pass `null` as the endpoint to hold off fetching (e.g. while the scene
 * selection has not resolved yet); the effect re-runs once it becomes
 * non-null.
 */
export function useCloudFiles(
  endpoint: string | null,
): { files: string[]; loaded: boolean; reload: () => void } {
  const [files, setFiles] = useState<string[]>(() =>
    endpoint ? (listingCache.get(endpoint) ?? []) : [],
  );
  const [loaded, setLoaded] = useState(() =>
    endpoint ? listingCache.has(endpoint) : false,
  );
  const [version, setVersion] = useState(0);

  // Render-phase adjustment ("derived state", supported React pattern): when
  // the endpoint changes (scene switch), the PREVIOUS scene's listing must
  // not stay observable — this very render's sibling effects (stale-selection
  // fallbacks in useSceneAssets) would resolve the NEW scene's selections
  // against the OLD scene's files, causing a transient 404 on
  // /api/pcd?scene=<new>&name=<old-file>. Re-seed synchronously from the
  // cache (which holds data FOR the new scene) or drop to pending. Idempotent
  // under StrictMode double-render.
  const [prevEndpoint, setPrevEndpoint] = useState(endpoint);
  if (prevEndpoint !== endpoint) {
    setPrevEndpoint(endpoint);
    setFiles(endpoint ? (listingCache.get(endpoint) ?? []) : []);
    setLoaded(endpoint ? listingCache.has(endpoint) : false);
  }

  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    fetch(endpoint)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const names = ((j.files || []) as { name: string }[]).map((f) => f.name);
        listingCache.set(endpoint, names);
        setFiles(names);
        setLoaded(true);
      })
      .catch((e) => console.warn("Failed to list cloud files:", e));
    return () => {
      cancelled = true;
    };
  }, [endpoint, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { files, loaded, reload };
}
