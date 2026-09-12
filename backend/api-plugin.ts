/**
 * Vite plugin that adds every HTTP endpoint used by 3D-BBox-Tool (dual mode).
 *
 * ── BBox annotation mode ──────────────────────────────────────────────
 * - GET  /api/pointcloud-files     → list cloud/splat files under scenes/
 * - GET  /api/pcd?name=elec.ply    → stream a scene asset from scenes/
 * - GET  /api/bbox?name=elec.ply   → load saved labelled boxes for an asset
 * - POST /api/bbox                 → persist labelled boxes (per-asset + legacy)
 *
 * ── SceneGraph edit mode ──────────────────────────────────────────────
 * Snapshot data lives in the bundled scene_graph/ directory:
 * scene_graph_saved/ is read-only source data; exports always go to
 * scene_graph_exported/ under the same root.
 *
 * - GET  /api/scene-pcds                   → alias of /api/pointcloud-files
 * - GET  /api/pcd?snapshot=X&path=objects/… → per-object cloud (exported/ first)
 * - GET  /api/pcd?source=scene&name=X      → scene asset from scenes/
 * - GET  /api/snapshot | /api/snapshots    → latest / all snapshots
 * - GET  /api/scene-graph                   → scene_graph.json (exported/ first)
 * - POST /api/export                        → apply mutations, write exported/
 * - POST /api/log                           → client-side event sink
 *
 * ── Trajectory visualization mode ────────────────────────────────────
 * Browsing is fixed to trajectories/ (TRAJ_ROOT): the UI walks worldmodel
 * flight_…/step_… directories under it. Everything is strictly read-only;
 * only whitelisted well-known artifact names can be read out of a step dir,
 * and every requested path must stay inside TRAJ_ROOT.
 *
 * - GET  /api/traj-browse?path=…  → smart listing (step/flight/dir levels)
 * - GET  /api/traj-file?path=…&name=…    → whitelisted step JSON artifacts
 * - GET  /api/traj-asset?path=…&name=…   → anchor.jpg / video.mp4 (Range-capable)
 *
 * Route split for /api/pcd: SceneGraph-mode requests always carry `snapshot`
 * or `source`; a plain `?name=` belongs to the BBox mode. The split is made
 * on that explicit criteria (NOT query shape guessing).
 */
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  createReadStream,
  renameSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve, basename, isAbsolute, sep } from "node:path";
import type {
  MovePoly,
  EdgeRef,
  CreatePoly,
  CreateObject,
  UpdateObjectLabel,
  UpdateObjectFatherPoly,
  UpdateObjectPosition,
  UpdateObjectId,
  UpdateArea,
  UpdateObjectColor,
  Mutations,
  ExportRequest,
} from "../frontend/src/modes/scenegraph/lib/types";

type V3 = [number, number, number];

// ---- shared helpers ----

/** Reject bodies larger than this so a hostile payload can't OOM the dev server. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolvePromise(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: any): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * A file name is a single directory component (no separators, no "..").
 * Names flow directly into path joins, so reject anything that could
 * escape the scenes/ or snapshot directories.
 */
function isValidFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/** Snapshot names face the same constraint (single directory component). */
function isValidSnapshotName(name: unknown): name is string {
  return isValidFileName(name);
}

/**
 * Whitelist for cloud/splat asset file names served by /api/pcd. Restricting
 * to known point-cloud / gaussian-splat extensions prevents arbitrary files
 * in scenes/ (e.g. .env, .json) from being read through the endpoint.
 */
const CLOUD_FILE_RE = /\.(pcd|ply|splat|ksplat|spz)$/i;

function isCloudFileName(name: string): boolean {
  return CLOUD_FILE_RE.test(name);
}

/** Any asset extension the BBox tool knows (used for bbox persistence keys). */
function isKnownAssetName(name: string): boolean {
  return CLOUD_FILE_RE.test(name);
}

// ---- Trajectory mode (worldmodel flight/step browsing) ----

/**
 * Whitelist of the well-known artifact file names a step directory contains.
 * The step directory PATH is user-supplied (arbitrary server path — local dev
 * tool), but only these exact names can ever be read out of it: no arbitrary
 * file read, no directory listing of unrelated files.
 */
const TRAJ_JSON_FILES = new Set([
  "trajectory.json",
  "prompt.json",
  "result.json",
  "wm_result.json",
  "target_extraction.json",
  "video_response.json",
  "lidar_depth.json",
]);

/** Binary artifacts with their serving content types. */
const TRAJ_ASSET_TYPES: Record<string, string> = {
  "anchor.jpg": "image/jpeg",
  "video.mp4": "video/mp4",
};

/**
 * Validate a trajectory directory path: must be absolute, free of NUL bytes
 * and — after resolving `..` — inside the fixed TRAJ_ROOT. Browsing anywhere
 * else on the server is rejected.
 */
function trajPathWithin(root: string, p: unknown): p is string {
  if (
    typeof p !== "string" ||
    p.length === 0 ||
    p.includes("\0") ||
    !isAbsolute(p)
  ) {
    return false;
  }
  const r = resolve(p);
  return r === root || r.startsWith(root + sep);
}

/** Step availability info for browse listings. */
function trajStepInfo(dir: string): {
  name: string;
  path: string;
  hasTrajectory: boolean;
  hasVideo: boolean;
} {
  const has = (f: string) => {
    try {
      statSync(join(dir, f));
      return true;
    } catch {
      return false;
    }
  };
  return {
    name: basename(dir),
    path: dir,
    hasTrajectory: has("trajectory.json"),
    hasVideo: has("video.mp4"),
  };
}

/**
 * Stream a binary asset with HTTP Range support so <video> seeking works.
 * Video elements issue Range requests; without 206 responses scrubbing breaks.
 */
function streamTrajAsset(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  rangeHeader: string | undefined,
): void {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    sendJson(res, 404, { success: false, error: "File not found" });
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (range) {
    const start = range[1] === "" ? 0 : parseInt(range[1]!, 10);
    const rawEnd = range[2] === "" ? size - 1 : parseInt(range[2]!, 10);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(rawEnd) ||
      start < 0 ||
      start > rawEnd ||
      start >= size
    ) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const end = Math.min(rawEnd, size - 1);
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
  });
  createReadStream(filePath).pipe(res);
}

/** Validate the POSTed boxes array (the shape toBBoxOutput produces). */
function isValidBoxes(boxes: unknown): boxes is Array<Record<string, number | string>> {
  if (!Array.isArray(boxes) || boxes.length > 10000) return false;
  return boxes.every(
    (b) =>
      b !== null &&
      typeof b === "object" &&
      ["center_x", "center_y", "center_z", "size_x", "size_y", "size_z"].every(
        (k) => typeof (b as any)[k] === "number" && Number.isFinite((b as any)[k]),
      ),
  );
}

/**
 * Stream a (potentially very large, e.g. ~450MB splat) file to the client
 * instead of buffering it wholesale into memory with readFileSync.
 * Returns 404 (not 500) when the file no longer exists on disk.
 */
