import { useCallback, useEffect, useState } from "react";

/**
 * Fetch the cloud/splat file listing served by the backend
 * (`/api/pointcloud-files` and its `/api/scene-pcds` alias). Returns the file
 * names plus a `reload()` that re-fetches (e.g. after switching the cloud
 * data root); filtering by format and stale-selection fallbacks stay with
 * the caller because the modes need different subsets.
 */
export function useCloudFiles(
  endpoint: string,
): { files: string[]; reload: () => void } {
  const [files, setFiles] = useState<string[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setFiles(((j.files || []) as { name: string }[]).map((f) => f.name));
      })
      .catch((e) => console.warn("Failed to list cloud files:", e));
    return () => {
      cancelled = true;
    };
  }, [endpoint, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { files, reload };
}
