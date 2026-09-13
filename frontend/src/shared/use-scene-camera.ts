import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// ONE camera pose shared by all three modes (BBox / SceneGraph /
// Trajectory).
//
// Mode switches replace the whole canvas content subtree, including the
// <PerspectiveCamera> and controls — every mode remount therefore starts
// from its own hard-coded default viewpoint, which reads as "switching
// modes moves my camera". The canvas itself is persistent (App level), so
// all that is really needed is carrying the pose (camera position + orbit
// target) across those remounts.
//
// This module-level store does exactly that, and nothing more: pose is
// captured on the fly while the user orbits/zooms/flies, and restored on
// the next mode's first frame. All three scenes use the same world frame
// (the Z-up→Y-up rotated scene group with identical extent conventions),
// so one pose is meaningful in every mode. FOV and clip planes stay
// per-mode (rendering concerns, not viewpoint).
//
// The store is in-memory only: a fresh page load starts from each mode's
// default viewpoint.
// ---------------------------------------------------------------------------

export interface SceneCameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

let storedPose: SceneCameraPose | null = null;

/**
 * Inside a mode's canvas content: restore the shared camera pose on the
 * first frame (before anything is rendered), then keep recording the live
 * camera position + orbit target into the shared store.
 *
 * Requires the mode's controls to be registered as the default
 * (OrbitControls `makeDefault`) — both the restore and the tracking need
 * the orbit target, which only the controls own.
 */
export function useSceneCameraPose() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;
  // "restore" until the controls are mounted AND the stored pose (if any)
  // has been applied; then track live changes. Waiting for the controls is
  // essential: restoring only the camera position would leave the orbit
  // target at its default, pointing the camera at the origin.
  const restoredRef = useRef(false);

  useFrame(() => {
    if (!controls) return;
    if (!restoredRef.current) {
      restoredRef.current = true;
      if (storedPose) {
        camera.position.set(...storedPose.position);
        controls.target.set(...storedPose.target);
        controls.update();
      }
      return;
    }
    const { x: px, y: py, z: pz } = camera.position;
    const { x: tx, y: ty, z: tz } = controls.target;
    if (
      !storedPose ||
      storedPose.position[0] !== px ||
      storedPose.position[1] !== py ||
      storedPose.position[2] !== pz ||
      storedPose.target[0] !== tx ||
      storedPose.target[1] !== ty ||
      storedPose.target[2] !== tz
    ) {
      storedPose = {
        position: [px, py, pz],
        target: [tx, ty, tz],
      };
    }
  });
}
