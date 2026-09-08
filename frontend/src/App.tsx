import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
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
import { loadPcd, loadPly } from "./lib/pcd-loader";
import { PointCloudView } from "./components/PointCloudView";
import { BBoxLayer } from "./components/BBoxLayer";
import { BBoxPanel } from "./components/BBoxPanel";
import { CameraControls } from "./components/CameraControls";
import { GaussianSplatViewer } from "./components/GaussianSplatViewer";

// Cap the parsed cloud to keep rendering responsive (elec.pcd is ~6.5M points).
const PCD_MAX_POINTS = 180_000;

type RenderMode = "pointcloud" | "3dgs";
type AssetFormat = "pcd" | "ply" | "splat" | "ksplat" | "spz";

function detectFormat(name: string): AssetFormat | null {
  const m = /\.(pcd|ply|splat|ksplat|spz)$/i.exec(name);
  return m ? (m[1].toLowerCase() as AssetFormat) : null;
}

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
    // that local plane maps to the world horizontal plane `y = anchorZLocal`.
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
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldStart.y);

      const raycaster = raycasterFrom(clientX, clientY);
      const worldHit = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldHit);
      if (!hit) return null;

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
      const plane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -worldStart.y,
      );

      const raycaster = raycasterFrom(clientX, clientY);
      const worldCurrent = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldCurrent);
      if (!hit) return null;

      const localCurrent = sceneGroup.worldToLocal(worldCurrent.clone());
      return [localCurrent.x, localCurrent.y, localCurrent.z];
    };

    // Vertical (right-button) drag: keep the corner's scene-local X/Y fixed and
    // move only its height (local Z). We work in world space where up is +Y,
    // intersect a camera-facing vertical plane through the anchor, then map the
    // changed world-Y back to scene-local coordinates.
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

      const cameraDir = camera.getWorldDirection(new THREE.Vector3());
      const horiz = new THREE.Vector3(cameraDir.x, 0, cameraDir.z);

      // Near-top-down camera: a vertical plane becomes degenerate, so map the
      // screen-space Y delta straight onto the world up axis instead.
      if (horiz.lengthSq() < 0.04) {
        const cam = camera as THREE.PerspectiveCamera;
        const rect = canvas.getBoundingClientRect();
        const dist = cam.position.distanceTo(worldStart);
        const worldPerPixel =
          (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / rect.height;
        const proj = worldStart.clone().project(cam);
        const anchorClientY = rect.top + (1 - (proj.y + 1) / 2) * rect.height;
        const dy = clientY - anchorClientY;
        const newWorld = new THREE.Vector3(
          worldStart.x,
          worldStart.y - dy * worldPerPixel,
          worldStart.z,
        );
        const local = sceneGroup.worldToLocal(newWorld);
        return [local.x, local.y, local.z];
      }

      horiz.normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3().crossVectors(up, horiz).normalize();
      const plane = new THREE.Plane(normal, -normal.dot(worldStart));

      const raycaster = raycasterFrom(clientX, clientY);
      const worldHit = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldHit);
      if (!hit) return null;

      const newWorld = new THREE.Vector3(worldStart.x, worldHit.y, worldStart.z);
      const local = sceneGroup.worldToLocal(newWorld);
      return [local.x, local.y, local.z];
    };

    // Primary pick: raycast against the point cloud; fall back to the local
    // horizontal plane when the ray misses the cloud.
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
  }, [gl, camera, sceneGroupRef, controlsRef, pointsRef, dragRefs, anchorZRef]);

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
  onPlace: (p: Vec3) => void;
  onDrag: (boxId: string, corner: number, position: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const sceneGroupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<any>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const dragRefs = useRef<DragEntry[]>([]);

  // While placing a new box, right-drag on empty space must not pan the camera
  // (right button is reserved for vertical corner drags).
  useEffect(() => {
    const c = controlsRef.current;
    if (c) c.mouseButtons = { ...c.mouseButtons, RIGHT: placing ? null : THREE.MOUSE.PAN };
  }, [placing]);

  const draftColor = colorForIndex(boxes.length);

  return (
    <Canvas style={{ width: "100%", height: "100%" }}>
      <PerspectiveCamera makeDefault position={[12, 25, 20]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 15, 5]} intensity={1.2} />

      <group ref={sceneGroupRef} rotation={[-Math.PI / 2, 0, 0]}>
        <PointCloudView ref={pointsRef} positions={positions} pointSize={pointSize} />

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
        dragRefs={dragRefs}
        anchorZRef={anchorZRef}
        onPlace={onPlace}
        onDrag={onDrag}
        onDragStart={onDragStart}
        onSelectBox={onSelectBox}
      />
    </Canvas>
  );
}

