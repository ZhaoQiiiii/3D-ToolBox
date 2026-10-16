import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import type { CSSProperties, RefObject } from "react";
import { useThree } from "@react-three/fiber";
import { Html, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { AreaBox } from "./components/AreaBoxes";
import { AreaEdges } from "./components/AreaEdges";
import { AreaCenters } from "./components/AreaCenters";
import { PolyhedraAll } from "./components/PolyhedraAll";
import { PolyMesh } from "./components/PolyMesh";
import { TopologicalNodes } from "./components/TopologicalNodes";
import { TopologicalEdges } from "./components/TopologicalEdges";
import { WorldAxes } from "../../shared/components/WorldAxes";
import { SceneGrid } from "../../shared/components/SceneGrid";
import { EditToolbar } from "./components/EditToolbar";
import { ExportDiffPanel } from "./components/ExportDiffPanel";
import { NodePropertyPanel } from "./components/NodePropertyPanel";
import { ObjectsLayer } from "./components/ObjectsLayer";
import { ObjectPropertyPanel } from "./components/ObjectPropertyPanel";
import { ObjectsListPanel } from "./components/ObjectsListPanel";
import { AddNodePanel } from "./components/AddNodePanel";
import { AddObjectPanel } from "./components/AddObjectPanel";
import { PointCloudLayer, type PcdColorScheme } from "../../shared/components/PointCloudLayer";
import { GaussianSplatLayer } from "../../shared/components/GaussianSplatLayer";
import {
  MODE_PANEL_STYLE,
  MODE_PANEL_TITLE,
  PanelSlider,
  SCENE_COLUMN_STYLE,
  TOOLS_COLUMN_STYLE,
  SceneAssetPanel,
} from "../../shared/components/SceneAssetPanel";
import { type SplatFormat } from "../../shared/splat-format";
import { createLocalStorageHook } from "../../shared/use-local-storage";
import { useSceneAssets } from "../../shared/use-scene-assets";
import { useCanvasSlot } from "../../shared/canvas-slot";
import { useSceneCameraPose } from "../../shared/use-scene-camera";
import {
  FlyWheelController,
  LookRotateController,
} from "../../shared/fly-camera-controllers";
import { useSceneVisuals } from "../../shared/use-scene-visuals";
import {
  colorForIndex,
  cornerPositions,
  formatBboxPresets,
  boxEdges,
  MIN_EDGE_RADIUS,
  parseBoxes,
  toBBoxOutput,
} from "../bbox/lib/bbox";
import type { BBoxItem } from "../bbox/lib/bbox";
import { EdgeCylinder } from "../bbox/components/BBoxLayer";
import { loadSceneGraph } from "./lib/scene-loader";
import { logEvent } from "./lib/logger";
import { pickTarget } from "./lib/picking";
import type { PickTarget, PickKind } from "./lib/picking";
import {
  isConnectShortcut,
  isRedoShortcut,
  isUndoShortcut,
} from "../../shared/shortcuts";
import {
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
} from "./lib/history";
import {
  emptyMutations,
  mutationCount,
  edgeKey,
  addDeletePoly,
  addDeleteArea,
  addRemoveEdge,
  addAddEdge,
  addMovePoly,
  addUpdateObjectLabel,
  addUpdateObjectFatherPoly,
  addUpdateObjectPosition,
  addUpdateObjectId,
  addDeleteObject,
  addCreatePoly,
  isPendingCreatePoly,
  addCreateObject,
  addUpdateObjectOrder,
  addUpdateArea,
  addUpdateObjectColor,
  addUpdateCreatePolyCenter,
  addUpdateCreateObjectPosition,
  addUpdateCreateObjectLabel,
  addUpdateCreateObjectColor,
  removeCreatePoly,
  removeCreateObject,
} from "./lib/mutations";
import type {
  SceneData,
  PreprocessedArea,
  PreprocessedPoly,
  TopologicalNode,
  TopologicalEdge,
  SceneObject,
  Mutations,
  EditMode,
  ExportResponse,
} from "./lib/types";

// ---- layers ----

interface Layers {
  areas: boolean;
  areaEdges: boolean;
  areaCenters: boolean;
  polyWireframe: boolean;
  polyMesh: boolean;
  topoNodes: boolean;
  topoEdges: boolean;
  objects: boolean;
}

type LayerKey = keyof Layers;

// Shared overlay chrome. Most floating panels share the same dark background,
// text colour and monospace font; individual panels only override what differs
// (position, radius, padding, size).
const DARK_PANEL: CSSProperties = {
  background: "rgba(10,12,24,0.88)",
  color: "#ccc",
  fontFamily: "monospace",
  // Subtle accent border + soft shadow give the floating panels a more
  // polished, "designed" feel without changing the dark/blue theme.
  border: "1px solid rgba(52,152,219,0.35)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
};

const FLOATING_OVERLAY: CSSProperties = {
  ...DARK_PANEL,
  position: "absolute",
};

/** One row per layer group, wrapping when the card is too narrow. */
const TOGGLE_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  // Generous row gap so wrapped toggle rows do not read as one cramped block.
  gap: "10px 16px",
  lineHeight: 1.5,
};

const HINT_BAR: CSSProperties = {
  ...FLOATING_OVERLAY,
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 10px",
  borderRadius: 6,
  color: "#ddd",
  fontSize: 12,
};

/**
 * Pick-filter bar, centered directly under the edit toolbar. It only exists in
 * edit mode because the 3D picker itself is disabled in view mode — keeping it
 * out of the Layers card avoids offering a control that silently does nothing.
 */
const SELECT_FILTER_BAR: CSSProperties = {
  ...FLOATING_OVERLAY,
  // The edit toolbar ends at y≈62; the extra 10px keeps the two bars visually
  // separate instead of touching edge to edge.
  top: 72,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 12,
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "6px 14px",
  borderRadius: 8,
  fontSize: 12,
  userSelect: "none",
};

interface ConnectionNotice {
  kind: "success" | "info" | "error";
  message: string;
}

// ---- helpers ----

function vDist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function makeSyntheticNode(
  center: [number, number, number],
  areaId: number,
  id: number,
): TopologicalNode {
  return { id, areaId, position: center, colorHex: "#3498db" };
}

/**
 * Pre-assign the real poly id for the next created node: max over loaded ids
 * and already-pre-assigned pending ids, plus one. The backend honors this id
 * at export (see applyCreatePolys), so the node can be connected immediately.
 */
function nextPolyId(loadedNodes: TopologicalNode[], m: Mutations): number {
  let max = 0;
  for (const n of loadedNodes) max = Math.max(max, n.id);
  for (const cp of m.createPoly) max = Math.max(max, cp.id);
  return max + 1;
}

/** Convert an RGB color in 0–1 floats to a `#rrggbb` hex string. */
function rgb01ToHex(rgb: [number, number, number]): string {
  const t = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${t(rgb[0])}${t(rgb[1])}${t(rgb[2])}`;
}

/** Convert a `#rrggbb` hex string to RGB in 0–1 floats. */
function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Convert RGB in 0–255 integers to a `#rrggbb` hex string. */
function rgb255ToHex(rgb: [number, number, number]): string {
  const t = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x)))
      .toString(16)
      .padStart(2, "0");
  return `#${t(rgb[0])}${t(rgb[1])}${t(rgb[2])}`;
}

function effectiveNodes(
  allNodes: TopologicalNode[],
  m: Mutations,
): TopologicalNode[] {
  const deleted = new Set(m.deletePolyIds);
  const moveMap = new Map(m.movePoly.map((mp) => [mp.id, mp.center]));

  const existing = allNodes
    .filter((n) => !deleted.has(n.id))
    .map((n) => {
      const newCenter = moveMap.get(n.id);
      if (newCenter) {
        return { ...n, position: [newCenter[0], newCenter[1], newCenter[2]] as [number, number, number] };
      }
      return n;
    });

  // Synthesise display nodes for pending createPoly mutations. Each entry
  // already carries its pre-assigned real poly id, so the node renders — and
  // can be connected — with the id it will keep after export.
  const created: TopologicalNode[] = [];
  for (const cp of m.createPoly) {
    created.push(makeSyntheticNode(cp.center as [number, number, number], cp.areaId, cp.id));
  }

  return [...existing, ...created];
}

/** True when two XYZ positions are effectively equal (2-decimal editing). */
function samePosition(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  const EPS = 1e-4;
  return (
    Math.abs(a[0] - b[0]) < EPS &&
    Math.abs(a[1] - b[1]) < EPS &&
    Math.abs(a[2] - b[2]) < EPS
  );
}

/** Apply live (uncommitted) node-position previews on top of committed nodes. */
function applyNodePreview(
  nodes: TopologicalNode[],
  preview: Map<number, [number, number, number]>,
): TopologicalNode[] {
  if (preview.size === 0) return nodes;
  return nodes.map((n) => {
    const p = preview.get(n.id);
    if (!p) return n;
    return { ...n, position: [p[0], p[1], p[2]] as [number, number, number] };
  });
}

/** Apply live (uncommitted) object-position previews on top of committed objects. */
function applyObjectPreview(
  objects: SceneObject[],
  preview: Map<number, [number, number, number]>,
): SceneObject[] {
  if (preview.size === 0) return objects;
  return objects.map((o) => {
    const p = preview.get(o.id);
    if (!p) return o;
    return { ...o, position: [p[0], p[1], p[2]] as [number, number, number] };
  });
}

function effectiveEdges(
  allEdges: TopologicalEdge[],
  nodes: TopologicalNode[],
  m: Mutations,
): TopologicalEdge[] {
  const deleted = new Set(m.deletePolyIds);
  const removed = new Set(m.removeEdges.map((e) => edgeKey(e.srcId, e.dstId)));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const existing = allEdges.flatMap((e) => {
    if (deleted.has(e.srcId) || deleted.has(e.dstId)) return [];
    if (removed.has(edgeKey(e.srcId, e.dstId))) return [];
    const src = nodeMap.get(e.srcId);
    const dst = nodeMap.get(e.dstId);
    if (!src || !dst) return [];
    return [{
      ...e,
      length: vDist(src.position, dst.position),
      srcPos: src.position,
      dstPos: dst.position,
      srcColorHex: src.colorHex,
      dstColorHex: dst.colorHex,
      crossArea: src.areaId !== dst.areaId,
    }];
  });

  const existingKeys = new Set(existing.map((e) => edgeKey(e.srcId, e.dstId)));
  const added: TopologicalEdge[] = [];
  const addedKeys = new Set<string>();
  for (const ae of m.addEdges) {
    if (deleted.has(ae.srcId) || deleted.has(ae.dstId)) continue;
    const src = nodeMap.get(ae.srcId);
    const dst = nodeMap.get(ae.dstId);
    if (!src || !dst) continue;
    const key = edgeKey(ae.srcId, ae.dstId);
    if (removed.has(key)) continue;
    if (existingKeys.has(key)) continue;
    if (addedKeys.has(key)) continue;
    addedKeys.add(key);
    added.push({
      srcId: ae.srcId,
      dstId: ae.dstId,
      length: vDist(src.position, dst.position),
      srcPos: src.position,
      dstPos: dst.position,
      srcColorHex: src.colorHex,
      dstColorHex: dst.colorHex,
      crossArea: src.areaId !== dst.areaId,
    });
  }

  return [...existing, ...added];
}

function effectiveObjects(
  allObjects: SceneObject[],
  m: Mutations,
  polyAreaMap: Map<number, number>,
): SceneObject[] {
  // Apply id renames as a flat injective mapping originalId → finalId.
  // addUpdateObjectId already resolves effective ids back to the original
  // id, so each entry is independent and must NOT be chain-followed here
  // (chain-following collapses swaps/cycles into duplicate ids).
  const idMap = new Map<number, number>();
  for (const r of m.updateObjectIds) {
    idMap.set(r.oldId, r.newId);
  }
  const deleted = new Set(m.deleteObjectIds);
  const labelMap = new Map(m.updateObjectLabels.map((u) => [u.id, u.label]));
  const fatherPolyMap = new Map(m.updateObjectFatherPolys.map((u) => [u.objectId, u.fatherPolyId]));
  const positionMap = new Map(
    m.updateObjectPositions.map((u) => [u.id, u.position]),
  );
  const colorMap = new Map(
    m.updateObjectColors.map((u) => [u.id, u.color]),
  );
  const result = allObjects
    .filter((o) => {
      const id = idMap.get(o.id) ?? o.id;
      return !deleted.has(id);
    })
    .map((o) => {
      let obj = o;
      const newId = idMap.get(o.id);
      if (newId !== undefined) {
        obj = { ...obj, id: newId };
      }
      const newLabel = labelMap.get(obj.id);
      if (newLabel !== undefined) {
        obj = { ...obj, label: newLabel };
      }
      const newFather = fatherPolyMap.get(obj.id);
      if (newFather !== undefined) {
        obj = {
          ...obj,
          fatherPolyId: newFather,
          areaId: polyAreaMap.get(newFather) ?? -1,
        };
      }
      const newPos = positionMap.get(obj.id);
      if (newPos !== undefined) {
        obj = { ...obj, position: [newPos[0], newPos[1], newPos[2]] as [number, number, number] };
      }
      const newColor = colorMap.get(obj.id);
      if (newColor !== undefined) {
        obj = { ...obj, colorHex: rgb255ToHex(newColor) };
      }
      return obj;
    });

  // Synthesise display objects for pending createObjects mutations. Negative
  // temporary ids keep them distinct from real objects; the backend assigns
  // fresh positive ids on export and the reload surfaces the real id.
  let tempObjId = -1;
  const created: SceneObject[] = m.createObjects.map((co) => ({
    id: tempObjId--,
    label: co.label,
    position: [...co.position] as [number, number, number],
    colorHex: rgb255ToHex(co.color),
    areaId: -1,
    fatherPolyId: -1,
    cloudPath: "",
  }));

  // Apply the user-defined object order (effective/current ids) when set.
  const order = m.objectOrder ?? [];
  if (order.length > 0) {
    const byId = new Map(result.map((o) => [o.id, o]));
    const ordered: SceneObject[] = [];
    for (const id of order) {
      const obj = byId.get(id);
      if (obj) {
        ordered.push(obj);
        byId.delete(id);
      }
    }
    // Preserve any objects not present in objectOrder (e.g. after rename
    // edge cases) in their current relative order.
    for (const obj of result) {
      if (byId.has(obj.id)) ordered.push(obj);
    }
    return [...ordered, ...created];
  }
  return [...result, ...created];
}

