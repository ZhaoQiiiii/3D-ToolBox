import { useEffect } from "react";
import type { RefObject } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Fly/look camera navigation shared by all three modes (BBox / SceneGraph /
// Trajectory), so cursor dragging behaves identically everywhere:
//
//   left-drag  → FPS look-around (camera stays in place, view rotates;
//                OrbitControls' own left-button rotate is disabled)
//   wheel      → fly forward/back along the view direction (no distance
//                limits; OrbitControls' own zoom must be disabled)
//   right-drag → pan (still owned by OrbitControls)
//
// Entity gestures keep priority: any interaction that disables the shared
// controls (box corner drags, trajectory grabs, node/object drags) makes the
// look controller bail out for that gesture. The camera pose itself is
// carried across modes by use-scene-camera.ts.
// ---------------------------------------------------------------------------

/**
 * Fly-style wheel navigation: scrolling translates the camera along its view
 * direction (the orbit pivot moves with it) instead of OrbitControls' dolly
 * toward a fixed target. No min/max distance limits — you can fly through
 * the scene. OrbitControls still owns rotate/pan; its own zoom is disabled.
 */
export function FlyWheelController({
  controlsRef,
}: {
  controlsRef: RefObject<any>;
}) {
  const { gl, camera } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    const forward = new THREE.Vector3();

    const onWheel = (e: WheelEvent) => {
      const controls = controlsRef.current;
      if (!controls) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      // Wheel deltas arrive in pixels (mode 0), lines (1) or pages (2).
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 100;

      // Step scales with the camera→pivot distance: fast when far away,
      // fine-grained up close. Floor of 2 keeps movement alive when the
      // pivot is (almost) at the camera.
      camera.getWorldDirection(forward);
      const dist = camera.position.distanceTo(controls.target);
      const step = -dy * 0.0002 * Math.max(dist, 2);
      forward.multiplyScalar(step);
      camera.position.add(forward);
      controls.target.add(forward);
      controls.update();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [gl, camera, controlsRef]);

  return null;
}

/**
 * FPS-style look-around: left-drag rotates the view in place (camera position
 * fixed, the orbit pivot rotates with the view direction) instead of orbiting
 * around the pivot. Entity dragging keeps priority: gestures that disable the
 * controls make this bail out, so draggable entities keep dragging instead of
 * rotating the camera. Plain left clicks still reach click handlers
 * (select / pick / place).
 */
export function LookRotateController({
  controlsRef,
  rotateSpeed = 1.5,
}: {
  controlsRef: RefObject<any>;
  rotateSpeed?: number;
}) {
  const { gl, camera } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    let active = false;
    let lastX = 0;
    let lastY = 0;
    const offset = new THREE.Vector3();
    const right = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);

    // OrbitControls must not also orbit on left-drag (touch keeps ROTATE).
    const controls0 = controlsRef.current;
    if (controls0) (controls0.mouseButtons as Record<string, number>).LEFT = -1;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== "mouse") return;
      const controls = controlsRef.current;
      if (!controls || !controls.enabled) return;
      active = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!active) return;
      const controls = controlsRef.current;
      // Entity gestures disable the controls — bail out so dragging an
      // entity keeps moving it instead of rotating the camera.
      if (!controls || !controls.enabled) {
        active = false;
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx === 0 && dy === 0) return;

      // Same direction mapping as OrbitControls: drag right → look right,
      // drag down → look down.
      const yaw = (-2 * Math.PI * dx * rotateSpeed) / canvas.clientHeight;
      const pitch = (-2 * Math.PI * dy * rotateSpeed) / canvas.clientHeight;

      // Rotate the pivot offset about the fixed camera position.
      offset.copy(controls.target).sub(camera.position);
      offset.applyAxisAngle(UP, yaw);
      right.crossVectors(offset, UP);
      if (right.lengthSq() > 1e-8) {
        right.normalize();
        const beforeX = offset.x;
        const beforeY = offset.y;
        const beforeZ = offset.z;
        offset.applyAxisAngle(right, pitch);
        // Clamp near the poles so the view can't flip over zenith/nadir.
        if (Math.abs(offset.y / offset.length()) > 0.995) {
          offset.set(beforeX, beforeY, beforeZ);
        }
      }
      controls.target.copy(camera.position).add(offset);
      controls.update();
    };

    const end = () => {
      active = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [gl, camera, controlsRef, rotateSpeed]);

  return null;
}