function streamFile(res: ServerResponse, filePath: string): void {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    sendJson(res, 404, { success: false, error: "File not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": size,
  });
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    logToFile("server", "stream failed", { file: filePath, error: err.message });
    res.destroy();
  });
  stream.pipe(res);
}

/**
 * Compute an outward-facing unit normal and plane equation constant `d`
 * from three non-collinear points. plane_equation = [nx, ny, nz, d] with
 * d = -(n · p0).
 */
function computePlane(
  p0: V3,
  p1: V3,
  p2: V3,
): { normal: V3; d: number } {
  const ax = p1[0] - p0[0];
  const ay = p1[1] - p0[1];
  const az = p1[2] - p0[2];
  const bx = p2[0] - p0[0];
  const by = p2[1] - p0[1];
  const bz = p2[2] - p0[2];

  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) {
    return { normal: [0, 0, 1], d: -p0[2] };
  }
  nx /= len;
  ny /= len;
  nz /= len;
  return {
    normal: [nx, ny, nz],
    d: -(nx * p0[0] + ny * p0[1] + nz * p0[2]),
  };
}

// ---- SceneGraph mutation engine ----

function applyMutations(root: any, mutations: Mutations): UpdateObjectId[] {
  applyDeletePolys(root, mutations.deletePolyIds);
  applyDeleteAreas(root, mutations.deleteAreaIds);
  applyUpdateAreas(root, mutations.updateAreas);
  applyMovePolys(root, mutations.movePoly);
  applyRemoveEdges(root, mutations.removeEdges);
  applyAddEdges(root, mutations.addEdges);
  applyCreatePolys(root, mutations.createPoly);
  applyCreateObjects(root, mutations.createObjects);
  // Object id renames run first — the frontend rewrites all other object
  // mutations to reference the new id, so they must run after the rename.
  const appliedRenames = applyUpdateObjectIds(root, mutations.updateObjectIds);
  applyUpdateObjectLabels(root, mutations.updateObjectLabels);
  applyUpdateObjectFatherPolys(root, mutations.updateObjectFatherPolys);
  applyUpdateObjectPositions(root, mutations.updateObjectPositions);
  applyUpdateObjectColors(root, mutations.updateObjectColors);
  applyDeleteObjects(root, mutations.deleteObjectIds);
  applyObjectOrder(root, mutations.objectOrder);
  rebuildCounters(root);
  return appliedRenames;
}

function applyDeletePolys(root: any, ids: number[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);

  // Remember each deleted poly's area before filtering so we can drop the
  // object ids of orphaned objects from the matching area.object_ids below.
  const deletedPolyArea = new Map<number, number>();
  for (const p of root.polyhedrons || []) {
    if (idSet.has(Number(p.id))) {
      deletedPolyArea.set(Number(p.id), Number(p.area_id));
    }
  }

  root.polyhedrons = (root.polyhedrons || []).filter(
    (p: any) => !idSet.has(Number(p.id)),
  );

  for (const area of root.areas || []) {
    area.poly_ids = (area.poly_ids || []).filter(
      (pid: any) => !idSet.has(Number(pid)),
    );
  }

  for (const poly of root.polyhedrons || []) {
    poly.edges = (poly.edges || []).filter(
      (e: any) => !idSet.has(Number(e.dst_poly_id)),
    );
    poly.connected_node_ids = (poly.connected_node_ids || []).filter(
      (nid: any) => !idSet.has(Number(nid)),
    );
  }

  for (const obj of root.objects || []) {
    const fp = Number(obj?.edge?.father_poly_id);
    if (idSet.has(fp)) {
      if (!obj.edge) obj.edge = {};
      obj.edge.father_poly_id = -1;

      // The object no longer belongs to the deleted poly's area, so remove
      // it from that area.object_ids to keep the manifest consistent.
      const areaId = deletedPolyArea.get(fp) ?? -1;
      if (areaId >= 0) {
        const area = (root.areas || []).find((a: any) => Number(a.id) === areaId);
        if (area && Array.isArray(area.object_ids)) {
          area.object_ids = area.object_ids.filter(
            (oid: any) => Number(oid) !== Number(obj.id),
          );
        }
      }
    }
  }

  // Drop vertices that are no longer referenced by any remaining poly
  // (white or black vertex lists).
  root.vertices = (root.vertices || []).filter((v: any) =>
    (root.polyhedrons || []).some(
      (p: any) =>
        (p.white_vertex_ids || []).includes(v.id) ||
        (p.black_vertex_ids || []).includes(v.id),
    ),
  );
}

/**
 * Remove area metadata only: drop the area entries listed in `ids` and
 * strip those ids from every remaining area's neighbor_area_ids. The poly
 * set (and therefore area.poly_ids) is intentionally left untouched — the
 * user only asked to delete the Area grouping, not the Polys/Objects inside.
 */
function applyDeleteAreas(root: any, ids: number[]): void {
  if (!ids || ids.length === 0) return;
  const idSet = new Set(ids.map(Number));
  root.areas = (root.areas || []).filter(
    (a: any) => !idSet.has(Number(a.id)),
  );
  for (const area of root.areas) {
    area.neighbor_area_ids = (area.neighbor_area_ids || []).filter(
      (nid: any) => !idSet.has(Number(nid)),
    );
  }
  // Drop dangling area references so reloaded polys fall back to "no area"
  // instead of pointing at a deleted area id.
  for (const poly of root.polyhedrons || []) {
    if (idSet.has(Number(poly.area_id))) {
      poly.area_id = -1;
    }
  }
}

/**
 * Update area metadata in place: rename (room_label) and/or recolor (color,
 * kept in the same 0–1 float-per-channel format as the raw JSON).
 */
function applyUpdateAreas(root: any, updates: UpdateArea[]): void {
  if (!updates || updates.length === 0) return;
  const areaMap = new Map<number, any>();
  for (const a of root.areas || []) areaMap.set(Number(a.id), a);

  for (const u of updates) {
    const area = areaMap.get(Number(u.id));
    if (!area) continue;
    if (u.roomLabel !== undefined) area.room_label = u.roomLabel;
    if (u.color !== undefined) area.color = [...u.color];
  }
}

