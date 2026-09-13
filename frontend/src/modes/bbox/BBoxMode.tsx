import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { BBoxItem, DragEntry, Vec3 } from "./lib/bbox";
import {
  colorForIndex,
  moveCornerTo,
  newBBoxId,
  toBBoxOutput,
  toBboxResult,
  vecMin,
  vecMax,
} from "./lib/bbox";
import { PointCloudLayer } from "../../shared/components/PointCloudLayer";
import { GaussianSplatLayer } from "../../shared/components/GaussianSplatLayer";
import type { DropInViewer } from "@mkkellogg/gaussian-splats-3d";
import { BBoxLayer } from "./components/BBoxLayer";
import { BBoxPanel } from "./components/BBoxPanel";
import { CameraControls } from "./components/CameraControls";
import { type SplatFormat } from "../../shared/splat-format";
import {
  MODE_PANEL_STYLE,
  MODE_PANEL_TITLE,
  PanelSlider,
  SCENE_COLUMN_STYLE,
  TOOLS_COLUMN_STYLE,
  SceneAssetPanel,
} from "../../shared/components/SceneAssetPanel";
import { createLocalStorageHook } from "../../shared/use-local-storage";
import { useSceneAssets } from "../../shared/use-scene-assets";
import { useCanvasSlot } from "../../shared/canvas-slot";
import { useSceneCameraPose } from "../../shared/use-scene-camera";
import { useSceneVisuals } from "../../shared/use-scene-visuals";
import { isUndoShortcut } from "../../shared/shortcuts";
import {
  Y_UP,
  rayHitHorizontalPlane,
  verticalDragWorld,
} from "../../shared/lib/projection";

// Cap the parsed cloud to keep rendering responsive (elec.pcd is ~6.5M points).
// Annotation needs finer detail than the background-visualization modes, so
// BBox parses at a lower budget than SceneGraph/Trajectory's 2M default.
const PCD_MAX_POINTS = 180_000;

type RenderMode = "pointcloud" | "3dgs";

