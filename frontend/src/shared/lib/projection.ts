import * as THREE from "three";

/** World up axes for the two coordinate conventions in this tool:
 * Y-up scenes (BBox/SceneGraph R3F canvases) and the native Z-up
 * gaussian-splats-3D viewer. */
export const Y_UP = new THREE.Vector3(0, 1, 0);
export const Z_UP = new THREE.Vector3(0, 0, 1);

/** World-units per screen pixel at distance `dist` (perspective camera). */
export function worldPerPixel(
  camera: THREE.PerspectiveCamera,
  dist: number,
  viewportHeight: number,
): number {
  return (2 * Math.tan((camera.fov * Math.PI) / 360) * dist) / viewportHeight;
}

/**
 * Intersect a pointer ray with the horizontal plane through `pointOnPlane`
 * (normal = world `up`). Returns the world-space hit or null when the ray
 * runs parallel to the plane.
 */
export function rayHitHorizontalPlane(
  ray: THREE.Ray,
  up: THREE.Vector3,
  pointOnPlane: THREE.Vector3,
): THREE.Vector3 | null {
  const plane = new THREE.Plane(up.clone(), -up.dot(pointOnPlane));
  return ray.intersectPlane(plane, new THREE.Vector3());
}

/**
 * Project a vertical (right-button) drag: keep the anchor's horizontal
 * position fixed and move only along the world `up` axis.
 *
 * Intersects the pointer ray with a camera-facing vertical plane through the
 * anchor. When the camera looks nearly straight down that plane degenerates,
 * so fall back to mapping the screen-space Y delta directly onto the up axis
 * via the world-per-pixel scale.
 *
 * Returns the full new WORLD position, or null if the ray never hits the
 * plane (and the fallback did not apply).
 */
export function verticalDragWorld(
  camera: THREE.PerspectiveCamera,
  ray: THREE.Ray,
  clientX: number,
  clientY: number,
  rect: DOMRect,
  anchorWorld: THREE.Vector3,
  up: THREE.Vector3,
): THREE.Vector3 | null {
  const cameraDir = camera.getWorldDirection(new THREE.Vector3());
  // Horizontal part of the view direction = cameraDir minus its up-component.
  const horiz = cameraDir.clone().addScaledVector(up, -up.dot(cameraDir));

  if (horiz.lengthSq() < 0.04) {
    // Near-top-down: map the screen-space Y delta onto the up axis so the
    // dragged point tracks the pointer instead of flying off-world.
    const dist = camera.position.distanceTo(anchorWorld);
    const wpp = worldPerPixel(camera, dist, rect.height);
    const proj = anchorWorld.clone().project(camera);
    const anchorClientY = rect.top + (1 - (proj.y + 1) / 2) * rect.height;
    const dy = clientY - anchorClientY;
    return anchorWorld.clone().addScaledVector(up, -dy * wpp);
  }

  horiz.normalize();
  const normal = new THREE.Vector3().crossVectors(up, horiz).normalize();
  const plane = new THREE.Plane(normal, -normal.dot(anchorWorld));
  const hit = ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  // Keep the anchor's horizontal position; take only the up-axis component.
  return anchorWorld
    .clone()
    .addScaledVector(up, hit.dot(up) - anchorWorld.dot(up));
}