function applyMovePolys(root: any, moves: MovePoly[]): void {
  if (moves.length === 0) return;
  const polyMap = new Map<number, any>();
  for (const p of root.polyhedrons || []) polyMap.set(Number(p.id), p);

  for (const m of moves) {
    const poly = polyMap.get(m.id);
    if (!poly) continue;
    const oldCenter: V3 = poly.center || [0, 0, 0];
    const newCenter: V3 = m.center;
    const dx = newCenter[0] - oldCenter[0];
    const dy = newCenter[1] - oldCenter[1];
    const dz = newCenter[2] - oldCenter[2];

    poly.center = [...newCenter];
    if (poly.origin_center) {
      poly.origin_center = [
        poly.origin_center[0] + dx,
        poly.origin_center[1] + dy,
        poly.origin_center[2] + dz,
      ];
    }
    if (poly.box_min) {
      poly.box_min = [poly.box_min[0] + dx, poly.box_min[1] + dy, poly.box_min[2] + dz];
    }
    if (poly.box_max) {
      poly.box_max = [poly.box_max[0] + dx, poly.box_max[1] + dy, poly.box_max[2] + dz];
    }

    const allVertIds = new Set<number>([
      ...(poly.white_vertex_ids || []),
      ...(poly.black_vertex_ids || []),
    ]);
    const vertexMap = new Map<number, any>();
    for (const v of root.vertices || []) vertexMap.set(v.id, v);

    for (const vid of allVertIds) {
      const v = vertexMap.get(vid);
      if (!v) continue;
      v.position = [
        (v.position?.[0] ?? 0) + dx,
        (v.position?.[1] ?? 0) + dy,
        (v.position?.[2] ?? 0) + dz,
      ];
    }

    for (const fid of poly.facet_ids || []) {
      const facet = (root.facets || []).find((f: any) => f.id === fid);
      if (!facet) continue;
      if (facet.center) {
        facet.center = [facet.center[0] + dx, facet.center[1] + dy, facet.center[2] + dz];
      }
      // Recompute the plane equation / unit normal so they stay consistent
      // with the translated vertex geometry.
      const fvids = facet.vertex_ids || [];
      if (fvids.length >= 3) {
        const a = vertexMap.get(fvids[0]);
        const b = vertexMap.get(fvids[1]);
        const c = vertexMap.get(fvids[2]);
        if (a?.position && b?.position && c?.position) {
          const { normal, d } = computePlane(a.position, b.position, c.position);
          facet.out_unit_normal = normal;
          facet.plane_equation = [normal[0], normal[1], normal[2], d];
        }
      }
    }
  }
}

function applyRemoveEdges(root: any, edges: EdgeRef[]): void {
  if (edges.length === 0) return;
  const edgeSet = new Set(edges.map((e) => `${e.srcId}_${e.dstId}`));
  for (const poly of root.polyhedrons || []) {
    const pid = Number(poly.id);
    poly.edges = (poly.edges || []).filter(
      (e: any) =>
        !edgeSet.has(`${pid}_${e.dst_poly_id}`) &&
        !edgeSet.has(`${e.dst_poly_id}_${pid}`),
    );
    poly.connected_node_ids = (poly.connected_node_ids || []).filter(
      (nid: any) =>
        !edgeSet.has(`${pid}_${nid}`) && !edgeSet.has(`${nid}_${pid}`),
    );
  }
}

function applyAddEdges(root: any, edges: EdgeRef[]): void {
  if (edges.length === 0) return;
  const polyMap = new Map<number, any>();
  for (const p of root.polyhedrons || []) polyMap.set(Number(p.id), p);

  for (const e of edges) {
    const src = polyMap.get(e.srcId);
    const dst = polyMap.get(e.dstId);
    if (!src || !dst) continue;

    const sc: V3 = src.center || [0, 0, 0];
    const dc: V3 = dst.center || [0, 0, 0];
    const length = Math.sqrt(
      (dc[0] - sc[0]) ** 2 + (dc[1] - sc[1]) ** 2 + (dc[2] - sc[2]) ** 2,
    );

    addDirectedEdge(src, e.dstId, length);
    addDirectedEdge(dst, e.srcId, length);
  }
}

function addDirectedEdge(src: any, dstId: number, length: number): void {
  const exists = (src.edges || []).some(
    (edge: any) => Number(edge.dst_poly_id) === dstId,
  );
  if (exists) return;

  if (!src.edges) src.edges = [];
  src.edges.push({
      dst_poly_id: dstId,
      length,
      weight: 1.0,
      is_force_connected: false,
      path: [],
  });
}

function applyCreatePolys(root: any, creates: CreatePoly[]): void {
  if (creates.length === 0) return;

  let maxPolyId = 0;
  for (const p of root.polyhedrons || []) {
    maxPolyId = Math.max(maxPolyId, Number(p.id));
  }
  let maxVertexId = 0;
  for (const v of root.vertices || []) {
    maxVertexId = Math.max(maxVertexId, Number(v.id));
  }
  let maxFacetId = 0;
  for (const f of root.facets || []) {
    maxFacetId = Math.max(maxFacetId, Number(f.id));
  }

  const areaMap = new Map<number, any>();
  for (const a of root.areas || []) areaMap.set(Number(a.id), a);

  for (const cp of creates) {
    maxPolyId += 1;
    const polyId = maxPolyId;

    const s = cp.size * 0.5;
    const cx = cp.center[0], cy = cp.center[1], cz = cp.center[2];

    const vertDefs: V3[] = [
      [cx - s, cy - s, cz - s],
      [cx + s, cy - s, cz - s],
      [cx + s, cy + s, cz - s],
      [cx - s, cy + s, cz - s],
      [cx - s, cy - s, cz + s],
      [cx + s, cy - s, cz + s],
      [cx + s, cy + s, cz + s],
      [cx - s, cy + s, cz + s],
    ];

    const vids: number[] = [];
    for (let i = 0; i < 8; i++) {
      maxVertexId += 1;
      vids.push(maxVertexId);
      if (!root.vertices) root.vertices = [];
      root.vertices.push({
        id: maxVertexId,
        position: [...vertDefs[i]],
        connected_vertex_ids: [],
        type: 0,
        is_critical: false,
        is_visited: false,
      });
    }

    const [v0, v1, v2, v3, v4, v5, v6, v7] = vids;
    const triFaces: [number, number, number][] = [
      [v0, v2, v1], [v0, v3, v2],
      [v4, v5, v6], [v4, v6, v7],
      [v0, v1, v5], [v0, v5, v4],
      [v2, v3, v7], [v2, v7, v6],
      [v0, v4, v7], [v0, v7, v3],
      [v1, v2, v6], [v1, v6, v5],
    ];

    const facetIds: number[] = [];
    for (const tri of triFaces) {
      maxFacetId += 1;
      facetIds.push(maxFacetId);
      const pts = tri.map((vid) => vertDefs[vid - vids[0]]);
      const fc: V3 = [
        (pts[0][0] + pts[1][0] + pts[2][0]) / 3,
        (pts[0][1] + pts[1][1] + pts[2][1]) / 3,
        (pts[0][2] + pts[1][2] + pts[2][2]) / 3,
      ];
      if (!root.facets) root.facets = [];
      const { normal, d } = computePlane(pts[0], pts[1], pts[2]);
      root.facets.push({
        id: maxFacetId,
        vertex_ids: [...tri],
        center: fc,
        out_unit_normal: normal,
        plane_equation: [normal[0], normal[1], normal[2], d],
        master_poly_id: polyId,
        neighbor_facet_ids: [],
        is_linked: false,
        is_visited: false,
        frontier_processed: false,
        index: 0,
      });
    }

    const poly = {
      id: polyId,
      area_id: cp.areaId,
      center: [...cp.center],
      origin_center: [...cp.center],
      white_vertex_ids: [...vids],
      black_vertex_ids: [],
      facet_ids: facetIds,
      edges: [],
      connected_node_ids: [],
      box_min: [cx - s, cy - s, cz - s],
      box_max: [cx + s, cy + s, cz + s],
      radius: s * Math.sqrt(3),
      object_ids: [],
      can_reach: false,
      is_gate: false,
      is_rollbacked: false,
      frontier_ids: [],
      gray_vertex_ids: [],
      candidate_rollback: [],
      parent_frontier_id: -1,
      temp_distance_to_nxt_poly: 0,
    };

    if (!root.polyhedrons) root.polyhedrons = [];
    root.polyhedrons.push(poly);

    const area = areaMap.get(cp.areaId);
    if (area) {
      if (!area.poly_ids) area.poly_ids = [];
      area.poly_ids.push(polyId);

      const polyMin: V3 = [cx - s, cy - s, cz - s];
      const polyMax: V3 = [cx + s, cy + s, cz + s];
      if (!area.box_min || !area.box_max) {
        area.box_min = [...polyMin];
        area.box_max = [...polyMax];
      } else {
        area.box_min = [
          Math.min(Number(area.box_min[0]), polyMin[0]),
          Math.min(Number(area.box_min[1]), polyMin[1]),
          Math.min(Number(area.box_min[2]), polyMin[2]),
        ];
        area.box_max = [
          Math.max(Number(area.box_max[0]), polyMax[0]),
          Math.max(Number(area.box_max[1]), polyMax[1]),
          Math.max(Number(area.box_max[2]), polyMax[2]),
        ];
      }
      area.center = [
        (Number(area.box_min[0]) + Number(area.box_max[0])) / 2,
        (Number(area.box_min[1]) + Number(area.box_max[1])) / 2,
        (Number(area.box_min[2]) + Number(area.box_max[2])) / 2,
      ];
    }
  }
}

