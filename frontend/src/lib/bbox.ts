/**
 * AABB helpers for bbox_picker.
 *
 * The single source of truth is a pair of diagonal corners in point-cloud
 * local coordinates (Z-up). Everything else (8 corners, 12 edges, center,
 * size, output JSON) is derived from that pair, matching the old
 * `bbox_picker.py` formulas exactly so downstream stays compatible.
 */

export type Vec3 = [number, number, number];

export interface BboxResult {
  center_x: number;
  center_y: number;
  center_z: number;
  size_x: number;
  size_y: number;
  size_z: number;
}

/** Round a value to 3 decimals (mirrors `round(value, 3)` in bbox_picker.py). */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Component-wise min of two local points. */
export function vecMin(a: Vec3, b: Vec3): Vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

/** Component-wise max of two local points. */
export function vecMax(a: Vec3, b: Vec3): Vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

/** The 8 corners of an AABB, indexed by (x,y,z) bitmask 0..7. */
export function cornerPositions(min: Vec3, max: Vec3): Vec3[] {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([
      i & 1 ? max[0] : min[0],
      (i >> 1) & 1 ? max[1] : min[1],
      (i >> 2) & 1 ? max[2] : min[2],
    ]);
  }
  return corners;
}

/** 12 edges of a box, as pairs of corner indices. */
export function boxEdges(): [number, number][] {
  return [
    [0, 1], [2, 3], [4, 5], [6, 7], // x edges
    [0, 2], [1, 3], [4, 6], [5, 7], // y edges
    [0, 4], [1, 5], [2, 6], [3, 7], // z edges
  ];
}

export function centerOf(min: Vec3, max: Vec3): Vec3 {
  return [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
}

export function sizeOf(min: Vec3, max: Vec3): Vec3 {
  return [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
}

export function toBboxResult(min: Vec3, max: Vec3): BboxResult {
  const c = centerOf(min, max);
  const s = sizeOf(min, max);
  return {
    center_x: round3(c[0]),
    center_y: round3(c[1]),
    center_z: round3(c[2]),
    size_x: round3(s[0]),
    size_y: round3(s[1]),
    size_z: round3(s[2]),
  };
}

/** The exact JSON line the old script printed. */
export function formatBboxJson(min: Vec3, max: Vec3): string {
  return JSON.stringify(toBboxResult(min, max));
}
