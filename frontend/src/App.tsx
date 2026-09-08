import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { AxisSide, BBoxItem, DragEntry, DragKind, Vec3 } from "./lib/bbox";
import {
  applyDrag,
  colorForIndex,
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

// Cap the parsed cloud to keep rendering responsive (elec.pcd is ~6.5M points).
const PCD_MAX_POINTS = 180_000;

/** Zero out delta components along axes not controlled by a drag entry. */
function constrainDelta(delta: Vec3, pairs: AxisSide[]): Vec3 {
  const active = [false, false, false];
  for (const p of pairs) active[p.axis] = true;
  return [
    active[0] ? delta[0] : 0,
    active[1] ? delta[1] : 0,
    active[2] ? delta[2] : 0,
  ];
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
  boxBodyRefs,
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
  boxBodyRefs: React.MutableRefObject<{ boxId: string; mesh: THREE.Mesh }[]>;
  anchorZRef: React.MutableRefObject<number>;
  onPlace: (p: Vec3) => void;
  onDrag: (boxId: string, pairs: AxisSide[], delta: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const { gl, camera } = useThree();

  const latestRef = useRef({ onPlace, onDrag, onDragStart, onSelectBox });
  latestRef.current = { onPlace, onDrag, onDragStart, onSelectBox };

  const dragRef = useRef<{
    pointerId: number;
    boxId: string;
    pairs: AxisSide[];
    plane: THREE.Plane;
    startLocal: Vec3;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = gl.domElement;
    const mouseDown = new THREE.Vector2();
    const mouseUp = new THREE.Vector2();
    const downBoxIdRef = { current: null as string | null };

    const ndcOf = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        rect,
        ndc: new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        ),
      };
    };

    const raycasterFrom = (clientX: number, clientY: number) => {
      const { ndc } = ndcOf(clientX, clientY);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      return raycaster;
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

    // Project the pointer ray onto an arbitrary world plane (camera-facing),
    // then convert the hit back into point-cloud local space.
    const localFromRayOnPlane = (
      clientX: number,
      clientY: number,
      plane: THREE.Plane,
    ): Vec3 | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const raycaster = raycasterFrom(clientX, clientY);
      const worldHit = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldHit);
      if (!hit) return null;

      const local = sceneGroup.worldToLocal(worldHit.clone());
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

    // Pick a draggable element. Corners and the center handle win over edges
    // and faces so the small spheres stay grabbable through the invisible
    // face/edge planes; faces are the broadest fallback.
    const dragAt = (raycaster: THREE.Raycaster): DragEntry | null => {
      const entries = dragRefs.current;
      if (entries.length === 0) return null;
      const byMesh = new Map<THREE.Object3D, DragEntry>();
      for (const e of entries) byMesh.set(e.mesh, e);

      const pick = (kind: DragKind): DragEntry | null => {
        const meshes = entries.filter((e) => e.kind === kind).map((e) => e.mesh);
        if (meshes.length === 0) return null;
        const hits = raycaster.intersectObjects(meshes, false);
        for (const h of hits) {
          const entry = byMesh.get(h.object);
          if (entry) return entry;
        }
        return null;
      };

      return pick("corner") ?? pick("center") ?? pick("edge") ?? pick("face");
    };

    // Fallback pick against the semi-transparent box bodies (used to select a
    // box when the pointer lands on its fill rather than a handle/face).
    const bodyAt = (raycaster: THREE.Raycaster): string | null => {
      const bodies = boxBodyRefs.current;
      if (bodies.length === 0) return null;
      const hits = raycaster.intersectObjects(
        bodies.map((b) => b.mesh),
        false,
      );
      if (hits.length === 0) return null;
      const found = bodies.find((b) => b.mesh === hits[0]!.object);
      return found ? found.boxId : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      mouseDown.set(e.clientX, e.clientY);
      downBoxIdRef.current = null;

      const sceneGroup = sceneGroupRef.current;
      const raycaster = raycasterFrom(e.clientX, e.clientY);
      const entry = dragAt(raycaster);

      if (!entry) {
        downBoxIdRef.current = bodyAt(raycaster);
        return;
      }

      // Dragging moves within a camera-facing plane through the grabbed
      // element, so corner/center translate freely in 3D while edges/faces
      // are later constrained to their controlled axes by `constrainDelta`.
      let plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      let startLocal: Vec3 = [0, 0, 0];
      if (sceneGroup) {
        sceneGroup.updateWorldMatrix(true, false);
        camera.updateMatrixWorld();
        const worldPos = entry.mesh.getWorldPosition(new THREE.Vector3());
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        plane = new THREE.Plane(camDir.clone(), -camDir.dot(worldPos));
        const worldHit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(plane, worldHit)) {
          const local = sceneGroup.worldToLocal(worldHit.clone());
          startLocal = [local.x, local.y, local.z];
        }
      }

      dragRef.current = {
        pointerId: e.pointerId,
        boxId: entry.boxId,
        pairs: entry.pairs,
        plane,
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
      const local = localFromRayOnPlane(e.clientX, e.clientY, drag.plane);
      if (local) {
        drag.moved = true;
        const delta: Vec3 = [
          local[0] - drag.startLocal[0],
          local[1] - drag.startLocal[1],
          local[2] - drag.startLocal[2],
        ];
        latestRef.current.onDrag(drag.boxId, drag.pairs, constrainDelta(delta, drag.pairs));
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

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      canvas.removeEventListener("pointermove", onPointerMove, { capture: true });
      canvas.removeEventListener("pointerup", finishDrag, { capture: true });
      canvas.removeEventListener("pointercancel", finishDrag, { capture: true });
      canvas.removeEventListener("click", onClick, { capture: true });
      if (dragRef.current && controlsRef.current) controlsRef.current.enabled = true;
      dragRef.current = null;
    };
  }, [gl, camera, sceneGroupRef, controlsRef, pointsRef, dragRefs, boxBodyRefs, anchorZRef]);

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
  onDrag: (boxId: string, pairs: AxisSide[], delta: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const sceneGroupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<any>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const dragRefs = useRef<DragEntry[]>([]);
  const boxBodyRefs = useRef<{ boxId: string; mesh: THREE.Mesh }[]>([]);

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
            boxBodyRefs={boxBodyRefs}
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
        boxBodyRefs={boxBodyRefs}
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
  const [selectedCloud, setSelectedCloud] = useLocalStorageState<string>("selectedCloud", "elec.pcd");

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

  const pushHistory = useCallback(() => {
    const snap = boxesRef.current.map((b) => ({
      ...b,
      min: [...b.min] as Vec3,
      max: [...b.max] as Vec3,
    }));
    historyRef.current = [...historyRef.current, snap];
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
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `/api/pcd?name=${encodeURIComponent(selectedCloud)}`;
        const result = /\.ply$/i.test(selectedCloud)
          ? await loadPly(url, PCD_MAX_POINTS)
          : await loadPcd(url, PCD_MAX_POINTS);
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
  }, [selectedCloud]);

  // Auto-load saved boxes for the currently selected cloud (if one exists).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/bbox?name=${encodeURIComponent(selectedCloud)}`);
        if (resp.status === 404) return;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        const loaded = parseBoxes(data);
        setBoxes(loaded);
        setActiveId(loaded[0]?.id ?? null);
        setPlacing(false);
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
  }, [selectedCloud]);

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

  // Console output matching the old script's ~1/3 Hz throttle.
  useEffect(() => {
    if (boxes.length === 0) return;
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
        const label = `object_${boxesRef.current.length + 1}`;
        const box: BBoxItem = { id, label, min: vecMin(draft, p), max: vecMax(draft, p) };
        setBoxes((prev) => [...prev, box]);
        setActiveId(id);
        setDraftMin(null);
        setPlacing(false);
      }
    },
    [pushHistory],
  );

  const handleDrag = useCallback((boxId: string, pairs: AxisSide[], delta: Vec3) => {
    setBoxes((prev) =>
      prev.map((b) => (b.id === boxId ? applyDrag(b, pairs, delta) : b)),
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

  const handleRename = useCallback((id: string, label: string) => {
    dirtyRef.current = true;
    setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, label } : b)));
  }, []);

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

  const handleBeginEdit = useCallback(() => {
    pushHistory();
    dirtyRef.current = true;
  }, [pushHistory]);

  const handleSetMin = useCallback((v: Vec3) => {
    const id = activeIdRef.current;
    if (!id) return;
    setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, min: [...v] as Vec3 } : b)));
  }, []);

  const handleSetMax = useCallback((v: Vec3) => {
    const id = activeIdRef.current;
    if (!id) return;
    setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, max: [...v] as Vec3 } : b)));
  }, []);

  const handleSelectCloud = useCallback((name: string) => {
    setSelectedCloud(name);
    setBoxes([]);
    setActiveId(null);
    setPlacing(false);
    setDraftMin(null);
    historyRef.current = [];
    dirtyRef.current = false;
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

  const persistBoxes = useCallback(async (name: string, list: BBoxItem[]) => {
    const resp = await fetch("/api/bbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, boxes: list.map(toBBoxOutput) }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  }, []);

  const handleSave = useCallback(async () => {
    if (boxesRef.current.length === 0) return;
    setSaveState("saving");
    try {
      await persistBoxes(selectedCloud, boxesRef.current);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [selectedCloud, persistBoxes]);

  // Debounced auto-save: persist after the user finishes editing.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const id = window.setTimeout(() => {
      void persistBoxes(selectedCloud, boxesRef.current).catch(() => {});
    }, 600);
    return () => window.clearTimeout(id);
  }, [boxes, selectedCloud, persistBoxes]);

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
        selectedCloud={selectedCloud}
        onSelectCloud={handleSelectCloud}
        onSetMin={handleSetMin}
        onSetMax={handleSetMax}
        onBeginEdit={handleBeginEdit}
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

      {loading && (
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

      {error && (
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
    </div>
  );
}
