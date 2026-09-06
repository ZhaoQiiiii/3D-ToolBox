import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { Vec3 } from "./lib/bbox";
import { formatBboxJson, toBboxResult, vecMin, vecMax } from "./lib/bbox";
import { loadPcd, loadPly } from "./lib/pcd-loader";
import { PointCloudView } from "./components/PointCloudView";
import { BBoxLayer } from "./components/BBoxLayer";
import { CornerHandle } from "./components/CornerHandle";
import { BBoxPanel } from "./components/BBoxPanel";
import { CameraControls } from "./components/CameraControls";

// Cap the parsed cloud to keep rendering responsive (elec.pcd is ~6.5M points).
const PCD_MAX_POINTS = 180_000;
const HANDLE_COLOR = "#ff5252";
const PICK_PIXEL_RADIUS = 16;

// ---- picker (raw canvas pointer events) ----

function Picker({
  sceneGroupRef,
  controlsRef,
  pointsRef,
  handleRefs,
  cornersRef,
  onPlace,
  onDrag,
  onDragStart,
}: {
  sceneGroupRef: RefObject<THREE.Group | null>;
  controlsRef: RefObject<any>;
  pointsRef: RefObject<THREE.Points | null>;
  handleRefs: React.MutableRefObject<Array<THREE.Mesh | null>>;
  cornersRef: React.MutableRefObject<{ min: Vec3 | null; max: Vec3 | null }>;
  onPlace: (p: Vec3) => void;
  onDrag: (index: number, p: Vec3) => void;
  onDragStart: () => void;
}) {
  const { gl, camera } = useThree();

  const latestRef = useRef({ onPlace, onDrag, onDragStart });
  latestRef.current = { onPlace, onDrag, onDragStart };

  const dragRef = useRef<{
    pointerId: number;
    index: number;
    plane: THREE.Plane;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = gl.domElement;
    const mouseDown = new THREE.Vector2();
    const mouseUp = new THREE.Vector2();
    const downOnHandleRef = { current: false };

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
      const plane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        -worldStart.y,
      );

      const { ndc } = ndcOf(clientX, clientY);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const worldHit = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldHit);
      if (!hit) return null;

      const local = sceneGroup.worldToLocal(worldHit.clone());
      return [local.x, local.y, local.z];
    };

    // Project the pointer ray onto an arbitrary world plane. This is used for
    // corner dragging: the plane passes through the grabbed handle and faces
    // the camera, so dragging moves the corner freely in 3D instead of only
    // along the local horizontal XY plane.
    const localFromRayOnPlane = (
      clientX: number,
      clientY: number,
      plane: THREE.Plane,
    ): Vec3 | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const { ndc } = ndcOf(clientX, clientY);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const worldHit = new THREE.Vector3();
      const hit = raycaster.ray.intersectPlane(plane, worldHit);
      if (!hit) return null;

      const local = sceneGroup.worldToLocal(worldHit.clone());
      return [local.x, local.y, local.z];
    };

    // Primary pick: raycast against the point cloud; fall back to the local
    // horizontal plane when the ray misses the cloud.
    const pickPoint = (clientX: number, clientY: number, anchorZLocal: number): Vec3 | null => {
      const { ndc } = ndcOf(clientX, clientY);
      const raycaster = new THREE.Raycaster();
      raycaster.params.Points.threshold = 0.4;
      raycaster.setFromCamera(ndc, camera);

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

    // Grab a corner handle by projecting each handle to screen space and
    // choosing the closest one within a pixel radius (more forgiving than a
    // raw mesh raycast for small spheres in a large scene).
    const handleAt = (clientX: number, clientY: number): number | null => {
      const sceneGroup = sceneGroupRef.current;
      if (!sceneGroup) return null;
      sceneGroup.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();

      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;

      let bestIdx: number | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < handleRefs.current.length; i++) {
        const mesh = handleRefs.current[i];
        if (!mesh) continue;
        const world = mesh.getWorldPosition(new THREE.Vector3());
        const ndc = world.project(camera);
        const sx = (ndc.x * 0.5 + 0.5) * rect.width;
        const sy = (-ndc.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx !== null && bestDist <= PICK_PIXEL_RADIUS ? bestIdx : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      mouseDown.set(e.clientX, e.clientY);
      const idx = handleAt(e.clientX, e.clientY);
      if (idx === null) {
        downOnHandleRef.current = false;
        return;
      }
      downOnHandleRef.current = true;

      const mesh = handleRefs.current[idx];
      const sceneGroup = sceneGroupRef.current;
      let plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      if (mesh && sceneGroup) {
        sceneGroup.updateWorldMatrix(true, false);
        camera.updateMatrixWorld();
        const worldPos = mesh.getWorldPosition(new THREE.Vector3());
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        plane = new THREE.Plane(camDir.clone(), -camDir.dot(worldPos));
      }

      dragRef.current = {
        pointerId: e.pointerId,
        index: idx,
        plane,
        moved: false,
      };

      latestRef.current.onDragStart();

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
        latestRef.current.onDrag(drag.index, local);
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
      if (downOnHandleRef.current) return; // clicking an existing handle

      const el = e.target as HTMLElement;
      if (el.closest("[data-overlay]")) return;

      const anchorZ = cornersRef.current.min ? cornersRef.current.min[2] : 0;
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
  }, [gl, camera, sceneGroupRef, controlsRef, pointsRef, handleRefs, cornersRef]);

  return null;
}