/** Rebuild a labelled-box list from the backend payload (new or legacy shape). */
function parseBoxes(data: any): BBoxItem[] {
  if (Array.isArray(data.boxes)) {
    const out: BBoxItem[] = [];
    for (const b of data.boxes) {
      if (Array.isArray(b?.min) && Array.isArray(b?.max) && b.min.length === 3 && b.max.length === 3) {
        out.push({
          id: typeof b.id === "string" ? b.id : newBBoxId(),
          label: typeof b.label === "string" ? b.label : "object",
          min: [b.min[0], b.min[1], b.min[2]] as Vec3,
          max: [b.max[0], b.max[1], b.max[2]] as Vec3,
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

// ---- picker (raw canvas pointer events) ----

function Picker({
  sceneGroupRef,
  controlsRef,
  pointsRef,
  splatViewerRef,
  dragRefs,
  anchorZRef,
  onPlace,
  onDrag,
  onDragStart,
  onSelectBox,
}: {
  sceneGroupRef: RefObject<THREE.Group | null>;
  controlsRef: RefObject<any>;
  pointsRef: RefObject<THREE.Points | null>;
  splatViewerRef: RefObject<DropInViewer | null>;
  dragRefs: React.MutableRefObject<DragEntry[]>;
  anchorZRef: React.MutableRefObject<number>;
  onPlace: (p: Vec3) => void;
  onDrag: (boxId: string, corner: number, position: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const { gl, camera } = useThree();

  const latestRef = useRef({ onPlace, onDrag, onDragStart, onSelectBox });
  latestRef.current = { onPlace, onDrag, onDragStart, onSelectBox };

  const dragRef = useRef<{
    pointerId: number;
    boxId: string;
    corner: number;
    button: number;
    startLocal: Vec3;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = gl.domElement;
    const mouseDown = new THREE.Vector2();
    const mouseUp = new THREE.Vector2();
    const downBoxIdRef = { current: null as string | null };
    // Shared objects reused across pointer moves (hot path).
    const sharedRaycaster = new THREE.Raycaster();
    const sharedNdc = new THREE.Vector2();

    const ndcOf = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      sharedNdc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      return sharedNdc;
    };

    const raycasterFrom = (clientX: number, clientY: number) => {
      sharedRaycaster.setFromCamera(ndcOf(clientX, clientY), camera);
      return sharedRaycaster;
    };

    // Project the pointer ray onto the point-cloud local horizontal plane
    // `z = anchorZLocal`. Under the scene group rotation (Z-up → world Y-up),
    // that local plane maps to the world horizontal plane through the anchor.
    const localFromRayAtZ = (
      clientX: number,
      clientY: number,
      anchorZLocal: number,
    ): Vec3 | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const worldStart = new THREE.Vector3(0, 0, anchorZLocal).applyMatrix4(
        sceneGroup.matrixWorld,
      );

      const raycaster = raycasterFrom(clientX, clientY);
      const worldHit = rayHitHorizontalPlane(raycaster.ray, Y_UP, worldStart);
      if (!worldHit) return null;

      const local = sceneGroup.worldToLocal(worldHit.clone());
      return [local.x, local.y, local.z];
    };

    // Project the pointer ray onto the horizontal ground plane at the dragged
    // point's current height, then map back to scene-local coordinates. This
    // mirrors scenegraph_editor's node/object drag exactly: the height stays
    // fixed while the point follows the cursor 1:1 across the floor, avoiding
    // the depth amplification of a camera-facing plane.
    const groundLocalAt = (
      clientX: number,
      clientY: number,
      startLocal: Vec3,
    ): Vec3 | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const worldStart = new THREE.Vector3(
        startLocal[0],
        startLocal[1],
        startLocal[2],
      ).applyMatrix4(sceneGroup.matrixWorld);

      const raycaster = raycasterFrom(clientX, clientY);
      const worldCurrent = rayHitHorizontalPlane(raycaster.ray, Y_UP, worldStart);
      if (!worldCurrent) return null;

      const localCurrent = sceneGroup.worldToLocal(worldCurrent.clone());
      return [localCurrent.x, localCurrent.y, localCurrent.z];
    };

    // Vertical (right-button) drag: keep the corner's scene-local X/Y fixed and
    // move only its height (local Z). The shared world-space helper intersects
    // a camera-facing vertical plane through the anchor (with a near-top-down
    // fallback); we map the resulting world position back to scene-local.
    const verticalLocalAt = (
      clientX: number,
      clientY: number,
      startLocal: Vec3,
    ): Vec3 | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const worldStart = new THREE.Vector3(
        startLocal[0],
        startLocal[1],
        startLocal[2],
      ).applyMatrix4(sceneGroup.matrixWorld);

      const raycaster = raycasterFrom(clientX, clientY);
      const newWorld = verticalDragWorld(
        camera as THREE.PerspectiveCamera,
        raycaster.ray,
        clientX,
        clientY,
        canvas.getBoundingClientRect(),
        worldStart,
        Y_UP,
      );
      if (!newWorld) return null;
      const local = sceneGroup.worldToLocal(newWorld);
      return [local.x, local.y, local.z];
    };

    // Pick an exact point on the splat surface using the library's own
    // raycaster (world-space hit → scene-local via the rotated group).
    const splatPointAt = (clientX: number, clientY: number): Vec3 | null => {
      const dropIn = splatViewerRef.current;
      const viewer = dropIn?.viewer;
      if (!viewer || !viewer.raycaster || !viewer.splatMesh) return null;
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;

      camera.updateMatrixWorld();
      const rect = canvas.getBoundingClientRect();
      viewer.raycaster.setFromCameraAndScreenPosition(
        camera,
        { x: clientX - rect.left, y: clientY - rect.top },
        new THREE.Vector2(rect.width, rect.height),
      );
      const hits: Array<{ origin: THREE.Vector3 }> = [];
      viewer.raycaster.intersectSplatMesh(viewer.splatMesh, hits);
      if (hits.length === 0) return null;

      sceneGroup.updateWorldMatrix(true, false);
      const local = sceneGroup.worldToLocal(hits[0]!.origin.clone());
      return [local.x, local.y, local.z];
    };

    // Primary pick: raycast against the point cloud (if present), then the
    // splat surface (3DGS mode), falling back to the local horizontal plane
    // when the ray misses both.
    const pickPoint = (clientX: number, clientY: number, anchorZLocal: number): Vec3 | null => {
      const raycaster = raycasterFrom(clientX, clientY);
      raycaster.params.Points.threshold = 0.4;

      const pts = pointsRef.current;
      if (pts) {
        const hits = raycaster.intersectObject(pts, false);
        if (hits.length > 0) {
          const sceneGroup = sceneGroupRef.current;
          if (sceneGroup) {
            sceneGroup.updateWorldMatrix(true, false);
            const local = sceneGroup.worldToLocal(hits[0]!.point.clone());
            return [local.x, local.y, local.z];
          }
          return [hits[0]!.point.x, hits[0]!.point.y, hits[0]!.point.z];
        }
      }

      const splat = splatPointAt(clientX, clientY);
      if (splat) return splat;

      return localFromRayAtZ(clientX, clientY, anchorZLocal);
    };

    // Pick a draggable corner sphere (the only grab targets).
    const dragAt = (raycaster: THREE.Raycaster): DragEntry | null => {
      const entries = dragRefs.current;
      if (entries.length === 0) return null;
      const byMesh = new Map<THREE.Object3D, DragEntry>();
      for (const e of entries) byMesh.set(e.mesh, e);

      const hits = raycaster.intersectObjects(
        entries.map((e) => e.mesh),
        false,
      );
      for (const h of hits) {
        const entry = byMesh.get(h.object);
        if (entry) return entry;
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      mouseDown.set(e.clientX, e.clientY);
      downBoxIdRef.current = null;

      // Only left (horizontal) and right (vertical) buttons drag a corner.
      if (e.button !== 0 && e.button !== 2) return;

      const sceneGroup = sceneGroupRef.current;
      const raycaster = raycasterFrom(e.clientX, e.clientY);
      const entry = dragAt(raycaster);

      if (!entry) return;

      // Anchor the drag at the grabbed element's local position. Horizontal
      // drags follow the ground plane, vertical drags follow the up axis.
      let startLocal: Vec3 = [0, 0, 0];
      if (sceneGroup) {
        sceneGroup.updateWorldMatrix(true, false);
        const worldPos = entry.mesh.getWorldPosition(new THREE.Vector3());
        const local = sceneGroup.worldToLocal(worldPos);
        startLocal = [local.x, local.y, local.z];
      }

      dragRef.current = {
        pointerId: e.pointerId,
        boxId: entry.boxId,
        corner: entry.corner,
        button: e.button,
        startLocal,
        moved: false,
      };
      downBoxIdRef.current = entry.boxId;

      latestRef.current.onDragStart(entry.boxId);

      if (controlsRef.current) controlsRef.current.enabled = false;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const local =
        drag.button === 2
          ? verticalLocalAt(e.clientX, e.clientY, drag.startLocal)
          : groundLocalAt(e.clientX, e.clientY, drag.startLocal);
      if (local) {
        drag.moved = true;
        latestRef.current.onDrag(drag.boxId, drag.corner, local);
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
    };

    // Suppress the browser context menu during a right-button corner drag.
    const onContextMenu = (e: MouseEvent) => {
      if (dragRef.current && dragRef.current.button === 2) e.preventDefault();
    };

    const onClick = (e: MouseEvent) => {
      mouseUp.set(e.clientX, e.clientY);
      if (mouseDown.distanceTo(mouseUp) > 3) return; // drag, not click
      if (downBoxIdRef.current) {
        latestRef.current.onSelectBox(downBoxIdRef.current);
        return;
      }

      const el = e.target as HTMLElement;
      if (el.closest("[data-overlay]")) return;

      const anchorZ = anchorZRef.current;
      const p = pickPoint(e.clientX, e.clientY, anchorZ);
      if (p) latestRef.current.onPlace(p);
    };

    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", finishDrag, { capture: true });
    canvas.addEventListener("pointercancel", finishDrag, { capture: true });
    canvas.addEventListener("click", onClick, { capture: true });
    canvas.addEventListener("contextmenu", onContextMenu, { capture: true });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      canvas.removeEventListener("pointermove", onPointerMove, { capture: true });
      canvas.removeEventListener("pointerup", finishDrag, { capture: true });
      canvas.removeEventListener("pointercancel", finishDrag, { capture: true });
      canvas.removeEventListener("click", onClick, { capture: true });
      canvas.removeEventListener("contextmenu", onContextMenu, { capture: true });
      if (dragRef.current && controlsRef.current) controlsRef.current.enabled = true;
      dragRef.current = null;
    };
  }, [gl, camera, sceneGroupRef, controlsRef, pointsRef, splatViewerRef, dragRefs, anchorZRef]);

  return null;
}

// ---- scene ----

function Scene({
  positions,
  pointSize,
  handleRadius,
  lineWidth,
  opacity,
  boxes,
  activeId,
  placing,
  draftMin,
  anchorZRef,
  renderMode,
  splatSrc,
  splatFormat,
  onSplatLoadingChange,
  onSplatError,
  onPlace,
  onDrag,
  onDragStart,
  onSelectBox,
}: {
  positions: Float32Array | null;
  pointSize: number;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  boxes: BBoxItem[];
  activeId: string | null;
  placing: boolean;
  draftMin: Vec3 | null;
  anchorZRef: React.MutableRefObject<number>;
  renderMode: RenderMode;
  splatSrc: string | null;
  splatFormat: SplatFormat;
  onSplatLoadingChange: (loading: boolean) => void;
  onSplatError: (message: string | null) => void;
  onPlace: (p: Vec3) => void;
  onDrag: (boxId: string, corner: number, position: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const sceneGroupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<any>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const splatViewerRef = useRef<DropInViewer | null>(null);
  const dragRefs = useRef<DragEntry[]>([]);
  // ONE camera pose across all three modes: restore on mount, track live.
  useSceneCameraPose();

  // While placing a new box, right-drag on empty space must not pan the camera
  // (right button is reserved for vertical corner drags).
  useEffect(() => {
    const c = controlsRef.current;
    if (c) c.mouseButtons = { ...c.mouseButtons, RIGHT: placing ? null : THREE.MOUSE.PAN };
  }, [placing]);

  const draftColor = colorForIndex(boxes.length);

  // Rendered into the shared persistent canvas (App level) via useCanvasSlot
  // — the canvas (and its WebGL context / GPU resources) survives mode
  // switches, so the splat viewer and point clouds re-attach instantly.
  return (
    <>
      <PerspectiveCamera makeDefault position={[12, 25, 20]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 15, 5]} intensity={1.2} />

      <group ref={sceneGroupRef} rotation={[-Math.PI / 2, 0, 0]}>
        {renderMode === "pointcloud" && (
          <PointCloudLayer
            ref={pointsRef}
            positions={positions}
            colorHex="#aaccff"
            pointSize={pointSize}
            opacity={0.85}
          />
        )}

        {renderMode === "3dgs" && splatSrc && (
          <GaussianSplatLayer
            src={splatSrc}
            format={splatFormat}
            onViewer={(v) => {
              splatViewerRef.current = v;
            }}
            onLoadingChange={onSplatLoadingChange}
            onError={onSplatError}
          />
        )}

        {boxes.map((box, i) => (
          <BBoxLayer
            key={box.id}
            boxId={box.id}
            min={box.min}
            max={box.max}
            handleRadius={handleRadius}
            lineWidth={lineWidth}
            opacity={opacity}
            color={colorForIndex(i)}
            active={box.id === activeId}
            dragRefs={dragRefs}
          />
        ))}

        {placing && draftMin && (
          <mesh position={draftMin}>
            <sphereGeometry args={[handleRadius, 20, 20]} />
            <meshBasicMaterial color={draftColor} />
          </mesh>
        )}
      </group>

      <gridHelper args={[160, 80, "#333", "#222"]} />
      <CameraControls ref={controlsRef} />
      <Picker
        sceneGroupRef={sceneGroupRef}
        controlsRef={controlsRef}
        pointsRef={pointsRef}
        splatViewerRef={splatViewerRef}
        dragRefs={dragRefs}
        anchorZRef={anchorZRef}
        onPlace={onPlace}
        onDrag={onDrag}
        onDragStart={onDragStart}
        onSelectBox={onSelectBox}
      />
    </>
  );
}

// ---- app ----

// Persist non-bbox display parameters across sessions (shared hook; the
// "3dbbox_" key prefix must stay byte-identical or saved settings reset).
const useLocalStorageState = createLocalStorageHook("3dbbox_");

export function BBoxMode() {
  // Scene point size: the ONE shared setting across all three modes.
  const { pointSize, setPointSize } = useSceneVisuals();
  const [handleRadius, setHandleRadius] = useLocalStorageState<number>("handleRadius", 0.12);
  const [lineWidth, setLineWidth] = useLocalStorageState<number>("lineWidth", 0.04);
  const [opacity, setOpacity] = useLocalStorageState<number>("opacity", 0.08);

  // ---- annotation state ----
  // Per-asset edit state, declared before the scene hook: the hook's
  // onAssetLeave option (see the useSceneAssets call below) flushes and
  // resets this state on every user-initiated switch that abandons the
  // active asset.
  const [boxes, setBoxes] = useState<BBoxItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [draftMin, setDraftMin] = useState<Vec3 | null>(null);

  const historyRef = useRef<BBoxItem[][]>([]);
  const dirtyRef = useRef(false);

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copied, setCopied] = useState(false);

  // Refs mirroring the latest state so event callbacks never see stale values.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const draftMinRef = useRef(draftMin);
  draftMinRef.current = draftMin;

  const anchorZRef = useRef(0);
  anchorZRef.current = draftMin ? draftMin[2] : 0;

  // The asset currently being annotated (cloud file in point-cloud mode,
  // splat file in 3DGS mode) + the scene, mirrored into refs so the
  // save/flush paths never see stale values. Declared here (the save
  // queue reads them at flush time), assigned from the scene hook below.
  const activeNameRef = useRef("");
  const sceneRef = useRef("");

  const persistBoxes = useCallback(
    async (scene: string, name: string, list: BBoxItem[]) => {
      const resp = await fetch("/api/bbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene, name, boxes: list.map(toBBoxOutput) }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    },
    [],
  );

  // Serialized save queue: concurrent POSTs could land out of order and roll
  // the file back to an older snapshot, so every save chains onto the last.
  // The chain itself swallows rejections (a rejected link would block all
  // later saves), but the outcome is returned to the caller so handleSave
  // can report failures instead of showing "saved" after an error.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSave = useCallback(
    (name: string, list: BBoxItem[]) => {
      // Capture the scene at enqueue time: the chained POST runs async and
      // must persist into the scene the edits were made in, even if the
      // user has already switched to another one.
      const scene = sceneRef.current;
      const p = saveChainRef.current.then(() => persistBoxes(scene, name, list));
      saveChainRef.current = p.catch(() => {
        // Surface auto-save failures instead of swallowing them.
        setSaveState("error");
        window.setTimeout(() => setSaveState("idle"), 2000);
      });
      return p;
    },
    [persistBoxes],
  );

  // Scene-rendering state — the ONE shared implementation (scene bucket,
  // asset listing, selections, render mode, point-cloud loading) used by
  // all three modes, wired identically to SceneGraph/Trajectory: the
  // panel handlers come straight from the hook, with no local wrappers.
  // BBox's only per-mode addition is onAssetLeave, fired by the hook on
  // every user switch that abandons the active asset (scene / cloud /
  // splat / render-mode): flush pending edits of the OLD asset (an empty
  // list included — the user may have deleted every box), then reset the
  // annotation state; the auto-load effect below repopulates from the
  // new asset.
  const {
    scenes,
    scene,
    selectScene,
    cloudFiles,
    splatFiles,
    renderMode,
    setRenderMode,
    selectedCloud,
    selectCloud,
    selectedSplat,
    selectSplat,
    activeName,
    activeFormat,
    activeUrl,
    positions,
    cloudLoading,
    cloudError,
  } = useSceneAssets(PCD_MAX_POINTS, {
    onAssetLeave: () => {
      if (dirtyRef.current) {
        enqueueSave(activeNameRef.current, boxesRef.current).catch(() => {});
      }
      setBoxes([]);
      setActiveId(null);
      setPlacing(false);
      setDraftMin(null);
      historyRef.current = [];
      dirtyRef.current = false;
    },
  });
  activeNameRef.current = activeName;
  sceneRef.current = scene;

  const [splatLoading, setSplatLoading] = useState(false);
  const [splatError, setSplatError] = useState<string | null>(null);

  const HISTORY_LIMIT = 100;

  const pushHistory = useCallback(() => {
    const snap = boxesRef.current.map((b) => ({
      ...b,
      min: [...b.min] as Vec3,
      max: [...b.max] as Vec3,
    }));
    // Cap history so long sessions don't accumulate unbounded snapshots.
    historyRef.current = [...historyRef.current, snap].slice(-HISTORY_LIMIT);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const last = h[h.length - 1]!;
    setBoxes(last);
    historyRef.current = h.slice(0, -1);
    setActiveId((id) => (id && last.some((b) => b.id === id) ? id : (last[0]?.id ?? null)));
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isUndoShortcut(e)) {
        const el = e.target as HTMLElement | null;
        if (
          el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.tagName === "SELECT" ||
            el.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  // Auto-load saved boxes for the currently active asset (if one exists).
  // Keyed on [activeName, scene]: two scenes may hold an asset with the
  // same file name, so the scene alone must re-trigger the load too.
  useEffect(() => {
    if (!scene) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/bbox?scene=${encodeURIComponent(scene)}&name=${encodeURIComponent(activeName)}`,
        );
        if (resp.status === 404) return;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        // The user already started editing (slow fetch): never clobber it.
        if (dirtyRef.current) return;
        const loaded = parseBoxes(data);
        setBoxes(loaded);
        setActiveId(loaded[0]?.id ?? null);
        setDraftMin(null);
        historyRef.current = [];
        dirtyRef.current = false;
      } catch {
        // No saved boxes (or load failed): start empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeName, scene]);

  const activeBox = useMemo(
    () => boxes.find((b) => b.id === activeId) ?? null,
    [boxes, activeId],
  );

  const result = useMemo(
    () => (activeBox ? toBboxResult(activeBox.min, activeBox.max) : null),
    [activeBox],
  );

  const center = useMemo<Vec3 | null>(
    () => (result ? [result.center_x, result.center_y, result.center_z] : null),
    [result],
  );

  const size = useMemo<Vec3 | null>(
    () => (result ? [result.size_x, result.size_y, result.size_z] : null),
    [result],
  );

  const json = useMemo(
    () => (boxes.length > 0 ? JSON.stringify({ boxes: boxes.map(toBBoxOutput) }) : null),
    [boxes],
  );

  // Console output matching the old script's ~1/3 Hz throttle (dev only —
  // printing the full JSON every 3s would flood a production console).
  useEffect(() => {
    if (!import.meta.env.DEV || boxes.length === 0) return;
    console.log(json);
    const id = window.setInterval(() => {
      console.log(json);
    }, 3000);
    return () => window.clearInterval(id);
  }, [json, boxes.length]);

  const handlePlace = useCallback(
    (p: Vec3) => {
      if (!placingRef.current) return;
      const draft = draftMinRef.current;
      if (!draft) {
        setDraftMin(p);
      } else {
        pushHistory();
        dirtyRef.current = true;
        const id = newBBoxId();
        // Number past the highest existing object_N label so undo/delete
        // followed by a new box doesn't produce duplicate labels.
        const nextNum = boxesRef.current.reduce((m, b) => {
          const mm = /^object_(\d+)$/.exec(b.label);
          return mm ? Math.max(m, Number(mm[1])) : m;
        }, 0) + 1;
        const label = `object_${nextNum}`;
        const box: BBoxItem = { id, label, min: vecMin(draft, p), max: vecMax(draft, p) };
        setBoxes((prev) => [...prev, box]);
        setActiveId(id);
        setDraftMin(null);
        setPlacing(false);
      }
    },
    [pushHistory],
  );

  const handleDrag = useCallback((boxId: string, corner: number, position: Vec3) => {
    setBoxes((prev) =>
      prev.map((b) => (b.id === boxId ? moveCornerTo(b, corner, position) : b)),
    );
  }, []);

  const handleDragStart = useCallback(
    (boxId: string) => {
      pushHistory();
      dirtyRef.current = true;
      setActiveId(boxId);
    },
    [pushHistory],
  );

  const handleSelectBox = useCallback((id: string) => setActiveId(id), []);

  const handleNewBox = useCallback(() => {
    setPlacing(true);
    setDraftMin(null);
  }, []);

  // Panel-edit interactions (stepper clicks, keystroke bursts) each fire a
  // begin event; coalesce history snapshots taken within a short window so
  // undo rolls back the whole burst instead of every 0.01 step.
  const lastPanelEditRef = useRef(0);
  const beginPanelEdit = useCallback(() => {
    const now = Date.now();
    if (now - lastPanelEditRef.current > 1000) {
      pushHistory();
      lastPanelEditRef.current = now;
    }
    dirtyRef.current = true;
  }, [pushHistory]);

  const handleRename = useCallback(
    (id: string, label: string) => {
      beginPanelEdit();
      setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, label } : b)));
    },
    [beginPanelEdit],
  );

  const handleDelete = useCallback(
    (id: string) => {
      pushHistory();
      dirtyRef.current = true;
      setBoxes((prev) => prev.filter((b) => b.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [pushHistory],
  );

  const handleReset = useCallback(() => {
    if (boxesRef.current.length === 0 && !draftMinRef.current) return;
    pushHistory();
    dirtyRef.current = true;
    setBoxes([]);
    setActiveId(null);
    setPlacing(false);
    setDraftMin(null);
  }, [pushHistory]);

  const handleSetMin = useCallback((v: Vec3) => {
    const id = activeIdRef.current;
    if (!id) return;
    setBoxes((prev) =>
      prev.map((b) =>
        b.id === id
          ? // Keep the min<=max invariant: values beyond the opposite corner
            // extend/flip the box instead of producing a negative-size AABB.
            { ...b, min: vecMin(v, b.max), max: vecMax(v, b.max) }
          : b,
      ),
    );
  }, []);

  const handleSetMax = useCallback((v: Vec3) => {
    const id = activeIdRef.current;
    if (!id) return;
    setBoxes((prev) =>
      prev.map((b) =>
        b.id === id
          ? { ...b, min: vecMin(v, b.min), max: vecMax(v, b.min) }
          : b,
      ),
    );
  }, []);

  const handleCopy = useCallback(async () => {
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [json]);

  const handleSave = useCallback(async () => {
    // An empty list is a valid save: it clears previously saved boxes for
    // this asset (the backend writes `{ name, boxes: [] }`).
    setSaveState("saving");
    try {
      await enqueueSave(activeNameRef.current, boxesRef.current);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [enqueueSave]);

  // Debounced auto-save: persist after the user finishes editing.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const id = window.setTimeout(() => {
      enqueueSave(activeNameRef.current, boxesRef.current).catch(() => {});
    }, 600);
    return () => window.clearTimeout(id);
  }, [boxes, enqueueSave]);

  // Declared AFTER the debounce effect so its cleanup runs later on unmount:
  // the debounce timer is cleared first, then this flush persists whatever
  // was still inside the 600ms window (an empty list included), so switching
  // to SceneGraph mode never drops the last edit.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        enqueueSave(activeNameRef.current, boxesRef.current).catch(() => {});
      }
    };
  }, [enqueueSave]);

  // 3D content → shared persistent canvas (App level). The canvas and its
  // WebGL context survive mode switches, so the splat viewer / point clouds
  // re-attach from cache instantly.
  useCanvasSlot(
    <Scene
      positions={positions}
      pointSize={pointSize}
      handleRadius={handleRadius}
      lineWidth={lineWidth}
      opacity={opacity}
      boxes={boxes}
      activeId={activeId}
      placing={placing}
      draftMin={draftMin}
      anchorZRef={anchorZRef}
      renderMode={renderMode}
      splatSrc={renderMode === "3dgs" ? activeUrl : null}
      splatFormat={(activeFormat ?? "ply") as SplatFormat}
      onSplatLoadingChange={setSplatLoading}
      onSplatError={setSplatError}
      onPlace={handlePlace}
      onDrag={handleDrag}
      onDragStart={handleDragStart}
      onSelectBox={handleSelectBox}
    />,
  );

  return (
    <div
      className="mode-overlay"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {/* Unified left-side scene panel shared by all three modes: render
          mode and the cloud/splat file list, with this mode's
          visualization parameters in a standalone panel below it. */}
      <div style={SCENE_COLUMN_STYLE}>
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
        />

        {/* Mode visualization panel — standalone list below the scene
            panel (column gap in between): the annotation display
            parameters. */}
        <div style={MODE_PANEL_STYLE}>
          <div style={MODE_PANEL_TITLE}>
            <span style={{ color: "#3498db" }}>◈</span> BBox
          </div>
          {renderMode === "pointcloud" && (
            <PanelSlider
              label="点云大小"
              value={pointSize}
              min={0.01}
              max={0.3}
              step={0.01}
              onChange={setPointSize}
            />
          )}
          <PanelSlider
            label="角点大小"
            value={handleRadius}
            min={0.02}
            max={0.6}
            step={0.01}
            onChange={setHandleRadius}
          />
          <PanelSlider
            label="线条粗细"
            value={lineWidth}
            min={0.01}
            max={0.2}
            step={0.01}
            onChange={setLineWidth}
          />
          <PanelSlider
            label="不透明度"
            value={opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={setOpacity}
          />
        </div>
      </div>

      {/* Mode tools on the right: the bounding-box list and editors. */}
      <div style={TOOLS_COLUMN_STYLE}>
        <BBoxPanel
          boxes={boxes}
          activeId={activeId}
          placing={placing}
          cornerMin={activeBox?.min ?? null}
          cornerMax={activeBox?.max ?? null}
          center={center}
          size={size}
          saveState={saveState}
          copied={copied}
          onSetMin={handleSetMin}
          onSetMax={handleSetMax}
          onBeginEdit={beginPanelEdit}
          onReset={handleReset}
          onSave={handleSave}
          onCopy={handleCopy}
          onNewBox={handleNewBox}
          onSelectBox={handleSelectBox}
          onRename={handleRename}
          onDeleteBox={handleDelete}
        />
      </div>

      {renderMode === "pointcloud" && cloudLoading && (
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
          Loading point cloud…
        </div>
      )}

      {renderMode === "pointcloud" && cloudError && (
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
          {cloudError}
        </div>
      )}

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
          Loading 3DGS…
        </div>
      )}

      {renderMode === "3dgs" && splatError && (
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
          {splatError}
        </div>
      )}
    </div>
  );
}
