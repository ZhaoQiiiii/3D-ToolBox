import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Cross-reconciler scene slot.
//
// The application keeps ONE persistent <Canvas> at the App level: mode
// switches (BBox ↔ SceneGraph ↔ Trajectory) swap the canvas CONTENT, never
// the canvas itself. This is what makes the whole "switch modes without
// reloading the scene" story work:
//
//   - R3F force-losses the WebGL context when a Canvas unmounts, killing
//     every GPU resource created in it (3DGS viewer textures/buffers, point
//     cloud GPU attributes). A per-mode Canvas therefore forced a full
//     reload on every mode switch — the expensive splat parse + upload
//     included, even though all module-level caches were still warm.
//   - With the Canvas living at App level, `gl` (the WebGLRenderer) stays
//     the same object for the whole page session: the 3DGS viewer cache
//     keyed by renderer keeps hitting, point clouds re-attach from CPU
//     caches instantly, and the only thing that actually changes between
//     modes is the scene graph.
//
// Mechanism: DOM-reconciler components (the modes, which also own DOM
// overlays) cannot render into the R3F tree directly — the R3F Canvas runs
// its own reconciler on a separate root. <CanvasSlot/> (rendered INSIDE the
// persistent Canvas) publishes a module-level setter; useCanvasSlot(node)
// (called from a DOM component) pushes its 3D content through that setter.
// React elements are plain objects, so the node created by the DOM world is
// committed by the R3F reconciler without either side importing the other's
// tree.
// ---------------------------------------------------------------------------

let setSlotContent: ((node: ReactNode) => void) | null = null;

/**
 * Rendered inside the persistent App-level <Canvas>. Hosts whatever the
 * active mode pushed through useCanvasSlot().
 */
export function CanvasSlot() {
  const [content, setContent] = useState<ReactNode>(null);
  useEffect(() => {
    setSlotContent = setContent;
    return () => {
      setSlotContent = null;
    };
  }, []);
  return <>{content}</>;
}

/**
 * From a DOM-side mode component: render `node` into the shared persistent
 * canvas. Re-invoked on every render so the scene content tracks the mode's
 * state.
 *
 * The cleanup deliberately does NOT clear the slot: between the outgoing
 * mode's unmount and the incoming mode's first effect there is a gap
 * (Suspense fallback for a not-yet-loaded chunk included), and blanking the
 * canvas there is exactly the "scene flashes away for a moment" artifact.
 * Instead the previous content keeps rendering until the next setup call
 * overwrites it — mode switches are visually seamless by construction.
 */
export function useCanvasSlot(node: ReactNode) {
  useEffect(() => {
    setSlotContent?.(node);
  });
}