/**
 * Append marker-only objects (no point cloud, not linked to any poly). The
 * frontend sends label / position / color (0–255) and we allocate fresh ids
 * above the current max so existing objects and their files are untouched.
 */
function applyCreateObjects(root: any, creates: CreateObject[]): void {
  if (!creates || creates.length === 0) return;

  let maxObjectId = 0;
  for (const o of root.objects || []) {
    maxObjectId = Math.max(maxObjectId, Number(o.id));
  }

  if (!root.objects) root.objects = [];

  for (const co of creates) {
    maxObjectId += 1;
    root.objects.push({
      id: maxObjectId,
      label: co.label,
      pos: [...co.position] as V3,
      color: [...co.color] as [number, number, number],
      edge: {
        father_poly_id: -1,
        father_object_id: -1,
        child_object_ids: [],
      },
      files: { cloud: "" },
    });
  }
}

function applyUpdateObjectLabels(root: any, updates: UpdateObjectLabel[]): void {
  if (updates.length === 0) return;
  const objMap = new Map<number, any>();
  for (const o of root.objects || []) objMap.set(Number(o.id), o);

  for (const u of updates) {
    const obj = objMap.get(u.id);
    if (!obj) continue;
    obj.label = u.label;
  }
}

function applyDeleteObjects(root: any, ids: number[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);

  // Remove objects
  root.objects = (root.objects || []).filter(
    (o: any) => !idSet.has(Number(o.id)),
  );

  // Clean poly.object_ids references
  for (const poly of root.polyhedrons || []) {
    poly.object_ids = (poly.object_ids || []).filter(
      (oid: any) => !idSet.has(Number(oid)),
    );
  }

  // Clean area.object_ids references
  for (const area of root.areas || []) {
    area.object_ids = (area.object_ids || []).filter(
      (oid: any) => !idSet.has(Number(oid)),
    );
  }

  // Clean cross-object edge references
  for (const obj of root.objects || []) {
    const edge = obj.edge || {};
    const fid = Number(edge.father_object_id ?? -1);
    if (idSet.has(fid)) {
      edge.father_object_id = -1;
      if (!obj.edge) obj.edge = edge;
    }
    edge.child_object_ids = (edge.child_object_ids || []).filter(
      (cid: any) => !idSet.has(Number(cid)),
    );
    if (obj.edge) obj.edge = edge;
  }
}

function applyUpdateObjectFatherPolys(root: any, updates: UpdateObjectFatherPoly[]): void {
  if (updates.length === 0) return;
  const objMap = new Map<number, any>();
  for (const o of root.objects || []) objMap.set(Number(o.id), o);

  const polyMap = new Map<number, any>();
  for (const p of root.polyhedrons || []) polyMap.set(Number(p.id), p);

  const areaMap = new Map<number, any>();
  for (const a of root.areas || []) areaMap.set(Number(a.id), a);

  const removeId = (list: any[] | undefined, id: number): any[] | undefined => {
    if (!Array.isArray(list)) return list;
    return list.filter((x: any) => Number(x) !== id);
  };
  const addId = (list: any[] | undefined, id: number): any[] => {
    if (!Array.isArray(list)) return [id];
    return list.some((x: any) => Number(x) === id) ? list : [...list, id];
  };

  for (const u of updates) {
    const obj = objMap.get(u.objectId);
    if (!obj) continue;
    const objectId = Number(u.objectId);
    const newFather = Number(u.fatherPolyId);
    // Skip re-parents onto a poly that no longer exists (deleted in this same
    // export): applyDeletePolys already reset the object to father=-1, and
    // applying the stale update would leave a dangling father_poly_id.
    // newFather === -1 is an explicit disconnect and stays allowed.
    if (newFather !== -1 && !polyMap.get(newFather)) continue;
    const oldFather = Number(obj?.edge?.father_poly_id ?? -1);
    if (oldFather === newFather) continue;

    if (!obj.edge) obj.edge = {};
    obj.edge.father_poly_id = newFather;

    // Keep poly.object_ids in sync with the new father poly.
    const oldPoly = polyMap.get(oldFather);
    const newPoly = polyMap.get(newFather);
    if (oldPoly) oldPoly.object_ids = removeId(oldPoly.object_ids, objectId);
    if (newPoly) newPoly.object_ids = addId(newPoly.object_ids, objectId);

    // If the object crosses an area boundary, move it between the two
    // area.object_ids lists so the exported JSON stays internally consistent.
    const oldAreaId = oldPoly ? Number(oldPoly.area_id) : -1;
    const newAreaId = newPoly ? Number(newPoly.area_id) : -1;
    if (oldAreaId !== newAreaId) {
      const oldArea = areaMap.get(oldAreaId);
      if (oldArea) oldArea.object_ids = removeId(oldArea.object_ids, objectId);
      const newArea = areaMap.get(newAreaId);
      if (newArea) newArea.object_ids = addId(newArea.object_ids, objectId);
    }
  }
}

function applyUpdateObjectPositions(root: any, updates: UpdateObjectPosition[]): void {
  if (updates.length === 0) return;
  const objMap = new Map<number, any>();
  for (const o of root.objects || []) objMap.set(Number(o.id), o);

  for (const u of updates) {
    const obj = objMap.get(u.id);
    if (!obj) continue;
    obj.pos = [...u.position] as V3;
  }
}

