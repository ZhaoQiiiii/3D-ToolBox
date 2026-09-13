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

  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    // Serve the cached entry synchronously on remount (see listingCache).
    const cached = listingCache.get(endpoint);
    if (cached) {
      setFiles(cached);
      setLoaded(true);
    }
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
