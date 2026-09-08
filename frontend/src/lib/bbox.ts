import * as THREE from "three";

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

/** A single annotated object: a labelled 3D AABB. */
export interface BBoxItem {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
}

/** Per-object colour palette; boxes are tinted by their creation order. */
export const BBOX_PALETTE = [
  "#ff5252",
  "#4caf50",
  "#2196f3",
  "#ff9800",
  "#9c27b0",
  "#00bcd4",
  "#e91e63",
  "#cddc39",
  "#795548",
  "#607d8b",
] as const;

export function colorForIndex(index: number): string {
  return BBOX_PALETTE[index % BBOX_PALETTE.length]!;
}

let idCounter = 0;
export function newBBoxId(): string {
  idCounter += 1;
  return `bbox_${Date.now().toString(36)}_${idCounter}`;
}

export type Axis = 0 | 1 | 2;
export type DragKind = "corner" | "edge" | "face" | "center";

/** One face value of an AABB: an axis and its min (0) or max (1) side. */
export interface AxisSide {
  axis: Axis;
  side: 0 | 1;
}

/** One draggable element (corner / edge / face / center) registered for picking. */
export interface DragEntry {
  key: string;
  boxId: string;
  kind: DragKind;
  pairs: AxisSide[];
  mesh: THREE.Mesh;
}

/** The face values a given corner (bitmask 0..7) controls. */
export function cornerPairs(corner: number): AxisSide[] {
  return [
    { axis: 0, side: (corner & 1) as 0 | 1 },
    { axis: 1, side: ((corner >> 1) & 1) as 0 | 1 },
    { axis: 2, side: ((corner >> 2) & 1) as 0 | 1 },
  ];
}

/** The face values an edge controls: the two axes its two corners share. */
export function edgePairs(a: number, b: number): AxisSide[] {
  const pairs: AxisSide[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const sideA = ((a >> axis) & 1) as 0 | 1;
    const sideB = ((b >> axis) & 1) as 0 | 1;
    if (sideA === sideB) pairs.push({ axis: axis as Axis, side: sideA });
  }
  return pairs;
}

/** The single face value a face (axis + side) controls. */
export function facePairs(axis: Axis, side: 0 | 1): AxisSide[] {
  return [{ axis, side }];
}

/** All six face values; moving them together translates the whole box. */
export const CENTER_PAIRS: AxisSide[] = [
  { axis: 0, side: 0 },
  { axis: 0, side: 1 },
  { axis: 1, side: 0 },
  { axis: 1, side: 1 },
  { axis: 2, side: 0 },
  { axis: 2, side: 1 },
];

/**
 * Apply a local-space delta to the given face values of a box. Only the axes
 * listed in `pairs` are moved; `min <= max` is preserved per axis.
 */
export function applyDrag(box: BBoxItem, pairs: AxisSide[], delta: Vec3): BBoxItem {
  const min: Vec3 = [...box.min];
  const max: Vec3 = [...box.max];
  const minNext: Vec3 = [...min];
  const maxNext: Vec3 = [...max];

  for (const { axis, side } of pairs) {
    const d = delta[axis];
    if (side === 0) minNext[axis] = min[axis] + d;
    else maxNext[axis] = max[axis] + d;
  }

  for (let a = 0; a < 3; a++) {
    if (minNext[a] > maxNext[a]) {
      const minMoved = pairs.some((p) => p.axis === a && p.side === 0);
      const maxMoved = pairs.some((p) => p.axis === a && p.side === 1);
      if (minMoved && !maxMoved) minNext[a] = maxNext[a];
      else if (maxMoved && !minMoved) maxNext[a] = minNext[a];
      else {
        const t = minNext[a];
        minNext[a] = maxNext[a];
        maxNext[a] = t;
      }
    }
  }

  return { ...box, min: minNext, max: maxNext };
}

/** Insert / update / remove a drag entry in the shared registry. */
export function upsertDragEntry(
  list: DragEntry[],
  key: string,
  entry: { boxId: string; kind: DragKind; pairs: AxisSide[] },
  mesh: THREE.Mesh | null,
): void {
  const idx = list.findIndex((h) => h.key === key);
  if (mesh) {
    const full: DragEntry = { key, boxId: entry.boxId, kind: entry.kind, pairs: entry.pairs, mesh };
    if (idx >= 0) list[idx] = full;
    else list.push(full);
  } else if (idx >= 0) {
    list.splice(idx, 1);
  }
}

/** Output shape of a single box (AABB + the legacy six-field compatibility). */
export interface BBoxOutput extends BboxResult {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
}

export function toBBoxOutput(box: BBoxItem): BBoxOutput {
  return {
    id: box.id,
    label: box.label,
    min: box.min,
    max: box.max,
    ...toBboxResult(box.min, box.max),
  };
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