// ---- click handler (inside Canvas) ----

type DragKind = "node" | "object";

interface DragTarget {
  kind: DragKind;
  id: number;
}

interface DragSession {
  target: DragTarget;
  pointerId: number;
  startLocal: [number, number, number];
  moved: boolean;
  lastLocal: [number, number, number];
}

function ClickHandler({
  nodes,
  edges,
  objects,
  editMode,
  sceneGroupRef,
  controlsRef,
  onSelectNode,
  onSelectEdge,
  onSelectObject,
  onDoubleClickNode,
  onDoubleClickObject,
  onDeselectAll,
  onHoverTarget,
  selectableKinds,
  onDragPreview,
  onDragCommit,
  onPickPosition,
}: {
  nodes: TopologicalNode[];
  edges: TopologicalEdge[];
  objects: SceneObject[];
  editMode: boolean;
  sceneGroupRef: RefObject<THREE.Group | null>;
  controlsRef: RefObject<any>;
  onSelectNode: (id: number, additive: boolean) => void;
  onSelectEdge: (key: string) => void;
  onSelectObject: (id: number, additive: boolean) => void;
  onDoubleClickNode: (id: number) => void;
  onDoubleClickObject: (id: number) => void;
  onDeselectAll: () => void;
  onHoverTarget: (target: PickTarget) => void;
  selectableKinds: Set<PickKind>;
  onDragPreview: (
    kind: DragKind,
    id: number,
    position: [number, number, number],
  ) => void;
  onDragCommit: (
    kind: DragKind,
    id: number,
    position: [number, number, number],
  ) => void;
  onPickPosition?: (position: [number, number, number]) => void;
}) {
  const { gl, camera } = useThree();

  // Keep the latest props in a ref so the event listeners don't need to be
  // re-registered on every render. During a drag the preview position updates
  // cause the parent to re-render the node/object arrays every pointermove;
  // re-subscribing here would otherwise drop the active drag session.
  const latestRef = useRef({
    nodes,
    edges,
    objects,
    selectableKinds,
    onSelectNode,
    onSelectEdge,
    onSelectObject,
    onDoubleClickNode,
    onDoubleClickObject,
    onDeselectAll,
    onHoverTarget,
    onDragPreview,
    onDragCommit,
    onPickPosition,
  });
  latestRef.current = {
    nodes,
    edges,
    objects,
    selectableKinds,
    onSelectNode,
    onSelectEdge,
    onSelectObject,
    onDoubleClickNode,
    onDoubleClickObject,
    onDeselectAll,
    onHoverTarget,
    onDragPreview,
    onDragCommit,
    onPickPosition,
  };

  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    const canvas = gl.domElement;
    if (!editMode) {
      latestRef.current.onHoverTarget(null);
      canvas.style.cursor = "";
      return;
    }

    const mouseDown = new THREE.Vector2();
    const mouseUp = new THREE.Vector2();

    const targetAt = (e: MouseEvent | PointerEvent): PickTarget => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;

      const latest = latestRef.current;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      const rect = canvas.getBoundingClientRect();
      return pickTarget({
        nodes: latest.nodes,
        edges: latest.edges,
        objects: latest.objects,
        selectableKinds: latest.selectableKinds,
        camera,
        sceneMatrixWorld: sceneGroup.matrixWorld,
        width: rect.width,
        height: rect.height,
        pointerX: e.clientX - rect.left,
        pointerY: e.clientY - rect.top,
      });
    };

    const positionOf = (
      target: DragTarget,
    ): [number, number, number] | null => {
      const latest = latestRef.current;
      if (target.kind === "node") {
        const node = latest.nodes.find((n) => n.id === target.id);
        return node ? node.position : null;
      }
      const obj = latest.objects.find((o) => o.id === target.id);
      return obj ? obj.position : null;
    };

    // Project the pointer onto the horizontal ground plane at the dragged
    // point's current height, then map back to scene-local coordinates. This
    // keeps the height fixed while the object/node follows the cursor across
    // the floor with a 1:1, natural sensitivity.
    const groundLocalAt = (
      clientX: number,
      clientY: number,
      startLocal: [number, number, number],
    ): [number, number, number] | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const worldStart = new THREE.Vector3(
        startLocal[0],
        startLocal[1],
        startLocal[2],
      ).applyMatrix4(sceneGroup.matrixWorld);
      const plane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -worldStart.y,
      );

      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const worldCurrent = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldCurrent);
      if (!hit) return null;

      const localCurrent = sceneGroup.worldToLocal(worldCurrent.clone());
      return [localCurrent.x, localCurrent.y, localCurrent.z];
    };

    // Seed position for the pending "Add Node / Add Object" panel: project the
    // click onto the world ground plane (y = 0), then back to scene-local
    // coordinates. The panel keeps X/Y/Z editable so height can be fine-tuned.
    const groundY0At = (
      clientX: number,
      clientY: number,
    ): [number, number, number] | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const worldCurrent = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldCurrent);
      if (!hit) return null;

      const localCurrent = sceneGroup.worldToLocal(worldCurrent.clone());
      return [localCurrent.x, localCurrent.y, localCurrent.z];
    };

    const onPointerDown = (e: PointerEvent) => {
      mouseDown.set(e.clientX, e.clientY);

      // Only the left button drags entities. Without this guard a right or
      // middle press on a node/object also captures the pointer and disables
      // OrbitControls, so right-drag PAN (the only camera translation in
      // edit mode) would move the node instead.
      if (e.button !== 0) return;

      const target = targetAt(e);
      if (target?.kind !== "node" && target?.kind !== "object") return;

      const position = positionOf(target);
      if (!position) return;

      dragRef.current = {
        target,
        pointerId: e.pointerId,
        startLocal: position,
        moved: false,
        lastLocal: position,
      };

      // Disable OrbitControls for this gesture so dragging a node/object moves
      // it instead of rotating the camera.
      if (controlsRef.current) controlsRef.current.enabled = false;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    };

    // Throttle hover picking to one pick per animation frame; pointermove can
    // fire far more often than a frame and each pick is a full projection pass.
    let rafId: number | null = null;
    let lastEvent: PointerEvent | null = null;

    const applyHover = () => {
      rafId = null;
      if (!lastEvent) return;
      const e = lastEvent;
      lastEvent = null;
      const target = targetAt(e);
      latestRef.current.onHoverTarget(target);
      canvas.style.cursor = target ? "pointer" : "";
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && e.pointerId === drag.pointerId) {
        const local = groundLocalAt(e.clientX, e.clientY, drag.startLocal);
        if (local) {
          drag.moved = true;
          drag.lastLocal = local;
          latestRef.current.onDragPreview(drag.target.kind, drag.target.id, local);
        }
        return;
      }

      if (e.buttons !== 0) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        lastEvent = null;
        latestRef.current.onHoverTarget(null);
        canvas.style.cursor = "";
        return;
      }

      lastEvent = e;
      if (rafId === null) {
        rafId = requestAnimationFrame(applyHover);
      }
    };

    const finishDrag = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;

      if (controlsRef.current) controlsRef.current.enabled = true;
      try {
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
      } catch {}

      if (drag.moved) {
        latestRef.current.onDragCommit(
          drag.target.kind,
          drag.target.id,
          drag.lastLocal,
        );
      }
    };

    const onLeave = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastEvent = null;
      latestRef.current.onHoverTarget(null);
      canvas.style.cursor = "";
    };

    const onClick = (e: MouseEvent) => {
      mouseUp.set(e.clientX, e.clientY);
      if (mouseDown.distanceTo(mouseUp) > 3) return; // drag, not click

      const el = e.target as HTMLElement;
      if (
        el.closest("[data-overlay]") ||
        el.tagName === "BUTTON" ||
        el.tagName === "INPUT" ||
        el.tagName === "LABEL"
      )
        return;

      // In position-pick mode (Add Node / Add Object), any click on the scene
      // seeds the panel position instead of selecting an existing target.
      if (latestRef.current.onPickPosition) {
        const local = groundY0At(e.clientX, e.clientY);
        if (local) latestRef.current.onPickPosition(local);
        return;
      }

      const target = targetAt(e);
      if (target?.kind === "node") {
        e.stopPropagation();
        latestRef.current.onSelectNode(target.id, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      if (target?.kind === "edge") {
        e.stopPropagation();
        latestRef.current.onSelectEdge(target.key);
        return;
      }
      if (target?.kind === "object") {
        e.stopPropagation();
        latestRef.current.onSelectObject(target.id, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }

      latestRef.current.onDeselectAll();
    };

    const onDoubleClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.closest("[data-overlay]") ||
        el.tagName === "BUTTON" ||
        el.tagName === "INPUT" ||
        el.tagName === "LABEL"
      )
        return;

      const target = targetAt(e);
      if (target?.kind === "node") {
        e.stopPropagation();
        latestRef.current.onDoubleClickNode(target.id);
        return;
      }
      if (target?.kind === "object") {
        e.stopPropagation();
        latestRef.current.onDoubleClickObject(target.id);
        return;
      }
    };

    canvas.style.cursor = "";
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", finishDrag, { capture: true });
    canvas.addEventListener("pointercancel", finishDrag, { capture: true });
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick, { capture: true });
    canvas.addEventListener("dblclick", onDoubleClick, { capture: true });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      canvas.removeEventListener("pointermove", onPointerMove, { capture: true });
      canvas.removeEventListener("pointerup", finishDrag, { capture: true });
      canvas.removeEventListener("pointercancel", finishDrag, { capture: true });
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick, { capture: true });
      canvas.removeEventListener("dblclick", onDoubleClick, { capture: true });
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastEvent = null;
      if (dragRef.current) {
        if (controlsRef.current) controlsRef.current.enabled = true;
        dragRef.current = null;
      }
      canvas.style.cursor = "";
      latestRef.current.onHoverTarget(null);
    };
  }, [editMode, gl, camera, sceneGroupRef, controlsRef]);

  return null;
}

// ---- camera focus (double-click object in list) ----

function CameraFocusController({
  focusRequest,
  sceneGroupRef,
  controlsRef,
  objects,
  nodeMap,
}: {
  focusRequest: { id: number; nonce: number; kind: "object" | "node" } | null;
  sceneGroupRef: RefObject<THREE.Group | null>;
  controlsRef: RefObject<any>;
  objects: SceneObject[];
  nodeMap: Map<number, TopologicalNode>;
}) {
  const camera = useThree((s) => s.camera);
  const lastNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!focusRequest) return;
    if (lastNonceRef.current === focusRequest.nonce) return;
    lastNonceRef.current = focusRequest.nonce;

    const sceneGroup = sceneGroupRef.current;
    const controls = controlsRef.current;
    if (!sceneGroup || !controls) return;

    if (focusRequest.kind === "node") {
      const node = nodeMap.get(focusRequest.id);
      if (!node) return;

      sceneGroup.updateWorldMatrix(true, false);
      const nodeWorld = sceneGroup.localToWorld(
        new THREE.Vector3(
          node.position[0],
          node.position[1],
          node.position[2],
        ),
      );
      const cameraOffset = camera.position.clone().sub(controls.target);
      controls.target.copy(nodeWorld);
      camera.position.copy(nodeWorld).add(cameraOffset);
      camera.lookAt(nodeWorld);
      controls.update();
      return;
    }

    const object = objects.find((o) => o.id === focusRequest.id);
    if (!object) return;
    const node =
      object.fatherPolyId >= 0
        ? nodeMap.get(object.fatherPolyId)
        : undefined;
    if (!node) return;

    sceneGroup.updateWorldMatrix(true, false);
    const objectWorld = sceneGroup.localToWorld(
      new THREE.Vector3(
        object.position[0],
        object.position[1],
        object.position[2],
      ),
    );
    const nodeWorld = sceneGroup.localToWorld(
      new THREE.Vector3(node.position[0], node.position[1], node.position[2]),
    );

    controls.target.copy(objectWorld);
    camera.position.copy(nodeWorld);
    camera.lookAt(objectWorld);
    controls.update();
  }, [focusRequest, sceneGroupRef, controlsRef, objects, nodeMap, camera]);

  return null;
}

// ---- scene ----

