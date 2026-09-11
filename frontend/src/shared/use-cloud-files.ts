import { useEffect, useState } from "react";

/**
 * Fetch the cloud/splat file listing served by the backend
 * (`/api/pointcloud-files` and its `/api/scene-pcds` alias). Returns the file
 * names; filtering by format and stale-selection fallbacks stay with the
 * caller because the two modes need different subsets.
 */
export function useCloudFiles(endpoint: string): string[] {
  const [files, setFiles] = useState<string[]>([]);
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
  }, [endpoint]);
  return files;
}