// ---- app ----

// Persist non-bbox display parameters across sessions (mirrors
// scenegraph_editor's useLocalStorageState, with a 3D-BBox-Tool key prefix).
function useLocalStorageState<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`3dbbox_${key}`);
      if (stored !== null) return JSON.parse(stored) as T;
    } catch {}
    return fallback;
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`3dbbox_${key}`, JSON.stringify(v));
      } catch {}
    },
    [key],
  );
  return [value, set];
}

export function App() {
  const [positions, setPositions] = useState<Float32Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pointSize, setPointSize] = useLocalStorageState<number>("pointSize", 0.06);
  const [handleRadius, setHandleRadius] = useLocalStorageState<number>("handleRadius", 0.12);
  const [lineWidth, setLineWidth] = useLocalStorageState<number>("lineWidth", 0.04);
  const [opacity, setOpacity] = useLocalStorageState<number>("opacity", 0.08);

  const [cloudFiles, setCloudFiles] = useState<string[]>([]);
  const [selectedCloud, setSelectedCloud] = useLocalStorageState<string>("selectedCloud", "elec.ply");
  const [renderMode, setRenderMode] = useState<RenderMode>("pointcloud");
  const [imported, setImported] = useState<{ name: string; url: string; format: AssetFormat } | null>(null);
  const importedUrlRef = useRef<string | null>(null);

  // The asset currently being edited: a locally imported file (not persisted
  // to localStorage) or the server-side cloud selected in the dropdown.
  const activeName = imported?.name ?? selectedCloud;
  const activeNameRef = useRef(activeName);
  activeNameRef.current = activeName;
  const selectedCloudRef = useRef(selectedCloud);
  selectedCloudRef.current = selectedCloud;

  const activeAssetFormat: AssetFormat = imported?.format ?? detectFormat(selectedCloud) ?? "ply";
  const activeAssetUrl = imported
    ? imported.url
    : `/api/pcd?name=${encodeURIComponent(selectedCloud)}`;
  const canRender3dgs =
    activeAssetFormat === "ply" ||
    activeAssetFormat === "splat" ||
    activeAssetFormat === "ksplat" ||
    activeAssetFormat === "spz";

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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
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

  useEffect(() => {
    fetch("/api/pointcloud-files")
      .then((r) => r.json())
      .then((j) => {
        const files = ((j.files || []) as { name: string }[])
          .map((f) => f.name)
          .filter((n) => /\.(pcd|ply)$/i.test(n));
        setCloudFiles(files);
        // A stale persisted selection (file since deleted / never existed)
        // would 404 on load; fall back to the first available cloud.
        if (files.length > 0 && !files.includes(selectedCloudRef.current)) {
          setSelectedCloud(files[0]!);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (importedUrlRef.current) {
        URL.revokeObjectURL(importedUrlRef.current);
        importedUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (renderMode !== "pointcloud") return;
    const format = activeAssetFormat;
    if (format !== "pcd" && format !== "ply") {
      setPositions(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const result =
          format === "ply"
            ? await loadPly(activeAssetUrl, PCD_MAX_POINTS)
            : await loadPcd(activeAssetUrl, PCD_MAX_POINTS);
        if (!cancelled) {
          setPositions(result.positions);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAssetUrl, activeAssetFormat, renderMode]);

  // Auto-load saved boxes for the currently active asset (if one exists).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/bbox?name=${encodeURIComponent(activeName)}`);
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
  }, [activeName]);

  const activeBox = useMemo(
    () => boxes.find((b) => b.id === activeId) ?? null,
    [boxes, activeId],
  );

  // Keep the render mode compatible with the active asset: .pcd can only be
  // a point cloud, splat-only formats can only be 3DGS. Without this, going
  // back from 3DGS to a .pcd file strands the UI on the "unsupported" notice.
  useEffect(() => {
    if (activeAssetFormat === "pcd" && renderMode === "3dgs") {
      setRenderMode("pointcloud");
    } else if (
      (activeAssetFormat === "splat" ||
        activeAssetFormat === "ksplat" ||
        activeAssetFormat === "spz") &&
      renderMode === "pointcloud"
    ) {
      setRenderMode("3dgs");
    }
  }, [activeAssetFormat, renderMode]);

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

  const persistBoxes = useCallback(async (name: string, list: BBoxItem[]) => {
    const resp = await fetch("/api/bbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, boxes: list.map(toBBoxOutput) }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  }, []);

  // Serialized save queue: concurrent POSTs could land out of order and roll
  // the file back to an older snapshot, so every save chains onto the last.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSave = useCallback(
    (name: string, list: BBoxItem[]) => {
      saveChainRef.current = saveChainRef.current
        .then(() => persistBoxes(name, list))
        .catch(() => {
          // Surface auto-save failures instead of swallowing them.
          setSaveState("error");
          window.setTimeout(() => setSaveState("idle"), 2000);
        });
      return saveChainRef.current;
    },
    [persistBoxes],
  );

  const handleSelectCloud = useCallback(
    (name: string) => {
      // Flush any edits still inside the debounce window to the OLD asset
      // before switching, so they are not silently dropped.
      if (dirtyRef.current && boxesRef.current.length > 0) {
        void enqueueSave(activeNameRef.current, boxesRef.current);
      }
      setSelectedCloud(name);
      if (importedUrlRef.current) {
        URL.revokeObjectURL(importedUrlRef.current);
        importedUrlRef.current = null;
      }
      setImported(null);
      setBoxes([]);
      setActiveId(null);
      setPlacing(false);
      setDraftMin(null);
      historyRef.current = [];
      dirtyRef.current = false;
    },
    [enqueueSave],
  );

  const handleImportFile = useCallback(
    (file: File) => {
      const format = detectFormat(file.name);
      if (!format) {
        setError("不支持的文件类型（仅 .pcd/.ply/.splat/.ksplat/.spz）");
        return;
      }
      // Flush pending edits of the previous asset before switching.
      if (dirtyRef.current && boxesRef.current.length > 0) {
        void enqueueSave(activeNameRef.current, boxesRef.current);
      }
      if (importedUrlRef.current) URL.revokeObjectURL(importedUrlRef.current);
      const url = URL.createObjectURL(file);
      importedUrlRef.current = url;

      // Keep selectedCloud untouched (it stays a server file); the imported
      // file is tracked separately so it is not persisted to localStorage.
      setImported({ name: file.name, url, format });
      setBoxes([]);
      setActiveId(null);
      setPlacing(false);
      setDraftMin(null);
      historyRef.current = [];
      dirtyRef.current = false;
      setError(null);
    },
    [enqueueSave],
  );

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
    if (boxesRef.current.length === 0) return;
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
      void enqueueSave(activeNameRef.current, boxesRef.current);
    }, 600);
    return () => window.clearTimeout(id);
  }, [boxes, enqueueSave]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <BBoxPanel
        boxes={boxes}
        activeId={activeId}
        placing={placing}
        cornerMin={activeBox?.min ?? null}
        cornerMax={activeBox?.max ?? null}
        center={center}
        size={size}
        pointSize={pointSize}
        handleRadius={handleRadius}
        lineWidth={lineWidth}
        opacity={opacity}
        saveState={saveState}
        copied={copied}
        cloudFiles={cloudFiles}
        selectedCloud={activeName}
        renderMode={renderMode}
        onRenderMode={setRenderMode}
        onImportFile={handleImportFile}
        onSelectCloud={handleSelectCloud}
        onSetMin={handleSetMin}
        onSetMax={handleSetMax}
        onBeginEdit={beginPanelEdit}
        onReset={handleReset}
        onSave={handleSave}
        onCopy={handleCopy}
        onPointSize={setPointSize}
        onHandleRadius={setHandleRadius}
        onLineWidth={setLineWidth}
        onOpacity={setOpacity}
        onNewBox={handleNewBox}
        onSelectBox={handleSelectBox}
        onRename={handleRename}
        onDeleteBox={handleDelete}
      />

      {renderMode === "pointcloud" && loading && (
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

      {renderMode === "pointcloud" && error && (
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
          {error}
        </div>
      )}

      {renderMode === "3dgs" ? (
        canRender3dgs ? (
          <GaussianSplatViewer
            src={activeAssetUrl}
            format={activeAssetFormat as "ply" | "splat" | "ksplat" | "spz"}
            boxes={boxes}
            activeId={activeId}
            placing={placing}
            draftMin={draftMin}
            handleRadius={handleRadius}
            lineWidth={lineWidth}
            opacity={opacity}
            anchorZRef={anchorZRef}
            onPlace={handlePlace}
            onDrag={handleDrag}
            onDragStart={handleDragStart}
            onSelectBox={handleSelectBox}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              color: "#888",
              fontFamily: "monospace",
              fontSize: 14,
              pointerEvents: "none",
            }}
          >
            当前文件（.{activeAssetFormat}）不支持 3DGS 渲染，请选择 .ply / .splat / .ksplat / .spz 文件
          </div>
        )
      ) : (
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
          onPlace={handlePlace}
          onDrag={handleDrag}
          onDragStart={handleDragStart}
          onSelectBox={handleSelectBox}
        />
      )}
    </div>
  );
}