// ---- scene ----

function Scene({
  positions,
  pointSize,
  handleRadius,
  lineWidth,
  opacity,
  cornerMin,
  cornerMax,
  cornersRef,
  onPlace,
  onDrag,
  onDragStart,
}: {
  positions: Float32Array | null;
  pointSize: number;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  cornerMin: Vec3 | null;
  cornerMax: Vec3 | null;
  cornersRef: React.MutableRefObject<{ min: Vec3 | null; max: Vec3 | null }>;
  onPlace: (p: Vec3) => void;
  onDrag: (index: number, p: Vec3) => void;
  onDragStart: () => void;
}) {
  const sceneGroupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<any>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const handleRefs = useRef<Array<THREE.Mesh | null>>([]);

  return (
    <Canvas style={{ width: "100%", height: "100%" }}>
      <PerspectiveCamera makeDefault position={[12, 25, 20]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 15, 5]} intensity={1.2} />

      <group ref={sceneGroupRef} rotation={[-Math.PI / 2, 0, 0]}>
        <PointCloudView ref={pointsRef} positions={positions} pointSize={pointSize} />

        {cornerMin && !cornerMax && (
          <CornerHandle
            position={cornerMin}
            radius={handleRadius}
            color={HANDLE_COLOR}
            index={0}
            handleRefs={handleRefs}
          />
        )}

        {cornerMin && cornerMax && (
          <BBoxLayer
            cornerMin={cornerMin}
            cornerMax={cornerMax}
            handleRadius={handleRadius}
            lineWidth={lineWidth}
            opacity={opacity}
            color={HANDLE_COLOR}
            handleRefs={handleRefs}
          />
        )}
      </group>

      <gridHelper args={[160, 80, "#333", "#222"]} />
      <CameraControls ref={controlsRef} />
      <Picker
        sceneGroupRef={sceneGroupRef}
        controlsRef={controlsRef}
        pointsRef={pointsRef}
        handleRefs={handleRefs}
        cornersRef={cornersRef}
        onPlace={onPlace}
        onDrag={onDrag}
        onDragStart={onDragStart}
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

  const [cornerMin, setCornerMin] = useState<Vec3 | null>(null);
  const [cornerMax, setCornerMax] = useState<Vec3 | null>(null);
  const historyRef = useRef<Array<{ min: Vec3 | null; max: Vec3 | null }>>([]);

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copied, setCopied] = useState(false);

  const cornersRef = useRef<{ min: Vec3 | null; max: Vec3 | null }>({
    min: cornerMin,
    max: cornerMax,
  });
  cornersRef.current = { min: cornerMin, max: cornerMax };

  const pushHistory = useCallback(() => {
    const cur = cornersRef.current;
    historyRef.current = [...historyRef.current, { min: cur.min, max: cur.max }];
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const last = h[h.length - 1]!;
    setCornerMin(last.min);
    setCornerMax(last.max);
    historyRef.current = h.slice(0, -1);
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

  const json = useMemo(
    () => (cornerMin && cornerMax ? formatBboxJson(cornerMin, cornerMax) : null),
    [cornerMin, cornerMax],
  );

  const result = useMemo(
    () => (cornerMin && cornerMax ? toBboxResult(cornerMin, cornerMax) : null),
    [cornerMin, cornerMax],
  );

  const center = useMemo<Vec3 | null>(
    () => (result ? [result.center_x, result.center_y, result.center_z] : null),
    [result],
  );

  const size = useMemo<Vec3 | null>(
    () => (result ? [result.size_x, result.size_y, result.size_z] : null),
    [result],
  );

  // Console output matching the old script's ~1/3 Hz throttle.
  useEffect(() => {
    if (!cornerMin || !cornerMax) return;
    console.log(formatBboxJson(cornerMin, cornerMax));
    const id = window.setInterval(() => {
      console.log(formatBboxJson(cornerMin, cornerMax));
    }, 3000);
    return () => window.clearInterval(id);
  }, [cornerMin, cornerMax]);

  const handlePlace = useCallback((p: Vec3) => {
    const cur = cornersRef.current;
    if (!cur.min) {
      pushHistory();
      setCornerMin(p);
    } else if (!cur.max) {
      // The two clicks are diagonal corners in either order, so normalise
      // them into a true component-wise min/max pair.
      pushHistory();
      const a = cur.min;
      setCornerMin(vecMin(a, p));
      setCornerMax(vecMax(a, p));
    }
  }, [pushHistory]);

  const handleDrag = useCallback((index: number, p: Vec3) => {
    const cur = cornersRef.current;
    if (!cur.min && !cur.max) return;

    const min: Vec3 = cur.min ? [...cur.min] : p;
    const max: Vec3 = cur.max ? [...cur.max] : p;

    // index bit0 selects min/max x, bit1 selects min/max y. Clamp against the
    // opposite boundary so a handle can never be dragged past its counterpart
    // and produce a negative-size box.
    if ((index & 1) === 0) {
      min[0] = cur.max ? Math.min(p[0], max[0]) : p[0];
    } else {
      max[0] = cur.min ? Math.max(p[0], min[0]) : p[0];
    }
    if (((index >> 1) & 1) === 0) {
      min[1] = cur.max ? Math.min(p[1], max[1]) : p[1];
    } else {
      max[1] = cur.min ? Math.max(p[1], min[1]) : p[1];
    }
    if (((index >> 2) & 1) === 0) {
      min[2] = cur.max ? Math.min(p[2], max[2]) : p[2];
    } else {
      max[2] = cur.min ? Math.max(p[2], min[2]) : p[2];
    }

    if (cur.min) setCornerMin(min);
    if (cur.max) setCornerMax(max);
  }, []);

  const handleReset = useCallback(() => {
    const cur = cornersRef.current;
    if (!cur.min && !cur.max) return;
    pushHistory();
    setCornerMin(null);
    setCornerMax(null);
  }, [pushHistory]);

  const handleSelectCloud = useCallback((name: string) => {
    setSelectedCloud(name);
    setCornerMin(null);
    setCornerMax(null);
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
    if (!cornerMin || !cornerMax) return;
    setSaveState("saving");
    try {
      const resp = await fetch("/api/bbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBboxResult(cornerMin, cornerMax)),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [cornerMin, cornerMax]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <BBoxPanel
        cornerMin={cornerMin}
        cornerMax={cornerMax}
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
        onSetMin={setCornerMin}
        onSetMax={setCornerMax}
        onBeginEdit={pushHistory}
        onReset={handleReset}
        onSave={handleSave}
        onCopy={handleCopy}
        onPointSize={setPointSize}
        onHandleRadius={setHandleRadius}
        onLineWidth={setLineWidth}
        onOpacity={setOpacity}
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
        cornerMin={cornerMin}
        cornerMax={cornerMax}
        cornersRef={cornersRef}
        onPlace={handlePlace}
        onDrag={handleDrag}
        onDragStart={pushHistory}
      />
    </div>
  );
}
