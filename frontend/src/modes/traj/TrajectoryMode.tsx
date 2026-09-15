import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { TrajectoryLine } from "./components/TrajectoryLine";
import { ControlPanel } from "./components/ControlPanel";
import { InfoPanel } from "./components/InfoPanel";
import { GaussianSplatLayer } from "../../shared/components/GaussianSplatLayer";
import { PointCloudLayer, type PcdColorScheme } from "../../shared/components/PointCloudLayer";
import { WorldAxes } from "../../shared/components/WorldAxes";
import { SceneGrid } from "../../shared/components/SceneGrid";
import {
  SCENE_COLUMN_STYLE,
  SceneAssetPanel,
} from "../../shared/components/SceneAssetPanel";
import { type SplatFormat } from "../../shared/splat-format";
import { useSceneAssets } from "../../shared/use-scene-assets";
import { useCanvasSlot } from "../../shared/canvas-slot";
import { useSceneCameraPose } from "../../shared/use-scene-camera";
import { useSceneVisuals } from "../../shared/use-scene-visuals";
import {
  Y_UP,
  rayHitHorizontalPlane,
  verticalDragWorld,
} from "../../shared/lib/projection";
import type {
  PromptInfo,
  ResultInfo,
  TrajBrowseResult,
  TrajPoint,
  TrajStep,
  TrajectoryData,
} from "./lib/traj-types";

type RenderMode = "pointcloud" | "3dgs";

const HINT_BAR: CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 10px",
  borderRadius: 6,
  background: "rgba(0,0,0,0.82)",
  color: "#ddd",
  fontFamily: "monospace",
  fontSize: 12,
  border: "1px solid rgba(52,152,219,0.28)",
};

const btnStyle: CSSProperties = {
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "3px 10px",
};

/**
 * Trajectory visualization mode.
 *
 * Trajectory browsing is fixed to the project directory (the backend rejects
 * paths outside it); the UI walks worldmodel flight_/step_ directories from
 * that root. A render scene (point cloud or 3DGS) is picked from the shared
 * scenes/ listing and the pi3_local trajectory is overlaid on the scene and
 * can be dragged into place (left button = horizontal, right button =
 * vertical — same convention as the BBox corner handles).
 *
 * trajectory.json is in a per-step LOCAL frame (every step starts at its own
 * origin); nothing in the data relates it to the world frame, so placement
 * is manual by design.
 */