/**
 * Update object color in place. Object colors are stored as 0–255 integer
 * RGB per channel (unlike areas, which use 0–1 floats).
 */
function applyUpdateObjectColors(root: any, updates: UpdateObjectColor[]): void {
  if (updates.length === 0) return;
  const objMap = new Map<number, any>();
  for (const o of root.objects || []) objMap.set(Number(o.id), o);

  for (const u of updates) {
    const obj = objMap.get(u.id);
    if (!obj) continue;
    obj.color = [...u.color];
  }
}

/**
 * Reorder root.objects to match the frontend drag order. `order` lists
 * effective/current object ids; objects not listed (e.g. missing after a
 * rename edge case) keep their relative position and are appended last.
 */
function applyObjectOrder(root: any, order: number[]): void {
  if (!order?.length) return;
  const objects = root.objects || [];
  const byId = new Map<number, any>();
  for (const o of objects) byId.set(Number(o.id), o);

  const ordered: any[] = [];
  for (const rawId of order) {
    const id = Number(rawId);
    const obj = byId.get(id);
    if (obj) {
      ordered.push(obj);
      byId.delete(id);
    }
  }
  for (const obj of objects) {
    if (byId.has(Number(obj.id))) ordered.push(obj);
  }
  root.objects = ordered;
}

/**
 * Rename objects (oldId → newId), keeping every id reference in sync:
 * objects[].id, areas[].object_ids, polyhedrons[].object_ids,
 * cross-object edges (father_object_id / child_object_ids), and the
 * files.{cloud,obb_axis,obb_corners} path prefixes (object_<id>_* →
 * object_<newId>_*). The actual PCD files are renamed on disk by
 * renameObjectFiles() after copyObjectsDir() — saved/ stays untouched.
 * Skips renames with a duplicate target id, a missing source object,
 * or a new id outside the uint16 target_obj_id contract (0–65535).
 * Returns the list of renames actually applied (in application order).
 */
function applyUpdateObjectIds(root: any, renames: UpdateObjectId[]): UpdateObjectId[] {
  const applied: UpdateObjectId[] = [];
  if (renames.length === 0) return applied;

  for (const r of renames) {
    const oldId = Number(r.oldId);
    const newId = Number(r.newId);
    if (
      !Number.isInteger(oldId) ||
      !Number.isInteger(newId) ||
      oldId === newId ||
      newId < 0 ||
      newId > 65535
    ) {
      continue;
    }

    const objects = root.objects || [];
    const target = objects.find((o: any) => Number(o.id) === oldId);
    if (!target) continue;

    // Skip if another object already uses the new id
    const conflict = objects.some(
      (o: any) => o !== target && Number(o.id) === newId,
    );
    if (conflict) continue;

    target.id = newId;

    // Rewrite files.* path basenames: object_<oldId>_<kind>.pcd → object_<newId>_<kind>.pcd
    const files = target.files || {};
    for (const key of ["cloud", "obb_axis", "obb_corners"]) {
      const p = files[key];
      if (typeof p !== "string" || !p.includes("/")) continue;
      const slash = p.lastIndexOf("/");
      files[key] =
        p.slice(0, slash + 1) +
        p
          .slice(slash + 1)
          .replace(
            new RegExp(`^object_${oldId}_`),
            `object_${newId}_`,
          );
    }

    for (const area of root.areas || []) {
      area.object_ids = (area.object_ids || []).map((oid: any) =>
        Number(oid) === oldId ? newId : Number(oid),
      );
    }
    for (const poly of root.polyhedrons || []) {
      poly.object_ids = (poly.object_ids || []).map((oid: any) =>
        Number(oid) === oldId ? newId : Number(oid),
      );
    }
    for (const obj of objects) {
      const edge = obj.edge || {};
      if (Number(edge.father_object_id) === oldId) {
        edge.father_object_id = newId;
        if (!obj.edge) obj.edge = edge;
      }
      edge.child_object_ids = (edge.child_object_ids || []).map((cid: any) =>
        Number(cid) === oldId ? newId : Number(cid),
      );
      if (obj.edge) obj.edge = edge;
    }

    applied.push({ oldId, newId });
  }
  return applied;
}

