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
  /** Associated scene-graph object (set via SceneGraph Editor). null = unassociated. */
  objectId?: number | null;
  objectLabel?: string | null;
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

// Shared box-visual constants, used by BOTH renderers of the same AABB look:
// the R3F BBoxLayer (point-cloud mode) and the imperative overlay built inside
// GaussianSplatViewer (3DGS mode). Keep them in sync here, not per file.
export const INACTIVE_EDGE_COLOR = "#7a7a7a";
export const INACTIVE_HANDLE_COLOR = "#9a9a9a";
export const INACTIVE_FILL_FACTOR = 0.55;
export const MIN_EDGE_RADIUS = 0.0005;

export function colorForIndex(index: number): string {
  return BBOX_PALETTE[index % BBOX_PALETTE.length]!;
}

let idCounter = 0;
export function newBBoxId(): string {
  idCounter += 1;
  return `bbox_${Date.now().toString(36)}_${idCounter}`;
}

/** One draggable element: a single AABB corner registered for picking. */
export interface DragEntry {
  key: string;
  boxId: string;
  corner: number;
  mesh: THREE.Mesh;
}

/**
 * Move a single corner (bitmask 0..7) of an AABB to an absolute local
 * position. The opposite corner stays fixed, and min/max are recomputed so
 * the box remains a valid AABB (min <= max) at all times.
 */
export function moveCornerTo(box: BBoxItem, corner: number, position: Vec3): BBoxItem {
  const opposite = corner ^ 7;
  const oppPos = cornerPositions(box.min, box.max)[opposite]!;
  return { ...box, min: vecMin(position, oppPos), max: vecMax(position, oppPos) };
}

/** Insert / update / remove a drag entry in the shared registry. */
export function upsertDragEntry(
  list: DragEntry[],
  key: string,
  entry: { boxId: string; corner: number },
  mesh: THREE.Mesh | null,
): void {
  const idx = list.findIndex((h) => h.key === key);
  if (mesh) {
    const full: DragEntry = { key, boxId: entry.boxId, corner: entry.corner, mesh };
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
  object_id: number | null;
  object_label: string | null;
}

export function toBBoxOutput(box: BBoxItem): BBoxOutput {
  return {
    id: box.id,
    label: box.label,
    min: box.min,
    max: box.max,
    object_id: box.objectId ?? null,
    object_label: box.objectLabel ?? null,
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

/**
 * Rebuild a labelled-box list from the backend payload (new or legacy shape):
 * `{boxes: [...]}`, a single `{min, max}` box, or a single
 * `{center_x, ..., size_z}` box. Shared by the BBox Anno mode (editing) and
 * the SceneGraph mode (read-only overlay) so both parse identically.
 */
export function parseBoxes(data: any): BBoxItem[] {
  if (Array.isArray(data.boxes)) {
    const out: BBoxItem[] = [];
    for (const b of data.boxes) {
      if (Array.isArray(b?.min) && Array.isArray(b?.max) && b.min.length === 3 && b.max.length === 3) {
        out.push({
          id: typeof b.id === "string" ? b.id : newBBoxId(),
          label: typeof b.label === "string" ? b.label : "object",
          min: [b.min[0], b.min[1], b.min[2]] as Vec3,
          max: [b.max[0], b.max[1], b.max[2]] as Vec3,
          objectId: typeof b.object_id === "number" ? b.object_id : null,
          objectLabel: typeof b.object_label === "string" ? b.object_label : null,
        });
      }
    }
    return out;
  }

  if (Array.isArray(data.min) && Array.isArray(data.max) && data.min.length === 3 && data.max.length === 3) {
    return [
      {
        id: newBBoxId(),
        label: "object",
        min: [data.min[0], data.min[1], data.min[2]] as Vec3,
        max: [data.max[0], data.max[1], data.max[2]] as Vec3,
      },
    ];
  }

  if (typeof data.center_x === "number" && typeof data.size_x === "number") {
    return [
      {
        id: newBBoxId(),
        label: "object",
        min: [
          data.center_x - data.size_x / 2,
          data.center_y - data.size_y / 2,
          data.center_z - data.size_z / 2,
        ] as Vec3,
        max: [
          data.center_x + data.size_x / 2,
          data.center_y + data.size_y / 2,
          data.center_z + data.size_z / 2,
        ] as Vec3,
      },
    ];
  }

  return [];
}

/**
 * Copy output in the BBOX_PRESETS format consumed by VLA_Diff's orbit planner
 * (orbit_planner_scene_graph7.py): the full Python dict with one entry per
 * box. Associated boxes are keyed by their object id; unassociated boxes fall
 * back to the numeric part of an "object_N" label (list index otherwise). All
 * boxes are copied at once. Centers/sizes use the same Z-up local frame,
 * fixed 3 decimals.
 *
 * Keys must be unique — Python silently drops duplicate dict keys — but an
 * unassociated box's placeholder key can collide with an associated object id
 * (e.g. object_N label N === object id N). Associated ids are the values the
 * planner indexes by, so they stay fixed; placeholder keys are bumped past
 * every collision.
 */
export function formatBboxPresets(boxes: BBoxItem[]): string {
  const used = new Set<number>();
  for (const b of boxes) {
    if (b.objectId != null) used.add(b.objectId);
  }
  const entries = boxes.map((b, index) => {
    const mm = /^object_(\d+)$/.exec(b.label);
    let key = b.objectId != null ? b.objectId : mm ? Number(mm[1]) : index;
    if (b.objectId == null) {
      while (used.has(key)) key += 1;
      used.add(key);
    }
    const r = toBboxResult(b.min, b.max);
    const f = (v: number) => v.toFixed(3);
    const entry =
      `    ${key}: {"center_x": ${f(r.center_x)}, "center_y": ${f(r.center_y)}, "center_z": ${f(r.center_z)}, ` +
      `"size_x": ${f(r.size_x)}, "size_y": ${f(r.size_y)}, "size_z": ${f(r.size_z)}}`;
    // The trailing comment is Python-valid only AFTER the comma.
    return b.objectId != null ? `${entry},  # ${b.objectLabel ?? ""}` : `${entry},`;
  });
  return `BBOX_PRESETS = {\n${entries.join("\n")}\n}`;
}