// ---------------------------------------------------------------------------
// Read-only 3D BBox annotation overlay: the AABBs saved for the active asset
// by the BBox Anno mode (same scene + asset name, same Z-up local frame),
// drawn as thin wireframes in the annotation palette colors. Silent by
// design — visible in the scene, but no hover / click / drag (raycasting is
// disabled so it can never be picked or block picks), no panel, not editable
// here; edit them in the BBox Anno mode.
// ---------------------------------------------------------------------------

/** three.js raycast no-op: overlay lines must never intercept picks. */
const overlayNoRaycast = () => {};

function BBoxAnnotationOverlay({
  boxes,
  assocMode,
  pendingBboxId,
  onPickBbox,
  pickable,
  objects,
  edgeWidth,
  fillOpacity,
}: {
  boxes: BBoxItem[];
  /** Association mode: link lines + object labels appear. */
  assocMode: boolean;
  /** The box currently awaiting an object click; null = none picked yet. */
  pendingBboxId: string | null;
  onPickBbox: (id: string) => void;
  /** Proxies pickable at all (association OR target-creation mode). */
  pickable: boolean;
  objects: SceneObject[];
  /** Box visuals shared with the BBox Anno mode (3dbbox_ localStorage). */
  edgeWidth: number;
  fillOpacity: number;
}) {
  const EDGES = boxEdges();
  const items = useMemo(() => {
    return boxes.map((b, index) => {
      const center: [number, number, number] = [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
      ];
      // Association link: bbox center → owning object (thin blue line).
      // Rendered only while assocMode is on. If the stored objectId is not in
      // the current snapshot, no line but the label still shows (id may be
      // snapshot-dependent — see the plan's Risks section).
      const obj =
        b.objectId != null ? objects.find((o) => o.id === b.objectId) : undefined;
      // Plain position data (no THREE resource): the <bufferGeometry> below is
      // built declaratively so R3F owns its disposal, instead of a
      // geometry created here (StrictMode double-invokes useMemo factories and
      // would leak the discarded one).
      let linkPositions: Float32Array | null = null;
      let labelPosition: [number, number, number] | null = null;
      if (b.objectId != null) {
        if (obj) {
          linkPositions = new Float32Array([
            center[0],
            center[1],
            center[2],
            obj.position[0],
            obj.position[1],
            obj.position[2],
          ]);
        }
        labelPosition = [center[0], center[1], b.max[2] + 0.25];
      }
      return {
        key: b.id,
        box: b,
        corners: cornerPositions(b.min, b.max),
        position: center,
        size: [
          b.max[0] - b.min[0],
          b.max[1] - b.min[1],
          b.max[2] - b.min[2],
        ] as [number, number, number],
        color: colorForIndex(index),
        linkPositions,
        linkLabel:
          b.objectId != null
            ? `${b.objectLabel ?? obj?.label ?? "?"} [${b.objectId}]`
            : null,
        labelPosition,
      };
    });
  }, [boxes, objects]);

  const edgeRadius = Math.max(MIN_EDGE_RADIUS, edgeWidth / 2);

  return (
    <group>
      {/* Same box look as the BBox Anno mode: 12 edge cylinders + a
          semi-transparent fill, keyed by the same 3dbbox_ visual params.
          Everything here is a display-only no-pick (raycast no-op) so the
          overlay can never intercept node/object picks. */}
      {items.map((it) => {
        const pending = pendingBboxId === it.box.id;
        const edgeColor = pending ? "#ffffff" : it.color;
        return (
          <group key={it.key}>
            {EDGES.map(([a, b], i) => (
              <EdgeCylinder
                key={i}
                start={it.corners[a]!}
                end={it.corners[b]!}
                radius={edgeRadius}
                color={edgeColor}
                raycast={overlayNoRaycast}
              />
            ))}
            <mesh position={it.position} raycast={overlayNoRaycast}>
              <boxGeometry args={it.size} />
              <meshBasicMaterial
                color={it.color}
                transparent
                opacity={fillOpacity}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        );
      })}
      {pickable && (
        <>
          {/* Transparent pick proxies. While a box is pending (association
              flow), ALL proxies stop raycasting so the object click passes
              through to the object behind the box. Unlinking is NOT done by
              clicking the box again — that click would never reach the
              proxy — but via the X key (main component keydown effect). */}
          {items.map((it) => (
            <mesh
              key={`proxy-${it.key}`}
              position={it.position}
              onClick={(e) => {
                e.stopPropagation();
                onPickBbox(it.box.id);
              }}
              raycast={pendingBboxId ? overlayNoRaycast : undefined}
            >
              <boxGeometry args={it.size} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          ))}
        </>
      )}
      {assocMode && (
        <>
          {items.map((it) =>
            it.linkPositions ? (
              <lineSegments
                key={`link-${it.key}`}
                raycast={overlayNoRaycast}
              >
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[it.linkPositions, 3]}
                  />
                </bufferGeometry>
                <lineBasicMaterial
                  color="#3498db"
                  transparent
                  opacity={0.9}
                  depthWrite={false}
                />
              </lineSegments>
            ) : null,
          )}
          {items.map((it) =>
            it.linkLabel && it.labelPosition ? (
              <Html
                key={`label-${it.key}`}
                position={it.labelPosition}
                center
                style={{
                  color: "#7fd4ff",
                  fontSize: 10,
                  fontFamily: "monospace",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  textShadow: "0 0 4px rgba(0,0,0,0.8)",
                }}
              >
                {it.linkLabel}
              </Html>
            ) : null,
          )}
        </>
      )}
    </group>
  );
}

function Scene({
  effectiveNodes: tNodes,
  effectiveEdges: tEdges,
  effectivePolys,
  effectiveAreas,
  effectiveObjects: tObjects,
  layers,
  bboxAnnotations,
  assocMode,
  pendingBboxId,
  onPickBbox,
  bboxPickable,
  bboxVisible,
  bboxEdgeWidth,
  bboxFillOpacity,
  selectedArea,
  selectedNodeIds,
  selectedEdgeKey,
  selectedObjectIds,
  editMode,
  onSelectNode,
  onSelectEdge,
  onSelectObject,
  onDoubleClickNode,
  onDoubleClickObject,
  onDeselectAll,
  meshOpacity,
  pcdLayers,
  pcdPointSize,
  pcdColorScheme,
  renderMode,
  gridSize,
  showAxes,
  cloudOpacity,
  splatSrc,
  splatFormat,
  onSplatLoadingChange,
  onSplatError,
  nodeSize,
  topoEdgeThickness,
  objectSize,
  objectLineThickness,
  selectableKinds,
  focusRequest,
  onDragPreview,
  onDragCommit,
  onPickPosition,
}: {
  effectiveNodes: TopologicalNode[];
  effectiveEdges: TopologicalEdge[];
  effectivePolys: PreprocessedPoly[];
  effectiveAreas: PreprocessedArea[];
  effectiveObjects: SceneObject[];
  layers: Layers;
  bboxAnnotations: BBoxItem[] | null;
  assocMode: boolean;
  pendingBboxId: string | null;
  onPickBbox: (id: string) => void;
  /** Proxies pickable at all (association OR target-creation mode). */
  bboxPickable: boolean;
  /** Overlay drawn at all: the show switch, forced on by either pick mode. */
  bboxVisible: boolean;
  bboxEdgeWidth: number;
  bboxFillOpacity: number;
  selectedArea: number | null;
  selectedNodeIds: Set<number>;
  selectedEdgeKey: string | null;
  selectedObjectIds: Set<number>;
  editMode: boolean;
  onSelectNode: (id: number, additive: boolean) => void;
  onSelectEdge: (key: string | null) => void;
  onSelectObject: (id: number, additive: boolean) => void;
  onDoubleClickNode: (id: number) => void;
  onDoubleClickObject: (id: number) => void;
  onDeselectAll: () => void;
  meshOpacity: number;
  pcdLayers: { key: string; positions: Float32Array; colorHex: string }[];
  pcdPointSize: number;
  pcdColorScheme: PcdColorScheme;
  renderMode: "pointcloud" | "3dgs";
  gridSize: number;
  showAxes: boolean;
  cloudOpacity: number;
  splatSrc: string | null;
  splatFormat: SplatFormat;
  onSplatLoadingChange: (loading: boolean) => void;
  onSplatError: (message: string | null) => void;
  nodeSize: number;
  topoEdgeThickness: number;
  objectSize: number;
  objectLineThickness: number;
  selectableKinds: Set<PickKind>;
  focusRequest: { id: number; nonce: number; kind: "object" | "node" } | null;
  onDragPreview: (
    kind: "node" | "object",
    id: number,
    position: [number, number, number],
  ) => void;
  onDragCommit: (
    kind: "node" | "object",
    id: number,
    position: [number, number, number],
  ) => void;
  onPickPosition?: (position: [number, number, number]) => void;
}) {
  const sceneGroupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<any>(null);
  // ONE camera pose across all three modes: restore on mount, track live.
  useSceneCameraPose();
  const [hoverTarget, setHoverTarget] = useState<PickTarget>(null);
  const handleHoverTarget = useCallback((target: PickTarget) => {
    setHoverTarget((current) => {
      if (current === null || target === null) return current === target ? current : target;
      if (current.kind !== target.kind) return target;
      if (current.kind === "node" && target.kind === "node" && current.id === target.id) return current;
      if (current.kind === "edge" && target.kind === "edge" && current.key === target.key) return current;
      // picking.ts returns a fresh object literal for objects on every
      // pick, so without an id-equality branch here hovering an object
      // would re-render the whole Scene on every rAF.
      if (current.kind === "object" && target.kind === "object" && current.id === target.id) return current;
      return target;
    });
  }, []);

  // Node lookup map for object→father_poly connection lines
  const nodeMap = useMemo(
    () => new Map(tNodes.map((n) => [n.id, n])),
    [tNodes],
  );

  const areaBoxes = useMemo(
    () =>
      effectiveAreas.map((a) => (
        <AreaBox
          key={a.id}
          area={a}
          visible={layers.areas}
          selected={a.id === selectedArea}
        />
      )),
    [effectiveAreas, layers.areas, selectedArea],
  );

  // Rendered into the shared persistent canvas (App level) via useCanvasSlot
  // — the canvas (and its WebGL context / GPU resources) survives mode
  // switches, so the splat viewer and point clouds re-attach instantly.
  return (
    <>
      <PerspectiveCamera makeDefault position={[12, 25, 20]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 15, 5]} intensity={1.2} />

      <group ref={sceneGroupRef} rotation={[-Math.PI / 2, 0, 0]}>
        {showAxes && <WorldAxes />}
        {areaBoxes}
        {/* Read-only 3D BBox annotations (silent overlay, not pickable
            outside association mode). */}
        {bboxAnnotations &&
          bboxAnnotations.length > 0 &&
          bboxVisible && (
          <BBoxAnnotationOverlay
            boxes={bboxAnnotations}
            assocMode={assocMode}
            pendingBboxId={pendingBboxId}
            objects={tObjects}
            onPickBbox={onPickBbox}
            pickable={bboxPickable}
            edgeWidth={bboxEdgeWidth}
            fillOpacity={bboxFillOpacity}
          />
        )}
        {layers.areaEdges && <AreaEdges areas={effectiveAreas} visible />}
        {layers.areaCenters && (
          <AreaCenters areas={effectiveAreas} visible />
        )}
        {layers.polyWireframe && (
          <PolyhedraAll
            areas={effectiveAreas}
            effectivePolys={effectivePolys}
            selectedArea={selectedArea}
          />
        )}
        {layers.polyMesh && (
          <PolyMesh
            polys={effectivePolys}
            visible
            opacity={meshOpacity}
            selectedArea={selectedArea}
          />
        )}
        {layers.topoEdges && (
          <TopologicalEdges
            edges={tEdges}
            visible
            selectedArea={selectedArea}
            selectedEdgeKey={selectedEdgeKey}
            hoveredEdgeKey={hoverTarget?.kind === "edge" ? hoverTarget.key : null}
            edgeThickness={topoEdgeThickness}
          />
        )}
        {layers.topoNodes && (
          <TopologicalNodes
            nodes={tNodes}
            visible
            selectedArea={selectedArea}
            selectedNodeIds={selectedNodeIds}
            hoveredNodeId={hoverTarget?.kind === "node" ? hoverTarget.id : null}
            nodeSize={nodeSize}
          />
        )}
        {layers.objects && (
          <ObjectsLayer
            objects={tObjects}
            nodeMap={nodeMap}
            visible
            selectedArea={selectedArea}
            selectedObjectIds={selectedObjectIds}
            hoveredObjectId={hoverTarget?.kind === "object" ? hoverTarget.id : null}
            objectSize={objectSize}
            lineThickness={objectLineThickness}
          />
        )}
        {renderMode === "pointcloud" &&
          pcdLayers.map((layer) => (
            <PointCloudLayer
              key={layer.key}
              positions={layer.positions}
              colorHex={layer.colorHex}
              pointSize={pcdPointSize}
              colorScheme={pcdColorScheme}
              opacity={cloudOpacity}
            />
          ))}
        {/* 3DGS mode: DropInViewer lives in the same rotated (Z-up→Y-up)
            group as the PCD layers, so coordinates stay aligned across
            render modes. Keyed by src so switching files rebuilds cleanly. */}
        {renderMode === "3dgs" && splatSrc && (
          <GaussianSplatLayer
            key={splatSrc}
            src={splatSrc}
            format={splatFormat}
            onLoadingChange={onSplatLoadingChange}
            onError={onSplatError}
          />
        )}
        {/* Click handler: processes node/edge/object selection. */}
        <ClickHandler
          nodes={layers.topoNodes ? tNodes : []}
          edges={layers.topoEdges ? tEdges : []}
          objects={layers.objects ? tObjects : []}
          editMode={editMode}
          sceneGroupRef={sceneGroupRef}
          controlsRef={controlsRef}
          onSelectNode={onSelectNode}
          onSelectEdge={onSelectEdge}
          onSelectObject={onSelectObject}
          onDoubleClickNode={onDoubleClickNode}
          onDoubleClickObject={onDoubleClickObject}
          onDeselectAll={onDeselectAll}
          onHoverTarget={handleHoverTarget}
          selectableKinds={selectableKinds}
          onDragPreview={onDragPreview}
          onDragCommit={onDragCommit}
          onPickPosition={onPickPosition}
        />
      </group>

      <SceneGrid size={gridSize} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.1}
        enableZoom={false}
        rotateSpeed={1.5}
      />
      <FlyWheelController controlsRef={controlsRef} />
      <LookRotateController controlsRef={controlsRef} rotateSpeed={1.5} />
      <CameraFocusController
        focusRequest={focusRequest}
        sceneGroupRef={sceneGroupRef}
        controlsRef={controlsRef}
        objects={tObjects}
        nodeMap={nodeMap}
      />
    </>
  );
}