function rebuildCounters(root: any): void {
  const counters = root.counters || {};
  counters.area_count = (root.areas || []).length;
  counters.object_count = (root.objects || []).length;
  counters.poly_count = (root.polyhedrons || []).length;
  counters.vertex_count = (root.vertices || []).length;
  counters.facet_count = (root.facets || []).length;
  root.counters = counters;
  root.saved_at = new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---- file copy (mirror objects/ from saved to exported) ----

/**
 * Copy only the objects/ PCD files referenced by the final scene graph
 * (rather than mirroring every saved/ file and pruning afterwards).
 * `renames` maps new object ids back to their saved-side ids so we copy the
 * original filenames that renameObjectFiles() then renames. Never overwrite
 * an existing file in exported/ — earlier exports may already have renamed
 * files there (object_<oldId>_*.pcd → object_<newId>_*.pcd).
 */
async function copyObjectsDir(
  savedDir: string,
  exportedDir: string,
  root: any,
  renames: UpdateObjectId[],
): Promise<void> {
  const src = join(savedDir, "objects");
  const dst = join(exportedDir, "objects");

  const oldIdByNewId = new Map<number, number>();
  for (const r of renames) {
    oldIdByNewId.set(Number(r.newId), Number(r.oldId));
  }

  const wanted = new Set<string>();
  for (const o of root.objects || []) {
    for (const key of ["cloud", "obb_axis", "obb_corners"]) {
      const p = o?.files?.[key];
      if (typeof p !== "string" || !p.includes("/")) continue;
      const base = p.slice(p.lastIndexOf("/") + 1);
      const m = base.match(/^object_(\d+)_(cloud|obb_axis|obb_corners)\.pcd$/);
      if (!m) {
        wanted.add(base);
        continue;
      }
      const newId = Number(m[1]);
      const oldId = oldIdByNewId.get(newId) ?? newId;
      wanted.add(`object_${oldId}_${m[2]}.pcd`);
    }
  }

  try {
    await mkdir(dst, { recursive: true });
  } catch {
    // objects dir already exists — ok
  }
  for (const f of wanted) {
    const dstFile = join(dst, f);
    try {
      statSync(dstFile);
    } catch {
      try {
        await copyFile(join(src, f), dstFile);
      } catch {
        // source file may not exist (e.g. chained rename) — skip
      }
    }
  }
}

let tempRenameCounter = 0;

/**
 * Rename object PCD files in exported/objects to match applied id renames.
 * Runs AFTER copyObjectsDir so the original files are present. If a source
 * file is missing in exported/ (e.g. chained renames from a previous
 * export already moved it), it is re-pulled from saved/objects/.
 * saved/ is never modified. Objects without a file for a given kind
 * (e.g. empty cloud) are skipped silently.
 */
function renameObjectFiles(
  savedDir: string,
  exportedDir: string,
  renames: UpdateObjectId[],
): void {
  if (renames.length === 0) return;
  const savedObjects = join(savedDir, "objects");
  const exportedObjects = join(exportedDir, "objects");
  mkdirSync(exportedObjects, { recursive: true });

  // Rename via unique temp names in two phases. A naive `old → new` in
  // application order can overwrite a file when one rename's target id equals
  // another rename's source id (e.g. 1→5 and 5→6). Moving every source file
  // to a temp name first frees all source paths before writing the finals.
  for (const kind of ["cloud", "obb_axis", "obb_corners"]) {
    const moves: { oldPath: string; newPath: string }[] = [];
    for (const r of renames) {
      const oldName = `object_${r.oldId}_${kind}.pcd`;
      const newName = `object_${r.newId}_${kind}.pcd`;
      const oldPath = join(exportedObjects, oldName);
      let haveOld = true;
      try {
        statSync(oldPath);
      } catch {
        // Not in exported/ yet (or renamed away in an earlier export) —
        // pull the original from saved/.
        try {
          copyFileSync(join(savedObjects, oldName), oldPath);
        } catch {
          haveOld = false; // object has no file of this kind
        }
      }
      if (haveOld) {
        moves.push({ oldPath, newPath: join(exportedObjects, newName) });
      }
    }

    const temps: { tempPath: string; newPath: string }[] = [];
    for (let i = 0; i < moves.length; i++) {
      const tempPath = join(
        exportedObjects,
        `__tmp_rename_${tempRenameCounter++}_${kind}.pcd`,
      );
      renameSync(moves[i].oldPath, tempPath);
      temps.push({ tempPath, newPath: moves[i].newPath });
    }
    for (const t of temps) {
      renameSync(t.tempPath, t.newPath);
    }
  }
}

/**
 * Delete files in exported/objects/ that the final scene_graph.json does not
 * reference. copyObjectsDir re-pulls every saved/ file each export, which
 * resurrects stale files under names that earlier exports renamed away
 * (e.g. object_11_* after 11→12); saved/ may also contain orphans that no
 * JSON ever referenced. Referenced files are kept; everything else goes.
 */
function pruneUnreferencedObjects(exportedDir: string): number {
  const exportedObjects = join(exportedDir, "objects");
  const root = readJson(join(exportedDir, "scene_graph.json"));
  const referenced = new Set<string>();
  for (const o of root.objects || []) {
    for (const key of ["cloud", "obb_axis", "obb_corners"]) {
      const p = o?.files?.[key];
      if (typeof p === "string" && p.includes("/")) {
        referenced.add(p.slice(p.lastIndexOf("/") + 1));
      }
    }
  }
  let removed = 0;
  try {
    for (const f of readdirSync(exportedObjects)) {
      if (!referenced.has(f)) {
        rmSync(join(exportedObjects, f));
        removed++;
      }
    }
  } catch {
    // no objects dir — ok
  }
  return removed;
}

function findLatestSnapshot(baseDir: string): string {
  const entries = readdirSync(baseDir, { withFileTypes: true }).filter((e) => {
    if (!e.isDirectory()) return false;
    try {
      return statSync(join(baseDir, e.name, "scene_graph.json")).isFile();
    } catch {
      return false;
    }
  });
  entries.sort((a, b) => {
    const ma = statSync(join(baseDir, a.name)).mtimeMs;
    const mb = statSync(join(baseDir, b.name)).mtimeMs;
    if (mb !== ma) return mb - ma;
    return b.name.localeCompare(a.name);
  });
  return entries[0]?.name ?? "";
}

// ---- File logger (logs/YYYY-MM-DD_HH-MM-SS.log) ----

let logDir: string | null = null;
let logFileName: string | null = null;

function localTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function logToFile(scope: string, event: string, detail?: unknown): void {
  if (!logDir || !logFileName) return;
  try {
    const now = new Date();
    const line =
      `${now.toISOString()} [${scope}] ${event}` +
      (detail !== undefined ? ` ${JSON.stringify(detail)}` : "") +
      "\n";
    appendFileSync(join(logDir, logFileName), line);
  } catch {
    /* logging must never break the request */
  }
}

// ---- Vite plugin ----

export function apiPlugin(): Plugin {
  const PROJECT_ROOT = join(import.meta.dirname, "..");
  const BBOX_DIR = join(PROJECT_ROOT, "bboxes");
  // Fixed cloud/splat data root: only the bundled scenes/ directory is ever
  // served (the ?name= / ?source=scene lookups and the file listing all read
  // from it). Runtime path switching was removed on purpose — every asset the
  // tool visualizes lives in its designated folder under the project.
  const SCENE_ROOT = join(PROJECT_ROOT, "scenes");

  // Fixed trajectory browsing root: worldmodel flight_/step_ directories are
  // only ever read from inside trajectories/.
  const TRAJ_ROOT = join(PROJECT_ROOT, "trajectories");

  // Fixed SceneGraph snapshot data root: scene_graph_saved/ (read-only
  // source) + scene_graph_exported/ (exports) live under scene_graph/.
  const SG_ROOT = join(PROJECT_ROOT, "scene_graph");

  // Initialize the log directory on plugin setup. Each `bun run dev` restart
  // gets its own timestamped file: logs/YYYY-MM-DD_HH-MM-SS.log
  logDir = join(PROJECT_ROOT, "logs");
  logFileName = `${localTimestamp(new Date())}.log`;
  mkdirSync(logDir, { recursive: true });
  logToFile("server", "dev server starting", { sgRoot: SG_ROOT });

  return {
    name: "3d-bbox-tool-api",
    configureServer(server: ViteDevServer) {
      // ---- BBox mode: list + serve scene assets, persist boxes ----

      // List cloud/splat files in the bundled scenes/ directory. Consumers
      // filter for themselves (the BBox dropdown keeps .pcd/.ply, the
      // SceneGraph splat picker accepts every cloud format). Registered
      // under both the BBox and the SceneGraph legacy path.
      const listCloudFiles = async (
        _req: IncomingMessage,
        res: ServerResponse,
      ) => {
        try {
          const files = readdirSync(SCENE_ROOT)
            .filter((f) => isCloudFileName(f))
            .map((f) => ({ name: f }));
          sendJson(res, 200, { files });
        } catch (err: any) {
          sendJson(res, 500, { success: false, error: err.message });
        }
      };
      server.middlewares.use("/api/pointcloud-files", listCloudFiles);
      server.middlewares.use("/api/scene-pcds", listCloudFiles);

      // Unified cloud/splat file endpoint, shared by both modes.
      //
      // SceneGraph-mode requests always carry `snapshot` or `source`:
      //   ?snapshot=X&path=objects/object_N_cloud.pcd  (exported/ first)
      //   ?source=scene&name=elec.ply
      // A plain ?name=… belongs to the BBox mode and reads the bundled
      // scenes/ directory.
      server.middlewares.use(
        "/api/pcd",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(
              req.url || "",
              `http://${req.headers.host || "localhost"}`,
            );
            const snapshot = url.searchParams.get("snapshot");
            const source = url.searchParams.get("source");
            let filePath: string;

            if (snapshot !== null || source !== null) {
              // ---- SceneGraph mode ----
              if (source === "scene") {
                const name = url.searchParams.get("name");
                if (
                  !name ||
                  name.includes("..") ||
                  name.includes("/") ||
                  name.includes("\\") ||
                  name.includes("\0") ||
                  !isCloudFileName(name)
                ) {
                  sendJson(res, 400, { success: false, error: "Invalid name" });
                  return;
                }
                filePath = join(SCENE_ROOT, name);
              } else {
                const relPath = url.searchParams.get("path");
                if (
                  !snapshot ||
                  !isValidSnapshotName(snapshot) ||
                  !relPath ||
                  relPath.includes("..") ||
                  relPath.startsWith("/") ||
                  !relPath.startsWith("objects/") ||
                  !isCloudFileName(relPath.slice(relPath.lastIndexOf("/") + 1))
                ) {
                  sendJson(res, 400, {
                    success: false,
                    error: "Missing/invalid snapshot or path",
                  });
                  return;
                }
                // Prefer exported/ (may contain renamed object files),
                // fall back to saved/ — same order as /api/scene-graph.
                const exportedFile = join(SG_ROOT, "scene_graph_exported", snapshot, relPath);
                try {
                  statSync(exportedFile);
                  filePath = exportedFile;
                } catch {
                  filePath = join(SG_ROOT, "scene_graph_saved", snapshot, relPath);
                }
              }
            } else {
              // ---- BBox mode: plain ?name= ----
              const name = url.searchParams.get("name");
              if (!isValidFileName(name) || !isCloudFileName(name)) {
                sendJson(res, 400, { success: false, error: "Invalid name" });
                return;
              }
              filePath = join(SCENE_ROOT, name);
            }

            streamFile(res, filePath);
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      // BBox mode: load / persist labelled boxes for the active asset.
      server.middlewares.use(
        "/api/bbox",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
          }

          // GET → load the saved bbox for a specific cloud file.
          if (req.method === "GET") {
            try {
              const url = new URL(
                req.url || "",
                `http://${req.headers.host || "localhost"}`,
              );
              const name = url.searchParams.get("name");
              if (!isValidFileName(name) || !isKnownAssetName(name)) {
                sendJson(res, 400, { success: false, error: "Invalid name" });
                return;
              }
              const filePath = join(BBOX_DIR, `${name}.json`);
              const data = JSON.parse(readFileSync(filePath, "utf-8"));
              sendJson(res, 200, data);
            } catch {
              sendJson(res, 404, { success: false, error: "Not found" });
            }
            return;
          }

          if (req.method !== "POST") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }

          // POST → persist the labelled boxes as a per-cloud copy (for
          // auto-reload) plus the legacy six-field bbox_result.json (from the
          // first box) so downstream stays compatible.
          try {
            const body = await readBody(req);
            const payload = JSON.parse(body);
            const name = payload.name;
            if (!isValidFileName(name) || !isKnownAssetName(name)) {
              sendJson(res, 400, { success: false, error: "Invalid name" });
              return;
            }

            const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];
            if (!isValidBoxes(boxes)) {
              sendJson(res, 400, { success: false, error: "Invalid boxes payload" });
              return;
            }

            const perCloudPath = join(BBOX_DIR, `${name}.json`);
            writeJson(perCloudPath, { name, boxes });

            const first = boxes[0];
            const legacy = first
              ? {
                  center_x: first.center_x,
                  center_y: first.center_y,
                  center_z: first.center_z,
                  size_x: first.size_x,
                  size_y: first.size_y,
                  size_z: first.size_z,
                }
              : {
                  center_x: 0,
                  center_y: 0,
                  center_z: 0,
                  size_x: 0,
                  size_y: 0,
                  size_z: 0,
                };
            writeJson(join(PROJECT_ROOT, "bbox_result.json"), legacy);

            sendJson(res, 200, { success: true, path: perCloudPath, count: boxes.length });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      // ---- SceneGraph mode ----

      // Client-side event sink: the web editor POSTs UI events here so they
      // land in the same dated log file as backend events.
      server.middlewares.use(
        "/api/log",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const body = await readBody(req);
            const entry = JSON.parse(body);
            logToFile(
              "client",
              String(entry?.event ?? "unknown"),
              entry?.detail,
            );
            sendJson(res, 200, { success: true });
          } catch (err: any) {
            logToFile("client", "log post failed", { error: err.message });
            sendJson(res, 400, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/export",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
          }

          if (req.method !== "POST") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }

          try {
            const body = await readBody(req);
            const payload: ExportRequest = JSON.parse(body);
            if (!isValidSnapshotName(payload.snapshot)) {
              sendJson(res, 400, { success: false, error: "Invalid snapshot name" });
              return;
            }
            const t0 = Date.now();
            logToFile("export", "request", {
              snapshot: payload.snapshot,
              base: payload.base,
              renameCount: payload.mutations?.updateObjectIds?.length ?? 0,
            });
            const savedDir = join(SG_ROOT, "scene_graph_saved", payload.snapshot);
            const exportedDir = join(SG_ROOT, "scene_graph_exported", payload.snapshot);

            // Read from exported/ if base is "exported" (file exists), else fall back to saved/
            let sourcePath: string;
            if (payload.base === "exported") {
              const exportedPath = join(exportedDir, "scene_graph.json");
              try { statSync(exportedPath); sourcePath = exportedPath; }
              catch { sourcePath = join(savedDir, "scene_graph.json"); }
            } else {
              sourcePath = join(savedDir, "scene_graph.json");
            }
            const root = readJson(sourcePath);

            const appliedRenames = applyMutations(root, payload.mutations);

            writeJson(join(exportedDir, "scene_graph.json"), root);

            // manifest
            const manifest = {
              format_version: 1,
              save_name: payload.snapshot,
              saved_at: root.saved_at,
              scene_graph_file: "scene_graph.json",
              object_dir: "objects",
              summary: {
                poly_count: (root.polyhedrons || []).length,
                area_count: (root.areas || []).length,
                object_count: (root.objects || []).length,
                saved_cloud_num: (root.objects || []).filter(
                  (o: any) =>
                    o?.files?.cloud ||
                    o?.files?.obb_axis ||
                    o?.files?.obb_corners,
                ).length,
              },
            };
            writeJson(join(exportedDir, "manifest.json"), manifest);

            await copyObjectsDir(savedDir, exportedDir, root, appliedRenames);
            renameObjectFiles(savedDir, exportedDir, appliedRenames);
            const pruned = pruneUnreferencedObjects(exportedDir);

            logToFile("export", "ok", {
              snapshot: payload.snapshot,
              renames: appliedRenames,
              prunedFiles: pruned,
              elapsedMs: Date.now() - t0,
            });
            sendJson(res, 200, { success: true });
          } catch (err: any) {
            logToFile("export", "error", { error: err.message });
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/snapshot",
        async (_req: IncomingMessage, res: ServerResponse) => {
          try {
            const name = findLatestSnapshot(join(SG_ROOT, "scene_graph_saved"));
            sendJson(res, 200, { snapshot: name });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      // List all available snapshots from scene_graph_saved/
      server.middlewares.use(
        "/api/snapshots",
        async (_req: IncomingMessage, res: ServerResponse) => {
          try {
            const savedDir = join(SG_ROOT, "scene_graph_saved");
            const entries = readdirSync(savedDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .filter((e) => {
                try { return statSync(join(savedDir, e.name, "scene_graph.json")).isFile(); }
                catch { return false; }
              });

            const snapshots = entries.map((e) => {
              const mpath = join(savedDir, e.name, "manifest.json");
              let meta: any = {};
              try { meta = readJson(mpath); } catch {}
              let mtimeMs = 0;
              try { mtimeMs = statSync(join(savedDir, e.name)).mtimeMs; } catch {}
              return {
                name: e.name,
                saved_at: meta.saved_at || "",
                summary: meta.summary || {},
                mtimeMs,
              };
            });
            // Prefer newest directory mtime, then newest directory name. This
            // avoids the stale manifest.saved_at problem (multiple snapshots
            // copied from the same source share an identical saved_at, which
            // made Array#sort unstable and picked the wrong "latest").
            snapshots.sort((a, b) => {
              if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
              return b.name.localeCompare(a.name);
            });
            sendJson(res, 200, { snapshots });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      // Serve scene_graph.json
      //   ?snapshot=X           → exported/ first, fallback saved/
      //   ?snapshot=X&source=saved    → force saved/
      //   ?snapshot=X&source=exported → force exported/ (404 if missing)
      // Every response carries X-Scene-Source ("saved"|"exported") telling the
      // client which copy it actually served, so a follow-up export can use the
      // same base. Without it, a session that auto-loaded an exported/ copy but
      // exports with base "saved" would rebuild exported/ from saved/ and
      // silently wipe the previous session's changes.
      server.middlewares.use(
        "/api/scene-graph",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
            const snapshot = url.searchParams.get("snapshot");
            if (!snapshot) {
              sendJson(res, 400, { success: false, error: "Missing snapshot query param" });
              return;
            }
            if (!isValidSnapshotName(snapshot)) {
              sendJson(res, 400, { success: false, error: "Invalid snapshot name" });
              return;
            }

            const savedPath = join(SG_ROOT, "scene_graph_saved", snapshot, "scene_graph.json");
            const exportedPath = join(SG_ROOT, "scene_graph_exported", snapshot, "scene_graph.json");
            const source = url.searchParams.get("source") || "auto";

            let jsonPath: string;
            if (source === "saved") {
              jsonPath = savedPath;
            } else if (source === "exported") {
              try {
                statSync(exportedPath);
                jsonPath = exportedPath;
              } catch {
                sendJson(res, 404, { success: false, error: "No export found" });
                return;
              }
            } else {
              try { statSync(exportedPath); jsonPath = exportedPath; }
              catch { jsonPath = savedPath; }
            }

            const data = readFileSync(jsonPath, "utf-8");
            res.writeHead(200, {
              "Content-Type": "application/json",
              "X-Scene-Source": jsonPath === exportedPath ? "exported" : "saved",
            });
            res.end(data);
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      // ---- Trajectory mode: read-only browsing of worldmodel flight/step dirs ----
      //
      // GET /api/traj-browse?path=<abs server path>
      //   Smart listing: a step_* dir → itself; a flight_* dir → its steps;
      //   any other dir → the flight_*/step_* entries directly inside.
      // GET /api/traj-file?path=<step dir>&name=<whitelisted json>
      // GET /api/traj-asset?path=<step dir>&name=(anchor.jpg|video.mp4)
      //   Binary stream with Range support (video scrubbing).

      server.middlewares.use(
        "/api/traj-browse",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(
              req.url || "",
              `http://${req.headers.host || "localhost"}`,
            );
            // No `path` param → the fixed root (the UI starts there).
            const raw = url.searchParams.get("path") ?? TRAJ_ROOT;
            if (!trajPathWithin(TRAJ_ROOT, raw)) {
              sendJson(res, 400, {
                success: false,
                error: "Path must stay inside the project directory",
              });
              return;
            }
            let st;
            try {
              st = statSync(raw);
            } catch {
              sendJson(res, 404, { success: false, error: "Path not found" });
              return;
            }
            if (!st.isDirectory()) {
              sendJson(res, 400, { success: false, error: "Path is not a directory" });
              return;
            }

            const base = basename(raw);
            if (base.startsWith("step_")) {
              sendJson(res, 200, { kind: "step", path: raw, root: TRAJ_ROOT, step: trajStepInfo(raw) });
              return;
            }

            // Only ever list flight_*/step_* entries — no generic listing.
            const entries = readdirSync(raw, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
              .filter((n) => n.startsWith("flight_") || n.startsWith("step_"))
              .sort();

            if (base.startsWith("flight_")) {
              sendJson(res, 200, {
                kind: "flight",
                path: raw,
                root: TRAJ_ROOT,
                steps: entries
                  .filter((n) => n.startsWith("step_"))
                  .map((n) => trajStepInfo(join(raw, n))),
              });
              return;
            }
            sendJson(res, 200, {
              kind: "dir",
              path: raw,
              root: TRAJ_ROOT,
              flights: entries
                .filter((n) => n.startsWith("flight_"))
                .map((n) => ({ name: n, path: join(raw, n) })),
              steps: entries
                .filter((n) => n.startsWith("step_"))
                .map((n) => trajStepInfo(join(raw, n))),
            });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/traj-file",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(
              req.url || "",
              `http://${req.headers.host || "localhost"}`,
            );
            const dir = url.searchParams.get("path");
            const name = url.searchParams.get("name");
            if (!trajPathWithin(TRAJ_ROOT, dir) || !name || !TRAJ_JSON_FILES.has(name)) {
              sendJson(res, 400, { success: false, error: "Invalid path or file name" });
              return;
            }
            const filePath = join(dir, name);
            let data: string;
            try {
              data = readFileSync(filePath, "utf-8");
            } catch {
              sendJson(res, 404, { success: false, error: "File not found" });
              return;
            }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(data);
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/traj-asset",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(
              req.url || "",
              `http://${req.headers.host || "localhost"}`,
            );
            const dir = url.searchParams.get("path");
            const name = url.searchParams.get("name");
            const contentType = name ? TRAJ_ASSET_TYPES[name] : undefined;
            if (!trajPathWithin(TRAJ_ROOT, dir) || !contentType) {
              sendJson(res, 400, { success: false, error: "Invalid path or asset name" });
              return;
            }
            streamTrajAsset(res, join(dir, name), contentType, req.headers.range);
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );
    },
  };
}