export function TrajectoryMode() {
  // ---- path browsing (fixed to the backend-reported root) ----
  const [browse, setBrowse] = useState<TrajBrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<TrajStep | null>(null);
  const [rootPath, setRootPath] = useState("");

  // ---- step data ----
  const [traj, setTraj] = useState<TrajectoryData | null>(null);
  const [trajLoading, setTrajLoading] = useState(false);
  const [trajError, setTrajError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptInfo | null>(null);
  const [result, setResult] = useState<ResultInfo | null>(null);

  // ---- scene ----
  // Scene-rendering state — the ONE shared implementation (scene bucket,
  // asset listing, selections, render mode, point-cloud loading) used by
  // all three modes. Trajectory only adds its step/playback state on top.
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
    activeFormat,
    activeUrl,
    positions,
    cloudLoading,
    cloudError,
  } = useSceneAssets();
  // Scene point size: the ONE shared setting across all three modes.
  const {
    pointSize,
    setPointSize,
    gridSize,
    setGridSize,
    showAxes,
    setShowAxes,
    colorScheme,
    setColorScheme,
    opacity,
    setOpacity,
  } = useSceneVisuals();
  const [splatLoading, setSplatLoading] = useState(false);
  const [splatError, setSplatError] = useState<string | null>(null);

  // ---- placement & playback ----
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  const [yawDeg, setYawDeg] = useState(0);
  const [playIndex, setPlayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Monotonic token for browse requests (see doBrowse).
  const browseSeqRef = useRef(0);

  const doBrowse = useCallback(async (path?: string) => {
    const trimmed = path?.trim() ?? "";
    // Sequence token: a newer browse supersedes an in-flight one, so a
    // slow older response can never overwrite the newer listing.
    const seq = ++browseSeqRef.current;
    setBrowsing(true);
    setBrowseError(null);
    // The previous step's load error is stale once the user browses away.
    setTrajError(null);
    try {
      const resp = await fetch(
        trimmed
          ? `/api/traj-browse?path=${encodeURIComponent(trimmed)}`
          : "/api/traj-browse",
      );
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as TrajBrowseResult;
      if (seq !== browseSeqRef.current) return;
      setBrowse(data);
      setRootPath(data.root);
      setSelectedStep(null);
    } catch (e) {
      if (seq !== browseSeqRef.current) return;
      setBrowse(null);
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === browseSeqRef.current) setBrowsing(false);
    }
  }, []);

  // Auto-browse the fixed root on mount.
  useEffect(() => {
    void doBrowse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load step artifacts (trajectory + metadata) with a cancellation guard:
  // rapidly switching steps must not let a stale fetch clobber the new one.
  useEffect(() => {
    if (!selectedStep) {
      setTraj(null);
      setPrompt(null);
      setResult(null);
      setTrajError(null);
      // A cancelled in-flight load leaves trajLoading=true (its finally is
      // guarded by `cancelled`); reset it here so the banner doesn't stick.
      setTrajLoading(false);
      return;
    }
    let cancelled = false;
    setTrajLoading(true);
    setTrajError(null);
    const base = `/api/traj-file?path=${encodeURIComponent(selectedStep.path)}&name=`;
    (async () => {
      try {
        const [trajResp, promptResp, resultResp] = await Promise.all([
          fetch(`${base}trajectory.json`),
          fetch(`${base}prompt.json`).catch(() => null),
          fetch(`${base}result.json`).catch(() => null),
        ]);
        if (cancelled) return;
        if (!trajResp.ok) {
          throw new Error(`trajectory.json: HTTP ${trajResp.status}`);
        }
        const trajData = (await trajResp.json()) as TrajectoryData;
        if (cancelled) return;
        if (
          !trajData ||
          !Array.isArray(trajData.points) ||
          trajData.points.length === 0
        ) {
          throw new Error("trajectory.json 缺少 points 数组");
        }
        setTraj(trajData);
        // Every step starts at its own local origin — reset placement and
        // playback for the new step.
        setPlayIndex(0);
        setPlaying(false);
        setOffset([0, 0, 0]);
        setYawDeg(0);

        let promptData: PromptInfo | null = null;
        if (promptResp && promptResp.ok) {
          promptData = (await promptResp.json()) as PromptInfo;
          if (cancelled) return;
        }
        setPrompt(promptData);
        let resultData: ResultInfo | null = null;
        if (resultResp && resultResp.ok) {
          resultData = (await resultResp.json()) as ResultInfo;
          if (cancelled) return;
        }
        setResult(resultData);
      } catch (e) {
        if (!cancelled) {
          setTraj(null);
          // Also drop the metadata of the previous step — leaving it would
          // show the old prompt/result under the newly selected step.
          setPrompt(null);
          setResult(null);
          setTrajError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setTrajLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStep]);

  // Playback: advance the playhead; stop at the last point. setPlaying runs
  // in its own effect below — calling it inside the setPlayIndex updater
  // would be a side effect in a function React requires to be pure
  // (StrictMode double-invokes updaters).
  const pointCount = traj?.points.length ?? 0;
  useEffect(() => {
    if (!playing || pointCount === 0) return;
    const id = window.setInterval(
      () => setPlayIndex((i) => Math.min(i + 1, pointCount - 1)),
      Math.max(80, 500 / speed),
    );
    return () => window.clearInterval(id);
  }, [playing, pointCount, speed]);

  useEffect(() => {
    if (playing && pointCount > 0 && playIndex >= pointCount - 1) {
      setPlaying(false);
    }
  }, [playing, playIndex, pointCount]);

  // Keep the (paused) video in sync with the playhead: both have the same
  // sample count, so map the point index proportionally onto the duration.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || pointCount < 2) return;
    const apply = () => {
      if (
        Number.isFinite(v.duration) &&
        v.duration > 0
      ) {
        v.currentTime = (playIndex / (pointCount - 1)) * v.duration;
      }
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
    // Remove the pending listener on cleanup: without this, every re-run
    // before metadata arrives would pile up another once-listener (each
    // with its own playIndex closure) that all fire together later.
    return () => v.removeEventListener("loadedmetadata", apply);
  }, [playIndex, pointCount, selectedStep]);

  const currentPoint: TrajPoint | null =
    traj && pointCount > 0
      ? traj.points[Math.min(playIndex, pointCount - 1)]!
      : null;

  // 3D content → shared persistent canvas (App level). The canvas and its
  // WebGL context survive mode switches, so the splat viewer / point clouds
  // re-attach from cache instantly.
  useCanvasSlot(
    <TrajScene
      renderMode={renderMode}
      splatSrc={renderMode === "3dgs" ? activeUrl : null}
      splatFormat={
        renderMode === "3dgs"
          ? ((activeFormat as SplatFormat | null) ?? "ply")
          : null
      }
      positions={positions}
      pointSize={pointSize}
      gridSize={gridSize}
      showAxes={showAxes}
      colorScheme={colorScheme}
      cloudOpacity={opacity}
      trajPoints={traj?.points ?? []}
      offset={offset}
      yawDeg={yawDeg}
      playIndex={playIndex}
      setOffset={setOffset}
      onSplatLoadingChange={setSplatLoading}
      onSplatError={setSplatError}
    />,
  );

  return (
    <div
      className="mode-overlay"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {/* Unified left-side scene column shared by all three modes: render
          mode and cloud/splat selection on top, then this
          mode's visualization lists (trajectory path/step browser and the
          step info panel) as standalone panels with the column gap in
          between. */}
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
          pointSize={pointSize}
          onPointSizeChange={setPointSize}
          gridSize={gridSize}
          onGridSizeChange={setGridSize}
          showAxes={showAxes}
          onShowAxesChange={setShowAxes}
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          opacity={opacity}
          onOpacityChange={setOpacity}
        />

        <ControlPanel
          rootPath={rootPath}
          browse={browse}
          browsing={browsing}
          browseError={browseError}
          selectedStep={selectedStep}
          onSelectStep={(s) => setSelectedStep(s)}
          onNavigate={(path) => {
            void doBrowse(path);
          }}
          offset={offset}
          yawDeg={yawDeg}
          onPlacementChange={(o, y) => {
            setOffset(o);
            setYawDeg(y);
          }}
          onResetPlacement={() => {
            setOffset([0, 0, 0]);
            setYawDeg(0);
          }}
          hasTrajectory={pointCount > 0}
        />

        {selectedStep && (
          <InfoPanel
            step={selectedStep}
            prompt={prompt}
            result={result}
            hasVideo={selectedStep.hasVideo}
            videoRef={videoRef}
            playIndex={playIndex}
            pointCount={pointCount}
            currentPoint={currentPoint}
          />
        )}
      </div>

      {pointCount > 0 && (
        <div style={HINT_BAR}>
          <button
            style={btnStyle}
            onClick={() => {
              if (!playing && playIndex >= pointCount - 1) setPlayIndex(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? "⏸ 暂停" : "▶ 播放"}
          </button>
          <input
            type="range"
            min={0}
            max={pointCount - 1}
            step={1}
            value={Math.min(playIndex, pointCount - 1)}
            onChange={(e) => {
              setPlaying(false);
              setPlayIndex(Number(e.target.value));
            }}
          />
          <span>
            {playIndex + 1} / {pointCount}
          </span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ background: "#1a1a2e", color: "#ccc", border: "1px solid #3498db", borderRadius: 4 }}
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
          </select>
        </div>
      )}

      {(trajLoading || trajError) && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            padding: "6px 12px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.82)",
            color: trajError ? "#e55" : "#ccc",
            fontFamily: "monospace",
            fontSize: 12,
          }}
        >
          {trajError ? `轨迹加载失败: ${trajError}` : "Loading..."}
        </div>
      )}

      {/* Centered 3DGS loading indicator (same as the other two modes) */}
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
    </div>
  );
}

// ---- canvas scene ----

interface TrajSceneProps {
  renderMode: RenderMode;
  /** Splat asset to render in 3DGS mode (null = none / pointcloud mode). */
  splatSrc: string | null;
  splatFormat: SplatFormat | null;
  positions: Float32Array | null;
  pointSize: number;
  gridSize: number;
  showAxes: boolean;
  colorScheme: PcdColorScheme;
  cloudOpacity: number;
  trajPoints: TrajPoint[];
  offset: [number, number, number];
  yawDeg: number;
  playIndex: number;
  setOffset: (o: [number, number, number]) => void;
  onSplatLoadingChange: (loading: boolean) => void;
  onSplatError: (message: string | null) => void;
}

function TrajScene(p: TrajSceneProps) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { enabled: boolean }
    | null;
  const gl = useThree((s) => s.gl);
  // ONE camera pose across all three modes: restore on mount, track live.
  useSceneCameraPose();
  const sceneGroupRef = useRef<THREE.Group>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);

  const dragRef = useRef<{
    button: number;
    startOffset: [number, number, number];
    startLocal: [number, number, number];
  } | null>(null);
  // Ends an in-flight drag (used as the window-listener cleanup). Held in a
  // ref so unmounting mid-drag still removes the listeners — otherwise the
  // pointerup that ends the drag never arrives (e.g. release outside the
  // window) and OrbitControls stays disabled forever.
  const cancelDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDragRef.current?.(), []);

  const rayFrom = useCallback(
    (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera as THREE.PerspectiveCamera);
      return raycaster;
    },
    [gl, camera, ndc, raycaster],
  );

  // Pointer ray → local coords on the horizontal plane through `anchorLocal`
  // (same pattern as the BBox corner picker).
  const groundLocalAt = useCallback(
    (
      clientX: number,
      clientY: number,
      anchorLocal: [number, number, number],
    ): [number, number, number] | null => {
      const g = sceneGroupRef.current;
      if (!g) return null;
      g.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      const worldStart = new THREE.Vector3(
        anchorLocal[0],
        anchorLocal[1],
        anchorLocal[2],
      ).applyMatrix4(g.matrixWorld);
      const rc = rayFrom(clientX, clientY);
      const hit = rayHitHorizontalPlane(rc.ray, Y_UP, worldStart);
      if (!hit) return null;
      const l = g.worldToLocal(hit.clone());
      return [l.x, l.y, l.z];
    },
    [rayFrom, camera],
  );

  // Pointer ray → local coords keeping the anchor's X/Y and moving only the
  // height (vertical drag), with the near-top-down fallback.
  const verticalLocalAt = useCallback(
    (
      clientX: number,
      clientY: number,
      anchorLocal: [number, number, number],
    ): [number, number, number] | null => {
      const g = sceneGroupRef.current;
      if (!g) return null;
      g.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      const worldStart = new THREE.Vector3(
        anchorLocal[0],
        anchorLocal[1],
        anchorLocal[2],
      ).applyMatrix4(g.matrixWorld);
      const rc = rayFrom(clientX, clientY);
      const w = verticalDragWorld(
        camera as THREE.PerspectiveCamera,
        rc.ray,
        clientX,
        clientY,
        gl.domElement.getBoundingClientRect(),
        worldStart,
        Y_UP,
      );
      if (!w) return null;
      const l = g.worldToLocal(w);
      return [l.x, l.y, l.z];
    },
    [rayFrom, camera, gl],
  );

  const handleGrabStart = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      // Left button drags horizontally, right button vertically (same
      // convention as the BBox corner handles).
      if (e.button !== 0 && e.button !== 2) return;
      const g = sceneGroupRef.current;
      if (!g) return;
      e.stopPropagation();
      // Disable OrbitControls for the duration of the drag so the camera
      // doesn't move together with the trajectory.
      if (controls) controls.enabled = false;
      // Capture the pointer on the canvas so releasing it outside the
      // window still delivers pointerup (which bubbles to the window
      // listeners below) — without capture the drag would leak.
      try {
        gl.domElement.setPointerCapture(e.pointerId);
      } catch {}
      const grab = g.worldToLocal(e.point.clone());
      dragRef.current = {
        button: e.button,
        startOffset: [...p.offset] as [number, number, number],
        startLocal: [grab.x, grab.y, grab.z],
      };

      const onMove = (ev: PointerEvent) => {
        const st = dragRef.current;
        if (!st) return;
        if (st.button === 0) {
          const nl = groundLocalAt(ev.clientX, ev.clientY, st.startLocal);
          if (!nl) return;
          p.setOffset([
            st.startOffset[0] + nl[0] - st.startLocal[0],
            st.startOffset[1] + nl[1] - st.startLocal[1],
            st.startOffset[2],
          ]);
        } else {
          const nl = verticalLocalAt(ev.clientX, ev.clientY, st.startLocal);
          if (!nl) return;
          p.setOffset([
            st.startOffset[0],
            st.startOffset[1],
            st.startOffset[2] + (nl[2] - st.startLocal[2]),
          ]);
        }
      };
      const endDrag = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("pointercancel", endDrag);
        if (controls) controls.enabled = true;
        cancelDragRef.current = null;
      };
      cancelDragRef.current = endDrag;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    },
    [controls, gl, p, groundLocalAt, verticalLocalAt],
  );

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[6, 6, 6]}
        fov={50}
        near={0.1}
        far={2000}
      />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={0.5}
        maxDistance={300}
      />
      <SceneGrid size={p.gridSize} />
      {/* Z-up local frame (matches the trajectory + cloud conventions). */}
      <group ref={sceneGroupRef} rotation={[-Math.PI / 2, 0, 0]}>
        {p.showAxes && <WorldAxes />}
        {p.renderMode === "pointcloud" && p.positions && (
          <PointCloudLayer
            positions={p.positions}
            colorHex="#aaccff"
            pointSize={p.pointSize}
            colorScheme={p.colorScheme}
            opacity={p.cloudOpacity}
          />
        )}
        {p.renderMode === "3dgs" && p.splatSrc && p.splatFormat && (
          <GaussianSplatLayer
            src={p.splatSrc}
            format={p.splatFormat}
            onLoadingChange={p.onSplatLoadingChange}
            onError={p.onSplatError}
          />
        )}
        {p.trajPoints.length > 0 && (
          <TrajectoryLine
            points={p.trajPoints}
            offset={p.offset}
            yawDeg={p.yawDeg}
            playIndex={p.playIndex}
            onGrabStart={handleGrabStart}
          />
        )}
      </group>
    </>
  );
}