// ---- app ----

// Persistence prefix for SceneGraph display parameters. Must stay
// byte-identical or already saved settings silently reset.
const useLocalStorageState = createLocalStorageHook("sge_");

// SAME prefix and keys as the BBox Anno mode's box visuals (3dbbox_lineWidth,
// 3dbbox_opacity): the silent overlay inherits the exact box look the user
// tuned over there (read-only here; adjust the look in the BBox Anno mode).
const useBboxVisualState = createLocalStorageHook("3dbbox_");

export function SceneGraphMode() {
  // Scene-rendering state — the ONE shared implementation (scene bucket,
  // asset listing, selections, render mode, point-cloud loading with the
  // module-level cache) used by all three modes. SceneGraph only adds its
  // snapshot/edit state on top of it.
  const {
    scenes,
    scene,
    scenesLoaded,
    selectScene,
    cloudFiles,
    splatFiles,
    renderMode,
    setRenderMode,
    selectedCloud,
    selectCloud,
    selectedSplat,
    selectSplat,
    activeFormat,
    activeName,
    activeUrl,
    positions,
    cloudLoading,
    cloudError,
  } = useSceneAssets();
  const [data, setData] = useState<SceneData | null>(null);
  const [snapshot, setSnapshot] = useState<string>("");
  const [snapshots, setSnapshots] = useState<{ name: string; saved_at: string; summary: any }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Read-only 3D BBox annotations saved for the active asset (the same file
  // the BBox Anno mode edits). Rendered as a silent wireframe overlay in the
  // Scene — visible, but never pickable/editable here.
  const [bboxAnnotations, setBboxAnnotations] = useState<BBoxItem[] | null>(null);
  // BBox ↔ object association mode: when on, clicking a bbox proxy picks the
  // box (pendingBboxId), then clicking an object associates them (written
  // straight through to the annotation file). X unlinks the pending box.
  const [assocMode, setAssocMode] = useState(false);
  const [pendingBboxId, setPendingBboxId] = useState<string | null>(null);
  const [copiedPresets, setCopiedPresets] = useState(false);
  // Pick-a-bbox-to-create-target mode: clicking a bbox opens the AddObject
  // dialog with the box center prefilled (the typed-coordinates path stays
  // available in the same dialog — the user can still edit the numbers).
  const [pickBboxForTarget, setPickBboxForTarget] = useState(false);
  // Box visuals shared with the BBox Anno mode (3dbbox_ prefix): edge width
  // and fill opacity of the annotation boxes. Read-only here — the overlay
  // mirrors whatever the BBox Anno mode persisted.
  const [bboxEdgeWidth] = useBboxVisualState<number>("lineWidth", 0.04);
  const [bboxFillOpacity] = useBboxVisualState<number>("opacity", 0.08);
  useEffect(() => {
    if (!scene || !activeName) {
      setBboxAnnotations(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/bbox?scene=${encodeURIComponent(scene)}&name=${encodeURIComponent(activeName)}`,
        );
        if (resp.status === 404) {
          if (!cancelled) setBboxAnnotations(null);
          return;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        if (!cancelled) setBboxAnnotations(parseBoxes(payload));
      } catch {
        // No saved boxes (or load failed): no overlay.
        if (!cancelled) setBboxAnnotations(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scene, activeName]);

  // "Show BBox" visibility switch for the read-only overlay. Persisted under
  // the SceneGraph display prefix (sge_) so it survives reloads/mode switches.
  const [showBbox, setShowBbox] = useLocalStorageState<boolean>("showBbox", true);

  const [layers, setLayers] = useState<Layers>({
    areas: true,
    areaEdges: false,
    areaCenters: false,
    polyWireframe: false,
    polyMesh: false,
    topoNodes: true,
    topoEdges: true,
    objects: true,
  });
  const [selectedArea, setSelectedArea] = useState<number | null>(null);
  const [meshOpacity, setMeshOpacity] = useState(0.1);

  // Edit state
  const [editMode, setEditMode] = useState<EditMode>("view");
  // Mirrors editMode for event handlers that need the current value
  // (updaters must stay pure under StrictMode double-invocation).
  const editModeRef = useRef<EditMode>(editMode);
  editModeRef.current = editMode;
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(
    new Set(),
  );
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [selectedObjectIds, setSelectedObjectIds] = useState<Set<number>>(
    new Set(),
  );
  const [editHistory, setEditHistory] = useState(() =>
    createHistory(emptyMutations()),
  );
  const [showDiff, setShowDiff] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [base, setBase] = useState<"saved" | "exported">("saved");
  const [connectionNotice, setConnectionNotice] =
    useState<ConnectionNotice | null>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showAddObjectPanel, setShowAddObjectPanel] = useState(false);
  const [addMode, setAddMode] = useState<"node" | "object" | null>(null);
  const [pickedPosition, setPickedPosition] = useState<
    [number, number, number] | null
  >(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{
    id: number;
    nonce: number;
    kind: "object" | "node";
  } | null>(null);

  // Live (uncommitted) position previews. Kept outside editHistory so typing
  // / stepping an XYZ axis updates the view immediately without creating an
  // undo entry; blur / Enter still commits through the normal history path.
  const [previewObjectPositions, setPreviewObjectPositions] = useState<
    Map<number, [number, number, number]>
  >(new Map());
  const [previewNodePositions, setPreviewNodePositions] = useState<
    Map<number, [number, number, number]>
  >(new Map());

  // Scene-cloud layer for the canvas, derived from the shared loader's
  // positions (stays filled while the 3DGS renderer is active so switching
  // back is instant).
  const pcdLayers = useMemo(
    () =>
      positions
        ? [{ key: "scene", positions, colorHex: "#aaccff" }]
        : [],
    [positions],
  );

  // Splat renderer feedback (loading/error from the canvas layer).
  const [splatLoading, setSplatLoading] = useState(false);
  const [splatError, setSplatError] = useState<string | null>(null);

  // Display controls
  const [nodeSize, setNodeSize] = useLocalStorageState("disp_nodeSize_v2", 0.1);
  const [topoEdgeThickness, setTopoEdgeThickness] = useLocalStorageState("disp_topoEdge_v2", 2);
  const [objectSize, setObjectSize] = useLocalStorageState("disp_objSize_v2", 0.02);
  const [objectLineThickness, setObjectLineThickness] = useLocalStorageState("disp_objLine_v2", 0.01);
  // Scene point size / color scheme / grid / axes: the ONE shared setting
  // across all three modes.
  const {
    pointSize: pcdPointSize,
    setPointSize: setPcdPointSize,
    gridSize,
    setGridSize,
    showAxes,
    setShowAxes,
    colorScheme: pcdColorScheme,
    setColorScheme: setPcdColorScheme,
    opacity,
    setOpacity,
  } = useSceneVisuals();

  // Selection filter
  const [selectableKinds, setSelectableKinds] = useState<Set<PickKind>>(
    new Set(["node", "edge", "object"] as PickKind[]),
  );
  const toggleSelectable = useCallback((k: PickKind) => {
    setSelectableKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const mutations = editHistory.present;

  const dirty = mutationCount(mutations) > 0;

  // Keep a ref to the latest mutations so handleExport always sees the
  // freshest state — clicking Export blurs any focused inline input, whose
  // commit may not be visible to the click handler's closure yet.
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  // Mirrors of `scene` / `snapshot` for post-await guards: those fetches are
  // async and the user may switch scene OR snapshot while one is in flight,
  // and two scenes can share a snapshot name — so the guard has to compare
  // both, not just the snapshot.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Set by the snapshot-listing effect once the listing for the CURRENT scene
  // has settled. Phase 2's "None" branch consults it: while the listing is
  // still in flight `snapshot` is transiently "" too, and clearing `loading`
  // there would flash the empty state before the first snapshot starts
  // loading.
  const snapshotsSettledRef = useRef(false);

  const commitEdit = useCallback(
    (update: (current: Mutations) => Mutations) => {
      setEditHistory((history) =>
        commitHistory(history, update(history.present)),
      );
    },
    [],
  );

  const setObjectPositionPreview = useCallback(
    (id: number, position: [number, number, number]) => {
      setPreviewObjectPositions((prev) => {
        const next = new Map(prev);
        next.set(id, position);
        return next;
      });
    },
    [],
  );

  const clearObjectPositionPreview = useCallback((id: number) => {
    setPreviewObjectPositions((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const setNodePositionPreview = useCallback(
    (id: number, center: [number, number, number]) => {
      setPreviewNodePositions((prev) => {
        const next = new Map(prev);
        next.set(id, center);
        return next;
      });
    },
    [],
  );

  const clearNodePositionPreview = useCallback((id: number) => {
    setPreviewNodePositions((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Phase 1: list all snapshots of the active scene. On a scene switch this
  // also drops every snapshot-scoped state (same reset as
  // handleSwitchSnapshot) so old-scene edits can never leak into an export
  // against the new scene — even if both scenes happen to share a snapshot
  // name. All resets are no-ops on the initial mount; the shared scene hook
  // resets the asset selections on its side.
  useEffect(() => {
    if (!scene) return;
    setSnapshots([]);
    setSnapshot("");
    setData(null);
    setEditHistory(createHistory(emptyMutations()));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setPreviewObjectPositions(new Map());
    setPreviewNodePositions(new Map());
    setBase("saved");
    setError(null);
    // A scene switch may leave this scene's listing in flight; until it
    // settles, Phase 2 must not treat the transient "" as an explicit "None".
    snapshotsSettledRef.current = false;
    // Stale-response guard: switching scenes mid-fetch must not let the
    // previous scene's listing set `snapshot`, which would make Phase 2 load
    // the new scene at the OLD scene's snapshot name.
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/snapshots?scene=${encodeURIComponent(scene)}`,
        );
        const json = await resp.json();
        if (cancelled) return;
        const list = json.snapshots || [];
        setSnapshots(list);
        snapshotsSettledRef.current = true;
        if (list.length > 0) {
          setSnapshot(list[0].name); // triggers Phase 2
        } else {
          // No snapshots yet: NOT an error — the scene itself (point cloud /
          // 3DGS via the shared scene hook) still renders normally, and the
          // user can create the first snapshot from the scene file.
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scene]);

  // No scene at all (empty scenes/ dir, or the listing failed): nothing will
  // ever be fetched, so the spinner must not stay up for the session. The
  // `scenes.length === 0` part matters — when the listing settled WITH scenes,
  // `scene` is transiently "" for exactly one commit (the hook picks the first
  // entry right after), and clearing `loading` there would flash the empty
  // state before that pick lands.
  useEffect(() => {
    if (!scene && scenesLoaded && scenes.length === 0) setLoading(false);
  }, [scene, scenesLoaded, scenes]);

  // Phase 2: load scene graph for selected snapshot
  useEffect(() => {
    if (!scene) return;
    // "None" selected: nothing to fetch. `loading` must still be cleared here,
    // because the cleanup of the PREVIOUS run already set `cancelled = true`,
    // so its own `setLoading(false)` is skipped — picking "None" while a
    // snapshot was still in flight would otherwise leave the spinner up for
    // the rest of the session. Guarded by `snapshotsSettledRef` so the
    // transient "" of a scene switch (listing still in flight) does not clear
    // it and flash the empty state before the first snapshot loads.
    if (!snapshot) {
      if (snapshotsSettledRef.current) setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: sceneData, source } = await loadSceneGraph(
          `/api/scene-graph?scene=${encodeURIComponent(scene)}&snapshot=${encodeURIComponent(snapshot)}`,
        );
        if (cancelled) return;
        setData(sceneData);
        // Track which copy was actually served (auto prefers exported/) so
        // the next export applies mutations on top of what the user SEES —
        // exporting with a stale base would rebuild exported/ from saved/
        // and silently wipe the previous session's changes.
        setBase(source);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, scene]);

  const handleSelectNode = useCallback(
    (id: number, additive: boolean) => {
      setSelectedNodeIds((prev) => {
        const next = new Set(additive ? prev : []);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      setSelectedEdgeKey(null);
      // Keep object selection when Shift+clicking (additive) so
      // the user can select 1 object + 1 node for reconnection.
      if (!additive) setSelectedObjectIds(new Set());
    },
    [],
  );

  // ---- edge selection ----

  const handleSelectEdge = useCallback((key: string | null) => {
    setSelectedEdgeKey(key);
    setSelectedNodeIds(new Set());
    setSelectedObjectIds(new Set());
  }, []);

  // ---- object selection ----

  // Bbox ↔ object association helpers: used by handleSelectObject below and
  // the X-key handler in the keydown effect. Declared here so the selection
  // callback can capture them.

  // POST the full box list: the backend validates the six numeric fields and
  // passes object_id/object_label through unchanged (whole-file overwrite).
  const persistBboxAnnotations = useCallback(
    async (boxes: BBoxItem[]) => {
      if (!scene || !activeName) return;
      try {
        const resp = await fetch("/api/bbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scene,
            name: activeName,
            boxes: boxes.map(toBBoxOutput),
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [scene, activeName],
  );

  const associateBbox = useCallback(
    (boxId: string, objectId: number) => {
      if (!bboxAnnotations) return;
      // Pending (unexported) new objects carry temporary negative ids —
      // persisting one would write a meaningless id into the file.
      if (objectId < 0) {
        setError("请先导出场景图，再关联新建的物体（当前为临时 id）");
        return;
      }
      const obj = data?.objects.find((o) => o.id === objectId);
      // One object owns at most one bbox: clear any OTHER box already
      // pointing at this object first — duplicate object ids would become
      // duplicate Python dict keys in the copied BBOX_PRESETS.
      const next = bboxAnnotations
        .map((b) =>
          b.objectId === objectId && b.id !== boxId
            ? { ...b, objectId: null, objectLabel: null }
            : b,
        )
        .map((b) =>
          b.id === boxId
            ? { ...b, objectId, objectLabel: obj?.label ?? null }
            : b,
        );
      setBboxAnnotations(next);
      setPendingBboxId(null);
      void persistBboxAnnotations(next);
    },
    [bboxAnnotations, data, persistBboxAnnotations],
  );

  const handleSelectObject = useCallback(
    (id: number, additive: boolean) => {
      // Association mode: the object click completes a pending bbox→object
      // association instead of toggling the object selection.
      if (pendingBboxId) {
        associateBbox(pendingBboxId, id);
        return;
      }
      setSelectedObjectIds((prev) => {
        const next = new Set(additive ? prev : []);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      // Keep node selection when Shift+clicking so the user can
      // select 1 object + 1 node for reconnection.
      if (!additive) setSelectedNodeIds(new Set());
      setSelectedEdgeKey(null);
    },
    [pendingBboxId, associateBbox],
  );

  const handleDoubleClickObject = useCallback((id: number) => {
    setSelectedObjectIds(new Set([id]));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setFocusRequest((prev) => ({
      id,
      nonce: (prev?.nonce ?? 0) + 1,
      kind: "object",
    }));
  }, []);

  const handleDoubleClickNode = useCallback((id: number) => {
    setSelectedNodeIds(new Set([id]));
    setSelectedObjectIds(new Set());
    setSelectedEdgeKey(null);
    setFocusRequest((prev) => ({
      id,
      nonce: (prev?.nonce ?? 0) + 1,
      kind: "node",
    }));
  }, []);

  const handleDeselectAll = useCallback(() => {
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setPreviewObjectPositions(new Map());
    setPreviewNodePositions(new Map());
    setPendingBboxId(null);
    setPickBboxForTarget(false);
  }, []);

  // ---- bbox ↔ object association (unlink / copy / mode toggle) ----

  const unlinkBbox = useCallback(
    (boxId: string) => {
      if (!bboxAnnotations) return;
      const target = bboxAnnotations.find((b) => b.id === boxId);
      if (!target || target.objectId == null) return;
      const next = bboxAnnotations.map((b) =>
        b.id === boxId ? { ...b, objectId: null, objectLabel: null } : b,
      );
      setBboxAnnotations(next);
      setPendingBboxId(null);
      void persistBboxAnnotations(next);
    },
    [bboxAnnotations, persistBboxAnnotations],
  );

  const handleCopyPresets = useCallback(() => {
    if (!bboxAnnotations || bboxAnnotations.length === 0) return;
    const text = formatBboxPresets(bboxAnnotations);
    const done = () => {
      setCopiedPresets(true);
      window.setTimeout(() => setCopiedPresets(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    }
  }, [bboxAnnotations]);

  // State updaters must be pure (StrictMode double-invokes them): clear the
  // pending box in the handler body instead. The two bbox pick modes are
  // mutually exclusive — entering one leaves the other.
  const toggleAssocMode = useCallback(() => {
    setAssocMode((prev) => !prev);
    setPendingBboxId(null);
    setPickBboxForTarget(false);
  }, []);

  const togglePickBboxForTarget = useCallback(() => {
    setPickBboxForTarget((prev) => !prev);
    setAssocMode(false);
    setPendingBboxId(null);
  }, []);

  // Hide/show the read-only bbox overlay. Hiding closes the two bbox pick
  // modes (they are meaningless with no visible boxes); the render condition
  // also re-forces visibility whenever either mode is active, so the reverse
  // path (re-entering a pick mode while hidden) stays consistent.
  const toggleShowBbox = useCallback(() => {
    const next = !showBbox;
    setShowBbox(next);
    if (!next) {
      setAssocMode(false);
      setPendingBboxId(null);
      setPickBboxForTarget(false);
    }
  }, [showBbox, setShowBbox]);

  // A bbox proxy was clicked. Association mode: mark it pending (the next
  // object click completes the association). Target mode: open the AddObject
  // dialog with the bbox center prefilled — the coordinates stay editable,
  // so the target can ALSO be created from fully user-specified numbers.
  const handlePickBbox = useCallback(
    (id: string) => {
      if (pickBboxForTarget) {
        const b = bboxAnnotations?.find((x) => x.id === id);
        if (!b) return;
        setPickedPosition([
          (b.min[0] + b.max[0]) / 2,
          (b.min[1] + b.max[1]) / 2,
          (b.min[2] + b.max[2]) / 2,
        ]);
        setShowAddPanel(false);
        setAddMode("object");
        setShowAddObjectPanel(true);
        setPickBboxForTarget(false);
        return;
      }
      setPendingBboxId(id);
    },
    [pickBboxForTarget, bboxAnnotations],
  );

  // ---- live dragging of nodes / objects ----

  const handleDragPreview = useCallback(
    (kind: "node" | "object", id: number, position: [number, number, number]) => {
      if (kind === "node") setNodePositionPreview(id, position);
      else setObjectPositionPreview(id, position);
    },
    [setNodePositionPreview, setObjectPositionPreview],
  );

  const handleDragCommit = useCallback(
    (kind: "node" | "object", id: number, position: [number, number, number]) => {
      if (kind === "node") {
        // Pending (unexported) new nodes carry their pre-assigned real id:
        // update their createPoly entry directly — movePoly entries for them
        // would be silently dropped by the backend on export.
        commitEdit((current) =>
          isPendingCreatePoly(current, id)
            ? addUpdateCreatePolyCenter(current, id, position)
            : addMovePoly(current, id, position),
        );
        clearNodePositionPreview(id);
      } else {
        commitEdit((current) =>
          id < 0
            ? addUpdateCreateObjectPosition(current, -id - 1, position)
            : addUpdateObjectPosition(current, id, position),
        );
        clearObjectPositionPreview(id);
      }
    },
    [commitEdit, clearNodePositionPreview, clearObjectPositionPreview],
  );

  const handleConnectSelected = useCallback(() => {
    const ids = [...selectedNodeIds];
    if (ids.length !== 2) {
      setConnectionNotice({
        kind: "error",
        message: `Select exactly two nodes (currently ${ids.length})`,
      });
      return;
    }

    const [srcId, dstId] = ids;
    // New (unexported) nodes carry pre-assigned real ids that the backend
    // honors at export, so edges to them resolve like edges to loaded nodes.
    const key = edgeKey(srcId, dstId);
    const sourceHasEdge =
      data?.topoEdges.some((edge) => edgeKey(edge.srcId, edge.dstId) === key) ??
      false;
    const pendingRemoval = mutations.removeEdges.some(
      (edge) => edgeKey(edge.srcId, edge.dstId) === key,
    );
    const pendingAddition = mutations.addEdges.some(
      (edge) => edgeKey(edge.srcId, edge.dstId) === key,
    );

    if ((sourceHasEdge && !pendingRemoval) || pendingAddition) {
      setConnectionNotice({
        kind: "info",
        message: `Nodes ${srcId} and ${dstId} are already connected`,
      });
    } else {
      commitEdit((current) => {
        if (
          current.removeEdges.some(
            (edge) => edgeKey(edge.srcId, edge.dstId) === key,
          )
        ) {
          return {
            ...current,
            removeEdges: current.removeEdges.filter(
              (edge) => edgeKey(edge.srcId, edge.dstId) !== key,
            ),
          };
        }
        return addAddEdge(current, { srcId, dstId });
      });
      setConnectionNotice({
        kind: "success",
        message: `Connected nodes ${srcId} ↔ ${dstId}`,
      });
    }

    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(key);
  }, [commitEdit, data, mutations, selectedNodeIds]);

  // ---- object ↔ node connection ----

  const handleConnectObjectToNode = useCallback(() => {
    const objIds = [...selectedObjectIds];
    const nodeIds = [...selectedNodeIds];
    if (objIds.length !== 1 || nodeIds.length !== 1) return;

    const objectId = objIds[0];
    const fatherPolyId = nodeIds[0];

    // Pending (unexported) objects still carry synthetic negative ids the
    // backend cannot resolve — block those. New nodes carry pre-assigned
    // real ids, so connecting an object to one works before export.
    if (objectId < 0) {
      setConnectionNotice({
        kind: "error",
        message: "新建对象需先导出（获得真实 id）后才能连接",
      });
      return;
    }

    commitEdit((current) =>
      addUpdateObjectFatherPoly(current, objectId, fatherPolyId),
    );
    setConnectionNotice({
      kind: "success",
      message: `Object ${objectId} connected to Poly ${fatherPolyId}`,
    });
    setSelectedObjectIds(new Set());
    setSelectedNodeIds(new Set());
  }, [commitEdit, selectedObjectIds, selectedNodeIds]);

  useEffect(() => {
    if (!connectionNotice) return;
    const timeout = window.setTimeout(() => setConnectionNotice(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [connectionNotice]);

  // Short-lived notice pinned to the right side of the edit toolbar
  // (undo/redo feedback), instead of the floating center banner.
  const [toolbarNotice, setToolbarNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!toolbarNotice) return;
    const timeout = window.setTimeout(() => setToolbarNotice(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [toolbarNotice]);

  const handleUndo = useCallback(() => {
    if (editHistory.past.length === 0) {
      setToolbarNotice("Nothing to undo");
      logEvent("undo ignored (empty past)");
      return;
    }
    logEvent("undo", { depth: editHistory.past.length });
    setEditHistory((history) => undoHistory(history));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setToolbarNotice("Undo applied");
  }, [editHistory.past.length]);

  const handleRedo = useCallback(() => {
    if (editHistory.future.length === 0) {
      setToolbarNotice("Nothing to redo");
      logEvent("redo ignored (empty future)");
      return;
    }
    logEvent("redo", { depth: editHistory.future.length });
    setEditHistory((history) => redoHistory(history));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setToolbarNotice("Redo applied");
  }, [editHistory.future.length]);

  // Latest-handler refs: the deferred undo/redo below (after an input blur)
  // must call the FRESH closure, not the one captured when the keydown
  // listener was registered.
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;

  // ---- keyboard ----

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Undo/redo shortcuts must pass through even when an input is focused,
      // otherwise the browser's native per-input text undo swallows them and
      // the global edit history becomes unreachable. Blurring first commits
      // (or reverts) any pending inline edit; commitEdit/handleUndo both use
      // functional setState so the committed entry is then undone correctly.
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        if (editMode === "edit" && isUndoShortcut(e)) {
          e.preventDefault();
          (e.target as HTMLElement).blur();
          // Defer by one task: blur() above commits the pending inline edit
          // through setEditHistory, and a synchronous handleUndo would still
          // read the PRE-commit history — reporting "Nothing to undo" and
          // requiring a second keypress. React flushes the discrete-event
          // batch before the timeout runs, and the ref resolves to the fresh
          // closure over the updated history.
          if (!e.repeat) {
            window.setTimeout(() => handleUndoRef.current(), 0);
          }
          return;
        }
        if (editMode === "edit" && isRedoShortcut(e)) {
          e.preventDefault();
          (e.target as HTMLElement).blur();
          if (!e.repeat) {
            window.setTimeout(() => handleRedoRef.current(), 0);
          }
          return;
        }
        return;
      }

      // X in association mode: unlink the pending bbox from its object.
      // Intercepted BEFORE Escape — a pending box must be clearable first.
      if (e.key.toLowerCase() === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (assocMode && pendingBboxId) {
          e.preventDefault();
          if (!e.repeat) unlinkBbox(pendingBboxId);
        }
        return;
      }

      if (e.key === "Escape") {
        handleDeselectAll();
        return;
      }

      if (editMode !== "edit") return;

      if (isUndoShortcut(e)) {
        e.preventDefault();
        if (!e.repeat) handleUndo();
        return;
      }

      if (isRedoShortcut(e)) {
        e.preventDefault();
        if (!e.repeat) handleRedo();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeKey) {
          const [a, b] = selectedEdgeKey.split("_").map(Number);
          commitEdit((current) =>
            addRemoveEdge(current, { srcId: a, dstId: b }),
          );
          setSelectedEdgeKey(null);
        } else if (selectedNodeIds.size > 0) {
          commitEdit((current) => {
            let nextMutations = current;
            for (const nid of selectedNodeIds) {
              // Pending (unexported) new nodes carry pre-assigned real ids:
              // delete their createPoly entry instead of a dead
              // deletePolyIds entry.
              nextMutations =
                isPendingCreatePoly(nextMutations, nid)
                  ? removeCreatePoly(nextMutations, nid)
                  : addDeletePoly(nextMutations, nid);
            }
            return nextMutations;
          });
          setSelectedNodeIds(new Set());
        } else if (selectedObjectIds.size > 0) {
          commitEdit((current) => {
            let nextMutations = current;
            for (const oid of selectedObjectIds) {
              // Pending (unexported) objects: drop the createObjects entry.
              nextMutations =
                oid < 0
                  ? removeCreateObject(nextMutations, -oid - 1)
                  : addDeleteObject(nextMutations, oid);
            }
            return nextMutations;
          });
          setSelectedObjectIds(new Set());
        }
        return;
      }

      if (isConnectShortcut(e)) {
        e.preventDefault();
        if (!e.repeat) handleConnectSelected();
        return;
      }

      // C = connect object to selected node
      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        if (selectedObjectIds.size === 1 && selectedNodeIds.size === 1) {
          e.preventDefault();
          if (!e.repeat) handleConnectObjectToNode();
        }
        return;
      }

    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    editMode,
    selectedNodeIds,
    selectedEdgeKey,
    selectedObjectIds,
    assocMode,
    pendingBboxId,
    handleDeselectAll,
    handleConnectSelected,
    handleConnectObjectToNode,
    handleUndo,
    handleRedo,
    commitEdit,
    unlinkBbox,
  ]);

  // ---- edit mode toggle ----

  const handleToggleEdit = useCallback(() => {
    // State updaters must be pure (StrictMode double-invokes them), so the
    // mode-dependent side effects run in the handler body, not inside
    // setEditMode. editModeRef mirrors the current mode for this read.
    if (editModeRef.current === "edit") {
      // Clear selections when leaving edit mode
      setSelectedNodeIds(new Set());
      setSelectedEdgeKey(null);
      setSelectedObjectIds(new Set());
      setPreviewObjectPositions(new Map());
      setPreviewNodePositions(new Map());
      // Also drop any half-open "Add Node / Add Object" flow: its picked
      // position belongs to this editing session and must not resurface
      // (with stale coordinates) the next time edit mode is entered.
      setShowAddPanel(false);
      setShowAddObjectPanel(false);
      setAddMode(null);
      setPickedPosition(null);
      // Bbox association needs the edit-mode picker to complete (object
      // selection is edit-mode only), so drop any half-open association
      // flow instead of leaving boxes pickable in view mode.
      setAssocMode(false);
      setPendingBboxId(null);
      setPickBboxForTarget(false);
      setEditMode("view");
    } else {
      // The 3DGS splat is a background layer; keep the render mode as-is.
      setEditMode("edit");
    }
  }, []);

  // ---- reset ----

  const handleReset = useCallback(async () => {
    setEditHistory(createHistory(emptyMutations()));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setPreviewObjectPositions(new Map());
    setPreviewNodePositions(new Map());
    setBase("saved");
    if (snapshot && scene) {
      // Scene/snapshot-switch competition guard (same pattern as
      // handleExport): if the user switches scene or snapshot while this
      // reload is in flight, a late response must not clobber the
      // newly-selected pair's data or prematurely clear its loading state.
      // Both are compared: two scenes can hold a snapshot of the same name.
      const target = snapshot;
      const targetScene = scene;
      try {
        setLoading(true);
        const { data: freshData } = await loadSceneGraph(
          `/api/scene-graph?scene=${encodeURIComponent(scene)}&snapshot=${encodeURIComponent(target)}&source=saved`,
        );
        if (snapshotRef.current !== target || sceneRef.current !== targetScene) return;
        setData(freshData);
      } catch (e) {
        if (snapshotRef.current === target && sceneRef.current === targetScene) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (snapshotRef.current === target && sceneRef.current === targetScene) {
          setLoading(false);
        }
      }
    }
  }, [snapshot, scene]);

  // ---- snapshot switching ----

  const handleSwitchSnapshot = useCallback((name: string) => {
    // "" is the explicit "None" choice (render no scene graph), so it must not
    // be filtered out as an empty input — Phase 2 simply never loads.
    if (name === snapshot) return;
    setSnapshot(name);
    setData(null);
    setEditHistory(createHistory(emptyMutations()));
    setSelectedNodeIds(new Set());
    setSelectedEdgeKey(null);
    setSelectedObjectIds(new Set());
    setPreviewObjectPositions(new Map());
    setPreviewNodePositions(new Map());
    setBase("saved");
    setError(null);
  }, [snapshot]);

  // ---- export ----

  const handleExport = useCallback(async () => {
    // Read from ref: a blur-committed inline edit may be newer than the
    // `mutations` value captured in this callback's closure.
    const currentMutations = mutationsRef.current;
    if (mutationCount(currentMutations) === 0 || exporting || !snapshot || !scene) {
      logEvent("export skipped", { dirty: mutationCount(currentMutations) > 0, exporting, snapshot: !!snapshot });
      return;
    }
    setExporting(true);
    logEvent("export start", {
      scene,
      snapshot,
      base,
      counts: {
        deletePolyIds: currentMutations.deletePolyIds.length,
        movePoly: currentMutations.movePoly.length,
        removeEdges: currentMutations.removeEdges.length,
        addEdges: currentMutations.addEdges.length,
        createPoly: currentMutations.createPoly.length,
        updateObjectLabels: currentMutations.updateObjectLabels.length,
        updateObjectFatherPolys: currentMutations.updateObjectFatherPolys.length,
        updateObjectPositions: currentMutations.updateObjectPositions.length,
        updateObjectIds: currentMutations.updateObjectIds.length,
        deleteObjectIds: currentMutations.deleteObjectIds.length,
      },
    });
    try {
      const resp = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene, snapshot, mutations: currentMutations, base }),
      });
      const json: ExportResponse = await resp.json();
      if (!json.success) {
        setError(`Export failed: ${json.error}`);
        logEvent("export failed", { error: json.error });
        return;
      }
      logEvent("export ok", { snapshot });
      // The awaits below are interruptible: if the user switched scene or
      // snapshot while the export was in flight, do NOT clobber the
      // newly-selected pair's data with this one's reload. Both are compared
      // because two scenes can hold a snapshot of the same name.
      const targetScene = scene;
      const { data: newData } = await loadSceneGraph(
        `/api/scene-graph?scene=${encodeURIComponent(scene)}&snapshot=${encodeURIComponent(snapshot)}`,
      );
      if (snapshotRef.current !== snapshot || sceneRef.current !== targetScene) return;
      setData(newData);
      // Only reset the edit history when nothing was committed while the
      // export was in flight — otherwise those pending edits would be
      // silently dropped even though they were never exported.
      if (mutationsRef.current === currentMutations) {
        setEditHistory(createHistory(emptyMutations()));
        setSelectedNodeIds(new Set());
        setSelectedEdgeKey(null);
        setSelectedObjectIds(new Set());
      }
      setBase("exported");
      setError(null);
    } catch (e: any) {
      setError(`Export error: ${e.message}`);
      logEvent("export error", { error: e.message });
    } finally {
      setExporting(false);
    }
  }, [exporting, snapshot, scene, base]);

  // ---- layer toggle ----

  const toggle = useCallback((key: LayerKey) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ---- derived effective data for display ----

  const effectiveTNodes = useMemo(
    () => (data ? effectiveNodes(data.topoNodes, mutations) : []),
    [data, mutations],
  );

  // Preview positions only affect what is rendered; they never enter history.
  const previewedTNodes = useMemo(
    () => applyNodePreview(effectiveTNodes, previewNodePositions),
    [effectiveTNodes, previewNodePositions],
  );

  const effectiveTEdges = useMemo(
    () =>
      data
        ? effectiveEdges(data.topoEdges, previewedTNodes, mutations)
        : [],
    [data, mutations, previewedTNodes],
  );

  const effectivePolys = useMemo(
    () => {
      if (!data) return [];
      const deleted = new Set(mutations.deletePolyIds);
      return data.polys.filter((p) => !deleted.has(p.id));
    },
    [data, mutations],
  );

  const effectiveAreas = useMemo(
    () => {
      if (!data) return [];
      const deleted = new Set(mutations.deleteAreaIds);
      const updateMap = new Map(
        mutations.updateAreas.map((u) => [u.id, u]),
      );
      return data.areas
        .filter((a) => !deleted.has(a.id))
        .map((a) => {
          const u = updateMap.get(a.id);
          if (!u) return a;
          return {
            ...a,
            roomLabel: u.roomLabel ?? a.roomLabel,
            colorHex: u.color ? rgb01ToHex(u.color) : a.colorHex,
          };
        });
    },
    [data, mutations],
  );

  const effectiveTObjects = useMemo(() => {
    if (!data) return [];
    const polyAreaMap = new Map(data.polys.map((p) => [p.id, p.areaId]));
    return effectiveObjects(data.objects, mutations, polyAreaMap);
  }, [data, mutations]);

  const previewedTObjects = useMemo(
    () => applyObjectPreview(effectiveTObjects, previewObjectPositions),
    [effectiveTObjects, previewObjectPositions],
  );

  // Count live (uncommitted) previews that actually differ from the committed
  // position. Returning a value back to its committed value removes the diff,
  // so the toolbar's "changed" indicator disappears for a round-trip edit.
  const liveChangedCount = useMemo(() => {
    let count = 0;
    for (const [id, position] of previewObjectPositions) {
      const obj = effectiveTObjects.find((o) => o.id === id);
      if (obj && !samePosition(obj.position, position)) count += 1;
    }
    for (const [id, position] of previewNodePositions) {
      const node = effectiveTNodes.find((n) => n.id === id);
      if (node && !samePosition(node.position, position)) count += 1;
    }
    return count;
  }, [
    previewObjectPositions,
    previewNodePositions,
    effectiveTObjects,
    effectiveTNodes,
  ]);

  const committedMutationCount = mutationCount(mutations);
  // Total unsaved differences shown in the toolbar: committed mutations plus
  // any live position previews that have not been committed yet.
  const changeCount = committedMutationCount + liveChangedCount;

  // Node lookup by id, for showing each object's father-poly node in the list.
  const effectiveNodeMap = useMemo(
    () => new Map(effectiveTNodes.map((n) => [n.id, n])),
    [effectiveTNodes],
  );

  // Edit mode now honors the same user-adjustable layers as view mode.
  const renderedLayers = layers;

  // 3D content → shared persistent canvas (App level). The canvas and its
  // WebGL context survive mode switches, so the splat viewer / point clouds
  // re-attach from cache instantly. Rendered UNCONDITIONALLY of `data`:
  // the point cloud / 3DGS scene comes from useSceneAssets, and a scene
  // without any snapshot yet must still render its cloud — the graph
  // overlays simply derive to empty arrays when data is null.
  useCanvasSlot(
    <Scene
      effectiveNodes={previewedTNodes}
      effectiveEdges={effectiveTEdges}
      effectivePolys={effectivePolys}
      effectiveAreas={effectiveAreas}
      effectiveObjects={previewedTObjects}
      layers={renderedLayers}
      bboxAnnotations={bboxAnnotations}
      assocMode={assocMode}
      pendingBboxId={pendingBboxId}
      onPickBbox={handlePickBbox}
      bboxPickable={assocMode || pickBboxForTarget}
      bboxVisible={showBbox || assocMode || pickBboxForTarget}
      bboxEdgeWidth={bboxEdgeWidth}
      bboxFillOpacity={bboxFillOpacity}
      selectedArea={selectedArea}
      selectedNodeIds={selectedNodeIds}
      selectedEdgeKey={selectedEdgeKey}
      selectedObjectIds={selectedObjectIds}
      editMode={editMode === "edit"}
      onSelectNode={handleSelectNode}
      onSelectEdge={handleSelectEdge}
      onSelectObject={handleSelectObject}
      onDoubleClickNode={handleDoubleClickNode}
      onDoubleClickObject={handleDoubleClickObject}
      onDeselectAll={handleDeselectAll}
      meshOpacity={meshOpacity}
      pcdLayers={pcdLayers}
      pcdPointSize={pcdPointSize}
      pcdColorScheme={pcdColorScheme}
      renderMode={renderMode}
      gridSize={gridSize}
      showAxes={showAxes}
      cloudOpacity={opacity}
      splatSrc={renderMode === "3dgs" ? activeUrl : null}
      splatFormat={(activeFormat as SplatFormat | null) ?? "ply"}
      onSplatLoadingChange={setSplatLoading}
      onSplatError={setSplatError}
      nodeSize={nodeSize}
      topoEdgeThickness={topoEdgeThickness}
      objectSize={objectSize}
      objectLineThickness={objectLineThickness}
      selectableKinds={selectableKinds}
      focusRequest={focusRequest}
      onDragPreview={handleDragPreview}
      onDragCommit={handleDragCommit}
      onPickPosition={
        addMode ? (position) => setPickedPosition(position) : undefined
      }
    />,
  );

  return (
    <div
      className="mode-overlay"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {error && <ErrorBanner msg={error} />}

      {/* Edit toolbar */}
      <EditToolbar
        editMode={editMode}
        changeCount={changeCount}
        dirty={dirty}
        exporting={exporting}
        showDiff={showDiff}
        showShortcuts={showShortcuts}
        hasGraph={!!data}
        notice={toolbarNotice}
        onToggleEdit={handleToggleEdit}
        onReset={handleReset}
        onExport={handleExport}
        onAddNode={() => {
          setShowAddObjectPanel(false);
          setPickedPosition(null);
          setAddMode("node");
          setShowAddPanel(true);
        }}
        onAddObject={() => {
          setShowAddPanel(false);
          setPickedPosition(null);
          setAddMode("object");
          setShowAddObjectPanel(true);
        }}
        onShowDiff={() => setShowDiff(true)}
        onHideDiff={() => setShowDiff(false)}
        onToggleShortcuts={() => setShowShortcuts((v) => !v)}
      />

      {/* Pick filter — edit mode only, centered under the edit toolbar. */}
      {editMode === "edit" && (
        <div data-overlay style={SELECT_FILTER_BAR}>
          <span style={{ color: "#8ab4d8", letterSpacing: 0.5 }}>
            Selection Filter
          </span>
          <SelectToggle
            label="Nodes"
            kind="node"
            selectableKinds={selectableKinds}
            toggle={toggleSelectable}
          />
          <SelectToggle
            label="Edges"
            kind="edge"
            selectableKinds={selectableKinds}
            toggle={toggleSelectable}
          />
          <SelectToggle
            label="Objects"
            kind="object"
            selectableKinds={selectableKinds}
            toggle={toggleSelectable}
          />
        </div>
      )}

      {connectionNotice && (
        <div
          data-overlay
          role="status"
          style={{
            ...FLOATING_OVERLAY,
            // Sits below the Selection Filter bar (top 72, ~30px tall) with the
            // same ~20px breathing room it had before that bar moved down.
            top: 122,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            padding: "8px 14px",
            borderRadius: 6,
            background:
              connectionNotice.kind === "success"
                ? "rgba(20, 110, 65, 0.94)"
                : connectionNotice.kind === "error"
                  ? "rgba(150, 45, 45, 0.94)"
                  : "rgba(105, 85, 20, 0.94)",
            color: "#fff",
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          {connectionNotice.message}
        </div>
      )}

      {/* Unified left-side scene column shared by all three modes: the
          shared scene-selection panel (render mode / file),
          then the layer toggles below it as a standalone panel with the
          column gap in between. */}
      <div data-overlay style={SCENE_COLUMN_STYLE}>
        {/* Shared scene-selection panel (render mode / cloud or splat
            file) — same plain file list as the other two modes. */}
        <SceneAssetPanel
          renderMode={renderMode}
          onRenderModeChange={setRenderMode}
          scenes={scenes}
          selectedScene={scene}
          onSelectScene={selectScene}
          cloudFiles={cloudFiles}
          selectedCloud={selectedCloud}
          onSelectCloud={selectCloud}
          splatFiles={splatFiles}
          selectedSplat={selectedSplat}
          onSelectSplat={selectSplat}
          loading={renderMode === "pointcloud" ? cloudLoading : splatLoading}
          error={renderMode === "pointcloud" ? cloudError : splatError}
          pointSize={pcdPointSize}
          onPointSizeChange={setPcdPointSize}
          gridSize={gridSize}
          onGridSizeChange={setGridSize}
          showAxes={showAxes}
          onShowAxesChange={setShowAxes}
          colorScheme={pcdColorScheme}
          onColorSchemeChange={setPcdColorScheme}
          opacity={opacity}
          onOpacityChange={setOpacity}
        />

        {/* Mode visualization panel — the SceneGraph snapshot/display block and
            the layer toggles merged into a single card, stacked below the
            shared scene panel with the column gap in between. */}
        <div style={MODE_PANEL_STYLE}>
          <div style={MODE_PANEL_TITLE}>SceneGraph</div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
            <span style={{ color: "#8ab4d8", fontSize: 11, whiteSpace: "nowrap" }}>Snapshot:</span>
            {snapshots.length > 0 ? (
            <select
              value={snapshot || ""}
              onChange={(e) => handleSwitchSnapshot(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                background: "#141428",
                color: "#e0e6f0",
                border: "1px solid #3a3a5c",
                borderRadius: 6,
                padding: "4px 6px",
                fontFamily: "monospace",
                fontSize: 12,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {/* None = load no snapshot at all: the scene graph layers stay
                  empty while the point cloud / 3DGS scene keeps rendering. */}
              <option value="">None</option>
              {snapshots.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            ) : (
              <span style={{ color: "#8ab4d8", fontSize: 12 }}>无快照</span>
            )}
          </div>

          {data && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 11,
                color: "#8ab4d8",
                justifyContent: "center",
                marginTop: 8,
              }}
            >
              <span>
                <b style={{ color: "#fff" }}>{data.polys.length}</b> Polygons
              </span>
              <span>
                <b style={{ color: "#fff" }}>{data.topoEdges.length}</b> Edges
              </span>
              <span>
                <b style={{ color: "#fff" }}>{data.areas.length}</b> Areas
              </span>
            </div>
          )}

          {/* Display sliders (moved out of the Layers panel). */}
          <div style={{ margin: "12px 0 8px", borderTop: "1px solid rgba(52,152,219,0.25)" }} />
          <div style={{ fontSize: 11, color: "#8ab4d8", marginBottom: 5, letterSpacing: 0.5 }}>
            Display
          </div>
          <PanelSlider label="Node Size" value={nodeSize} min={0.02} max={0.50} step={0.01} onChange={setNodeSize} />
          <PanelSlider label="Edge Thickness" value={topoEdgeThickness} min={0.5} max={4.0} step={0.5} onChange={setTopoEdgeThickness} />
          <PanelSlider label="Object Size" value={objectSize} min={0.02} max={0.50} step={0.01} onChange={setObjectSize} />
          <PanelSlider label="Object Line" value={objectLineThickness} min={0.01} max={0.20} step={0.01} onChange={setObjectLineThickness} />

          {/* Layers — the toggle groups as a section of this card. The divider
              and the heading belong to the section: with no scene graph loaded
              (None snapshot / failed load) they would label an empty card. */}
          {data && (
            <div style={{ fontSize: 12 }}>
              <div style={{ margin: "12px 0 8px", borderTop: "1px solid rgba(52,152,219,0.25)" }} />
              <div style={{ fontSize: 12, color: "#8ab4d8", marginBottom: 6 }}>
                Layers
              </div>
              <div style={TOGGLE_ROW}>
                <Toggle
                  label="Area Boxes"
                  k="areas"
                  layers={layers}
                  toggle={toggle}
                />
                <Toggle
                  label="Area Edges"
                  k="areaEdges"
                  layers={layers}
                  toggle={toggle}
                />
                <Toggle
                  label="Area Centers"
                  k="areaCenters"
                  layers={layers}
                  toggle={toggle}
                />
              </div>

              <div style={{ margin: "14px 0 8px", borderTop: "1px solid #333" }} />
              <div style={{ fontSize: 12, color: "#8ab4d8", marginBottom: 6 }}>
                Polyhedra
              </div>
              <div style={TOGGLE_ROW}>
                <Toggle
                  label="Poly Wireframe"
                  k="polyWireframe"
                  layers={layers}
                  toggle={toggle}
                />
                <Toggle
                  label="Poly Mesh"
                  k="polyMesh"
                  layers={layers}
                  toggle={toggle}
                />
              </div>
              {layers.polyMesh && (
                <div style={{ paddingLeft: 20, marginBottom: 4 }}>
                  <PanelSlider
                    label="Mesh α"
                    value={meshOpacity}
                    min={0.01}
                    max={1}
                    step={0.01}
                    onChange={setMeshOpacity}
                  />
                </div>
              )}

              <div style={{ margin: "14px 0 8px", borderTop: "1px solid #333" }} />
              <div style={{ fontSize: 12, color: "#8ab4d8", marginBottom: 6 }}>
                Topology Graph
              </div>
              <div style={TOGGLE_ROW}>
                <Toggle
                  label="Topo Nodes"
                  k="topoNodes"
                  layers={layers}
                  toggle={toggle}
                />
                <Toggle
                  label="Topo Edges"
                  k="topoEdges"
                  layers={layers}
                  toggle={toggle}
                />
                <Toggle
                  label="Objects"
                  k="objects"
                  layers={layers}
                  toggle={toggle}
                />
              </div>
            </div>
          )}

          {/* BBox annotation association — mark the owning scene-graph object
              on each saved bbox; the copied BBOX_PRESETS is then keyed by
              object id with the object name as trailing comment. */}
          {bboxAnnotations && bboxAnnotations.length > 0 && (
            <div>
              <div style={{ margin: "14px 0 8px", borderTop: "1px solid #333" }} />
              <div style={{ fontSize: 12, color: "#8ab4d8", marginBottom: 6 }}>
                BBox 标注关联
              </div>
              {/* Overlay visibility switch — independent of edit mode (useful
                  for read-only viewing too). */}
              <button
                type="button"
                onClick={toggleShowBbox}
                style={{
                  width: "100%",
                  background: showBbox
                    ? "rgba(52,152,219,0.25)"
                    : "rgba(52,152,219,0.12)",
                  border: "1px solid rgba(52,152,219,0.5)",
                  borderRadius: 4,
                  color: showBbox ? "#fff" : "#8ab4d8",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "3px 8px",
                  fontFamily: "monospace",
                  marginBottom: 6,
                }}
              >
                {showBbox ? "隐藏 BBox" : "显示 BBox"}
              </button>
              {/* Both pick flows need the edit-mode picker (object selection
                  is edit-mode only), so they live behind edit mode. */}
              {editMode === "edit" && (
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={toggleAssocMode}
                    style={{
                      flex: 1,
                      background: assocMode
                        ? "rgba(52,152,219,0.25)"
                        : "rgba(52,152,219,0.12)",
                      border: "1px solid rgba(52,152,219,0.5)",
                      borderRadius: 4,
                      color: assocMode ? "#fff" : "#8ab4d8",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "3px 8px",
                      fontFamily: "monospace",
                    }}
                  >
                    {assocMode ? "退出关联" : "关联 BBox"}
                  </button>
                  <button
                    type="button"
                    onClick={togglePickBboxForTarget}
                    style={{
                      flex: 1,
                      background: pickBboxForTarget
                        ? "rgba(230,100,30,0.25)"
                        : "rgba(230,100,30,0.12)",
                      border: "1px solid rgba(230,100,30,0.5)",
                      borderRadius: 4,
                      color: pickBboxForTarget ? "#fff" : "#e8a06a",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "3px 8px",
                      fontFamily: "monospace",
                    }}
                  >
                    {pickBboxForTarget ? "取消选框" : "选框建目标"}
                  </button>
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={handleCopyPresets}
                  style={{
                    flex: 1,
                    background: "rgba(60,60,60,0.4)",
                    border: "1px solid #555",
                    borderRadius: 4,
                    color: copiedPresets ? "#7fd47f" : "#ccc",
                    cursor: "pointer",
                    fontSize: 11,
                    padding: "3px 8px",
                    fontFamily: "monospace",
                  }}
                >
                  {copiedPresets ? "已复制" : "复制 BBOX_PRESETS"}
                </button>
              </div>
              {/* Box visual parameters (线条粗细 / 不透明度) are adjusted in the
                  BBox Anno mode; the overlay here only inherits them. */}
              {assocMode && (
                <div
                  style={{
                    fontSize: 10,
                    color: "#9a9aa8",
                    lineHeight: 1.6,
                  }}
                >
                  点击框 → 点击物体 = 关联；选中框后按 X = 解除关联；Esc 取消
                  <br />
                  （关联基于当前快照的 object id；已关联框在 BBox Anno 与复制输出中随之变化）
                </div>
              )}
              {pickBboxForTarget && (
                <div
                  style={{
                    fontSize: 10,
                    color: "#c9a88a",
                    lineHeight: 1.6,
                  }}
                >
                  点击一个 3D BBox → 弹出新建目标点（坐标已预填框中心，可改）；Esc 取消
                  <br />
                  （目标点坐标两种来源：本工具栏手动输入，或取自 BBox 中心点）
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right-side tools column: (in edit mode) the object/node/area
          editing panels. */}
      <div data-overlay style={TOOLS_COLUMN_STYLE}>
        {editMode === "edit" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              width: "100%",
              flexShrink: 0,
            }}
          >
          <ObjectsListPanel
            objects={effectiveTObjects}
            selectedIds={selectedObjectIds}
            onSelect={(id) => {
              if (selectedObjectIds.has(id)) {
                setSelectedObjectIds(new Set());
              } else {
                setSelectedObjectIds(new Set([id]));
              }
              setSelectedNodeIds(new Set());
            }}
            onDoubleClick={(id) => {
              setSelectedObjectIds(new Set([id]));
              setSelectedNodeIds(new Set());
              setSelectedEdgeKey(null);
              setFocusRequest((prev) => ({
                id,
                nonce: (prev?.nonce ?? 0) + 1,
                kind: "object",
              }));
            }}
            onChangeOrder={(order) => {
              commitEdit((current) => addUpdateObjectOrder(current, order));
            }}
          />

          {selectedObjectIds.size === 1 &&
            effectiveTObjects.some((o) => selectedObjectIds.has(o.id)) &&
            (() => {
              const object = effectiveTObjects.find((o) =>
                selectedObjectIds.has(o.id),
              )!;
              const linkedNode =
                object.fatherPolyId >= 0
                  ? effectiveNodeMap.get(object.fatherPolyId)
                  : undefined;
              return (
                <>
                  <ObjectPropertyPanel
                    object={object}
                    existingIds={effectiveTObjects.map((o) => o.id)}
                    onChangeId={(oldId, newId) => {
                      // Pending (unexported) objects have synthetic negative
                      // ids assigned by the backend at export time — renaming
                      // them before export is not meaningful.
                      if (oldId < 0) {
                        setConnectionNotice({
                          kind: "error",
                          message: "新建对象需先导出（获得真实 id）后才能改 id",
                        });
                        return;
                      }
                      commitEdit((current) =>
                        addUpdateObjectId(current, oldId, newId),
                      );
                      setSelectedObjectIds(new Set([newId]));
                    }}
                    onChangeLabel={(id, label) => {
                      commitEdit((current) =>
                        id < 0
                          ? addUpdateCreateObjectLabel(current, -id - 1, label)
                          : addUpdateObjectLabel(current, id, label),
                      );
                    }}
                    onChangePosition={(id, position) => {
                      commitEdit((current) =>
                        id < 0
                          ? addUpdateCreateObjectPosition(current, -id - 1, position)
                          : addUpdateObjectPosition(current, id, position),
                      );
                      clearObjectPositionPreview(id);
                    }}
                    onPreviewPosition={setObjectPositionPreview}
                    onColor={(id, color) => {
                      commitEdit((current) =>
                        id < 0
                          ? addUpdateCreateObjectColor(current, -id - 1, color)
                          : addUpdateObjectColor(current, id, color),
                      );
                    }}
                    onDelete={(id) => {
                      commitEdit((current) =>
                        id < 0
                          ? removeCreateObject(current, -id - 1)
                          : addDeleteObject(current, id),
                      );
                      setSelectedObjectIds(new Set());
                    }}
                  />
                  {linkedNode && (
                    <NodePropertyPanel
                      node={linkedNode}
                      onChangePosition={(id, center) => {
                        commitEdit((current) =>
                          isPendingCreatePoly(current, id)
                            ? addUpdateCreatePolyCenter(current, id, center)
                            : addMovePoly(current, id, center),
                        );
                        clearNodePositionPreview(id);
                      }}
                      onPreviewPosition={setNodePositionPreview}
                      onDelete={(id) => {
                        commitEdit((current) =>
                          isPendingCreatePoly(current, id)
                            ? removeCreatePoly(current, id)
                            : addDeletePoly(current, id),
                        );
                        setSelectedNodeIds(new Set());
                      }}
                    />
                  )}
                </>
              );
            })()}

          {selectedObjectIds.size !== 1 && selectedNodeIds.size === 1 && (
            <NodePropertyPanel
              node={effectiveTNodes.find((n) => selectedNodeIds.has(n.id))!}
              onChangePosition={(id, center) => {
                commitEdit((current) =>
                  isPendingCreatePoly(current, id)
                    ? addUpdateCreatePolyCenter(current, id, center)
                    : addMovePoly(current, id, center),
                );
                clearNodePositionPreview(id);
              }}
              onPreviewPosition={setNodePositionPreview}
              onDelete={(id) => {
                commitEdit((current) =>
                  isPendingCreatePoly(current, id)
                    ? removeCreatePoly(current, id)
                    : addDeletePoly(current, id),
                );
                setSelectedNodeIds(new Set());
              }}
            />
          )}

          {/* Areas live in the same column (below objects) so the edit
              side panel is a single column instead of an awkward two-column
              layout when there are only a handful of areas. */}
          <AreaListPanel
            areas={effectiveAreas}
            selectedArea={selectedArea}
            onSelect={(id) => setSelectedArea(id)}
            onDelete={(id) => {
              commitEdit((current) => addDeleteArea(current, id));
              if (id === selectedArea) setSelectedArea(null);
            }}
            onRename={(id, label) => {
              commitEdit((current) =>
                addUpdateArea(current, { id, roomLabel: label }),
              );
            }}
            onColor={(id, color) => {
              commitEdit((current) => addUpdateArea(current, { id, color }));
            }}
          />
        </div>
        )}
      </div>

      {editMode === "edit" && showAddPanel && (
        <AddNodePanel
          initialPosition={pickedPosition ?? undefined}
          onAdd={(areaId, x, y, z, size) => {
            commitEdit((current) =>
              addCreatePoly(
                current,
                nextPolyId(data?.topoNodes ?? [], current),
                areaId,
                [x, y, z],
                size,
              ),
            );
            setShowAddPanel(false);
            setAddMode(null);
            setPickedPosition(null);
          }}
          onCancel={() => {
            setShowAddPanel(false);
            setAddMode(null);
            setPickedPosition(null);
          }}
        />
      )}

      {editMode === "edit" && showAddObjectPanel && (
        <AddObjectPanel
          initialPosition={pickedPosition ?? undefined}
          onAdd={(label, position, color) => {
            commitEdit((current) =>
              addCreateObject(current, label, position, color),
            );
            setShowAddObjectPanel(false);
            setAddMode(null);
            setPickedPosition(null);
          }}
          onCancel={() => {
            setShowAddObjectPanel(false);
            setAddMode(null);
            setPickedPosition(null);
          }}
        />
      )}

      {editMode === "edit" && selectedNodeIds.size === 2 && (
        <div data-overlay style={HINT_BAR}>
          <span>2 nodes selected</span>
          <button type="button" onClick={handleConnectSelected}>
            Connect (E)
          </button>
        </div>
      )}

      {editMode === "edit" && selectedObjectIds.size === 1 && selectedNodeIds.size === 1 && (
        <div data-overlay style={HINT_BAR}>
          <span>Object + Node selected</span>
          <button type="button" onClick={handleConnectObjectToNode}>
            Connect (C)
          </button>
        </div>
      )}

      {editMode === "edit" && showShortcuts && (
        <div
          data-overlay
          style={{
            ...FLOATING_OVERLAY,
            // Bottom-center; raised above the transient "2 nodes selected"
            // hint bar (bottom 16) so the two never overlap.
            bottom: 56,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            borderRadius: 8,
            padding: "14px 18px",
            fontSize: 14,
            maxWidth: 360,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              color: "#fff",
              fontWeight: 600,
              marginBottom: 8,
              fontSize: 16,
            }}
          >
            Shortcuts
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              lineHeight: 1.3,
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>
              <b style={{ color: "#fff" }}>Del / Backspace</b> — 删除选中项
            </span>
            <span style={{ whiteSpace: "nowrap" }}>
              <b style={{ color: "#fff" }}>E</b> — 连接两个 node 生成 edge
            </span>
            <span style={{ whiteSpace: "nowrap" }}>
              <b style={{ color: "#fff" }}>C</b> — 连接 object 与 node
            </span>
            <span style={{ whiteSpace: "nowrap" }}>
              <b style={{ color: "#fff" }}>Esc</b> — 清空选中
            </span>
          </div>
        </div>
      )}


      {loading && !data && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            color: "#666",
            fontSize: 14,
            fontFamily: "monospace",
          }}
        >
          Loading...
        </div>
      )}

      {/* Centered 3DGS rendering indicator */}
      {renderMode === "3dgs" && splatLoading && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            color: "#666",
            fontFamily: "monospace",
            fontSize: 14,
            pointerEvents: "none",
          }}
        >
          Loading...
        </div>
      )}

      {/* Export diff panel overlay */}
      {showDiff && snapshot && (
        <ExportDiffPanel scene={scene} snapshot={snapshot} onClose={() => setShowDiff(false)} />
      )}
    </div>
  );
}

// ---- Area list (edit mode, left column) ----

function AreaListPanel({
  areas,
  selectedArea,
  onSelect,
  onDelete,
  onRename,
  onColor,
}: {
  areas: PreprocessedArea[];
  selectedArea: number | null;
  onSelect: (id: number | null) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, label: string) => void;
  onColor: (id: number, color: [number, number, number]) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      data-overlay
      style={{
        ...DARK_PANEL,
        borderRadius: 8,
        padding: "12px 16px",
        fontSize: 14,
        minWidth: 260,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          style={{
            background: "transparent",
            border: "none",
            color: "#888",
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: 13,
            padding: 0,
            width: 16,
          }}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>
          Areas ({areas.length})
        </span>
      </div>
      {!collapsed && (
        <>
          {areas.length === 0 && (
            <div style={{ color: "#666", fontSize: 12 }}>No areas</div>
          )}
          {areas.map((a) => (
            <AreaRow
              key={a.id}
              area={a}
              selected={a.id === selectedArea}
              onSelect={() => onSelect(a.id === selectedArea ? null : a.id)}
              onDelete={() => onDelete(a.id)}
              onRename={onRename}
              onColor={onColor}
            />
          ))}
        </>
      )}
    </div>
  );
}

function AreaRow({
  area,
  selected,
  onSelect,
  onDelete,
  onRename,
  onColor,
}: {
  area: PreprocessedArea;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (id: number, label: string) => void;
  onColor: (id: number, color: [number, number, number]) => void;
}) {
  const [nameDraft, setNameDraft] = useState(area.roomLabel);
  const [colorDraft, setColorDraft] = useState(area.colorHex);
  const nameCommittedRef = useRef(false);

  useEffect(() => {
    setNameDraft(area.roomLabel);
  }, [area.roomLabel]);
  useEffect(() => {
    setColorDraft(area.colorHex);
  }, [area.colorHex]);

  const commitName = useCallback(() => {
    const v = nameDraft.trim();
    if (!v) {
      setNameDraft(area.roomLabel);
      return;
    }
    if (v !== area.roomLabel) onRename(area.id, v);
  }, [nameDraft, area.roomLabel, area.id, onRename]);

  const commitColor = useCallback(() => {
    if (colorDraft !== area.colorHex) {
      onColor(area.id, hexToRgb01(colorDraft));
    }
  }, [colorDraft, area.colorHex, area.id, onColor]);

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 6px",
        cursor: "pointer",
        borderRadius: 4,
        background: selected ? "rgba(255,255,255,0.1)" : "transparent",
      }}
    >
      <input
        type="color"
        value={colorDraft}
        onChange={(e) => setColorDraft(e.target.value)}
        onBlur={commitColor}
        onClick={(e) => e.stopPropagation()}
        title={`Change color of Area ${area.id}`}
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          flexShrink: 0,
          padding: 0,
          border: "1px solid rgba(255,255,255,0.15)",
          background: "transparent",
          cursor: "pointer",
        }}
      />
      <input
        type="text"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => {
          if (nameCommittedRef.current) {
            nameCommittedRef.current = false;
            return;
          }
          commitName();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            nameCommittedRef.current = true;
            commitName();
            (e.target as HTMLInputElement).blur();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        title={`Rename Area ${area.id}`}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          color: "#ddd",
          border: "1px solid transparent",
          borderRadius: 4,
          padding: "2px 4px",
          fontFamily: "monospace",
          fontSize: 13,
        }}
      />
      <span style={{ color: "#666", fontSize: 12, flexShrink: 0 }}>
        {area.polyIds.length}p
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          background: "rgba(180,60,60,0.15)",
          border: "1px solid rgba(220,80,80,0.5)",
          borderRadius: 4,
          color: "#e57373",
          cursor: "pointer",
          fontSize: 12,
          padding: "2px 8px",
          fontFamily: "monospace",
          flexShrink: 0,
        }}
        title={`Delete Area ${area.id} metadata only (keeps its Polys and Objects)`}
      >
        Delete
      </button>
    </div>
  );
}

// ---- Toggle & ErrorBanner ----


function SelectToggle({
  label,
  kind,
  selectableKinds,
  toggle,
}: {
  label: string;
  kind: PickKind;
  selectableKinds: Set<PickKind>;
  toggle: (k: PickKind) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={selectableKinds.has(kind)}
        onChange={() => toggle(kind)}
        style={{ accentColor: "#3498db" }}
      />
      <span style={{ color: selectableKinds.has(kind) ? "#ccc" : "#555" }}>
        {label}
      </span>
    </label>
  );
}

function Toggle({
  label,
  k,
  layers,
  toggle,
}: {
  label: string;
  k: LayerKey;
  layers: Layers;
  toggle: (k: LayerKey) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={layers[k]}
        onChange={() => toggle(k)}
        style={{ accentColor: "#3498db" }}
      />
      <span>{label}</span>
    </label>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 48,
        left: 16,
        zIndex: 20,
        background: "rgba(200,0,0,0.85)",
        color: "#fff",
        padding: "8px 16px",
        borderRadius: 6,
        fontSize: 13,
        fontFamily: "monospace",
      }}
    >
      {msg}
    </div>
  );
}
