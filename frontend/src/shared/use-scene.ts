import { useCallback, useEffect, useState } from "react";

/**
 * Scene selection shared by all three modes. Initial data is bucketed per
 * scene under scenes/<scene>/ on the backend; every data endpoint takes a
 * `scene` query param selecting the bucket.
 *
 * Resolution order for the initial value: the `#scene=` deep-link hash
 * (same mechanism as `#mode=`), then the last selection persisted to
 * localStorage, then the first entry of the /api/scenes listing. Until the
 * listing arrives and validates the selection, `scene` stays "" and callers
 * must hold off their data fetches (pass a null endpoint to useCloudFiles).
 */

const LS_KEY = "3dtool_scene";

function readSceneFromHash(): string | null {
  try {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get(
      "scene",
    );
    if (fromHash) return fromHash;
  } catch {
    /* fall through to localStorage */
  }
  return null;
}

export function useScene(): {
  scenes: string[];
  scene: string;
  setScene: (scene: string) => void;
} {
  const [scenes, setScenes] = useState<string[]>([]);
  const [scene, setSceneState] = useState<string>(
    () => readSceneFromHash() ?? localStorage.getItem(LS_KEY) ?? "",
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/scenes")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setScenes(((j.scenes || []) as { name: string }[]).map((s) => s.name));
      })
      .catch((e) => console.warn("Failed to list scenes:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve an invalid stored/hash selection once the listing is available.
  useEffect(() => {
    if (scenes.length === 0) return;
    if (!scene || !scenes.includes(scene)) {
      setSceneState(scenes[0]!);
    }
  }, [scenes, scene]);

  const setScene = useCallback((next: string) => {
    setSceneState(next);
    try {
      localStorage.setItem(LS_KEY, next);
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  return { scenes, scene, setScene };
}
