import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import type { BBoxItem, Vec3 } from "../lib/bbox";
import { boxEdges, colorForIndex, cornerPositions, centerOf, sizeOf } from "../lib/bbox";

type SplatFormat = "ply" | "splat" | "ksplat" | "spz";

const FORMAT_TO_SCENE_FORMAT: Record<SplatFormat, number> = {
  ply: GaussianSplats3D.SceneFormat.Ply,
  splat: GaussianSplats3D.SceneFormat.Splat,
  ksplat: GaussianSplats3D.SceneFormat.KSplat,
  spz: GaussianSplats3D.SceneFormat.Spz,
};

// A CylinderGeometry is aligned along its local +Y axis, so to orient an edge
// cylinder we rotate +Y onto the edge direction (same as BBoxLayer.tsx). This
// is independent of the scene being Z-up.
const UP = new THREE.Vector3(0, 1, 0);

function addEdgeCylinder(
  parent: THREE.Object3D,
  start: Vec3,
  end: Vec3,
  radius: number,
  color: string,
): void {
  const av = new THREE.Vector3(start[0], start[1], start[2]);
  const bv = new THREE.Vector3(end[0], end[1], end[2]);
  const mid = av.clone().add(bv).multiplyScalar(0.5);
  const dir = bv.clone().sub(av);
  const length = dir.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 8),
    new THREE.MeshBasicMaterial({ color }),
  );
  mesh.position.copy(mid);
  mesh.quaternion.copy(quaternion);
  parent.add(mesh);
}

function buildBoxVisual(
  parent: THREE.Object3D,
  box: BBoxItem,
  index: number,
  active: boolean,
  handleRadius: number,
  lineWidth: number,
  opacity: number,
): void {
  const corners = cornerPositions(box.min, box.max);
  const edges = boxEdges();
  const color = colorForIndex(index);
  const edgeColor = active ? color : "#7a7a7a";
  const handleColor = active ? color : "#9a9a9a";
  const radius = Math.max(0.0005, lineWidth / 2);
  const center = centerOf(box.min, box.max);
  const size = sizeOf(box.min, box.max);
  const fillOpacity = active ? opacity : opacity * 0.55;

  for (const [a, b] of edges) {
    addEdgeCylinder(parent, corners[a]!, corners[b]!, radius, edgeColor);
  }

  const fill = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: fillOpacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  fill.position.set(center[0], center[1], center[2]);
  parent.add(fill);

  corners.forEach((c, i) => {
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(handleRadius, 20, 20),
      new THREE.MeshBasicMaterial({ color: handleColor }),
    );
    handle.position.set(c[0], c[1], c[2]);
    handle.userData = { boxId: box.id, cornerIndex: i };
    parent.add(handle);
  });
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}

/**
 * 3DGS renderer with editable bbox overlay.
 *
 * The built-in controls are kept off (`useBuiltInControls: false`) so the
 * library does not install its own pointer handlers that would fight with bbox
 * placement. Instead we drive a plain `OrbitControls` ourselves and add our own
 * pointer logic: drag on a corner handle edits the box, a click (no drag) on a
 * corner selects the box, and a click on empty space places the next bbox
 * corner when the "new box" flow is active.
 */
export function GaussianSplatViewer({
  src,
  format,
  boxes,
  activeId,
  placing,
  draftMin,
  handleRadius,
  lineWidth,
  opacity,
  anchorZRef,
  onPlace,
  onDrag,
  onDragStart,
  onSelectBox,
}: {
  src: string;
  format: SplatFormat;
  boxes: BBoxItem[];
  activeId: string | null;
  placing: boolean;
  draftMin: Vec3 | null;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  anchorZRef: React.MutableRefObject<number>;
  onPlace: (p: Vec3) => void;
  onDrag: (boxId: string, corner: number, position: Vec3) => void;
  onDragStart: (boxId: string) => void;
  onSelectBox: (boxId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GaussianSplats3D.Viewer | null>(null);
  const overlayRef = useRef<THREE.Group | null>(null);
  // Rebuilt overlay cache: per-box groups keyed by box id, so a corner drag
  // only rebuilds the dragged box instead of every box in the scene.
  const overlayCacheRef = useRef<{
    boxGroups: Map<string, { group: THREE.Group; key: string }>;
  }>({ boxGroups: new Map() });
  const draftRef = useRef<THREE.Mesh | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Latest callbacks/state so the once-per-viewer event handlers never go stale.
  const latestRef = useRef({ onPlace, onDrag, onDragStart, onSelectBox, placing });
  latestRef.current = { onPlace, onDrag, onDragStart, onSelectBox, placing };

  // While placing a new box, right-drag on empty space must not pan the camera
  // (right button is reserved for vertical corner drags).
  useEffect(() => {
    const c = controlsRef.current;
    if (c) {
      c.mouseButtons = { ...c.mouseButtons, RIGHT: placing ? null : THREE.MOUSE.PAN };
    }
  }, [placing]);

  // (Re)create the viewer whenever the source changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const threeScene = new THREE.Scene();
    const overlay = new THREE.Group();
    threeScene.add(overlay);
    overlayRef.current = overlay;
    // A new viewer means a fresh overlay: drop the per-box group cache.
    overlayCacheRef.current = { boxGroups: new Map() };

    const viewer = new GaussianSplats3D.Viewer({
      rootElement: container,
      threeScene,
      cameraUp: [0, 0, 1],
      initialCameraPosition: [15, 15, 25],
      initialCameraLookAt: [0, 0, 0],
      // Avoid SharedArrayBuffer / cross-origin-isolation requirements.
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      integerBasedSort: false,
      selfDrivenMode: true,
      // Do NOT use the library's built-in controls: we drive OrbitControls and
      // bbox picking ourselves below so the two never fight over pointer events.
      useBuiltInControls: false,
    });
    let disposed = false;
    let rafId = 0;
    let controls: OrbitControls | null = null;
    let drag: {
      pointerId: number;
      boxId: string;
      corner: number;
      button: number;
      startX: number;
      startY: number;
      startZ: number;
    } | null = null;
    const mouseDownPos = new THREE.Vector2();
    const mouseUpPos = new THREE.Vector2();
    let downBoxId: string | null = null;

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const planeNormal = new THREE.Vector3(0, 0, 1);

    setLoading(true);
    setError(null);

    const setRay = (clientX: number, clientY: number) => {
      const dom = viewer.renderer.domElement;
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, viewer.camera);
      return rect;
    };

    // Pick an exact point on the splat surface using the library's own raycaster.
    const splatPointAt = (clientX: number, clientY: number): Vec3 | null => {
      if (!viewer.raycaster || !viewer.splatMesh) return null;
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      const screenPos = { x: clientX - rect.left, y: clientY - rect.top };
      const dim = new THREE.Vector2(rect.width, rect.height);
      const outHits: Array<{ origin: THREE.Vector3 }> = [];
      viewer.raycaster.setFromCameraAndScreenPosition(viewer.camera, screenPos, dim);
      viewer.raycaster.intersectSplatMesh(viewer.splatMesh, outHits);
      if (outHits.length > 0) {
        const p = outHits[0]!.origin;
        return [p.x, p.y, p.z];
      }
      return null;
    };

    // Project the pointer ray onto the horizontal plane `z = anchorZ` (the
    // splat scene is Z-up, so the horizontal floor is the XY plane).
    const planeAtZ = (clientX: number, clientY: number, z: number): Vec3 | null => {
      setRay(clientX, clientY);
      const plane = new THREE.Plane(planeNormal, -z);
      const hit = new THREE.Vector3();
      const r = raycaster.ray.intersectPlane(plane, hit);
      if (!r) return null;
      return [hit.x, hit.y, hit.z];
    };

    // For vertical (right-button) drags: keep the corner's X/Y fixed and follow
    // the cursor along the scene's up axis (Z). We intersect the pointer ray
    // with a vertical plane through (startX, startY) that faces the camera.
    const verticalZAt = (
      clientX: number,
      clientY: number,
      startX: number,
      startY: number,
    ): Vec3 | null => {
      setRay(clientX, clientY);
      const cameraDir = viewer.camera.getWorldDirection(new THREE.Vector3());
      const horiz = new THREE.Vector3(cameraDir.x, cameraDir.y, 0);
      if (horiz.lengthSq() < 1e-6) horiz.set(1, 0, 0);
      else horiz.normalize();

      const normal = new THREE.Vector3().crossVectors(planeNormal, horiz).normalize();
      const anchor = new THREE.Vector3(startX, startY, 0);
      const plane = new THREE.Plane(normal, -normal.dot(anchor));
      const hit = new THREE.Vector3();
      const r = raycaster.ray.intersectPlane(plane, hit);
      if (!r) return null;
      return [startX, startY, hit.z];
    };

    const pickPoint = (clientX: number, clientY: number, anchorZ: number): Vec3 | null => {
      const splat = splatPointAt(clientX, clientY);
      if (splat) return splat;
      return planeAtZ(clientX, clientY, anchorZ);
    };

    // Raycast the draggable corner spheres.
    const cornerHit = (
      clientX: number,
      clientY: number,
    ): { boxId: string; corner: number; x: number; y: number; z: number } | null => {
      setRay(clientX, clientY);
      overlay.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      overlay.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.userData.cornerIndex !== undefined) meshes.push(m);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return null;
      const obj = hits[0]!.object;
      const worldPos = obj.getWorldPosition(new THREE.Vector3());
      return {
        boxId: obj.userData.boxId as string,
        corner: obj.userData.cornerIndex as number,
        x: worldPos.x,
        y: worldPos.y,
        z: worldPos.z,
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      mouseDownPos.set(e.clientX, e.clientY);
      downBoxId = null;

      // Only left (horizontal) and right (vertical) buttons drag a corner.
      if (e.button !== 0 && e.button !== 2) return;

      const hit = cornerHit(e.clientX, e.clientY);
      if (!hit) return;

      drag = {
        pointerId: e.pointerId,
        boxId: hit.boxId,
        corner: hit.corner,
        button: e.button,
        startX: hit.x,
        startY: hit.y,
        startZ: hit.z,
      };
      downBoxId = hit.boxId;

      latestRef.current.onDragStart(hit.boxId);

      if (controls) controls.enabled = false;
      try {
        viewer.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {}
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const local =
        drag.button === 2
          ? verticalZAt(e.clientX, e.clientY, drag.startX, drag.startY)
          : planeAtZ(e.clientX, e.clientY, drag.startZ);
      if (local) latestRef.current.onDrag(drag.boxId, drag.corner, local);
    };

    const finishDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag = null;
      if (controls) controls.enabled = true;
      try {
        const dom = viewer.renderer.domElement;
        if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      } catch {}
    };

    // OrbitControls skips preventDefault on contextmenu while it is disabled,
    // so suppress the browser menu ourselves during a right-button corner drag.
    const onContextMenu = (e: MouseEvent) => {
      if (drag && drag.button === 2) e.preventDefault();
    };

    const onClick = (e: MouseEvent) => {
      mouseUpPos.set(e.clientX, e.clientY);
      if (mouseDownPos.distanceTo(mouseUpPos) > 3) return; // drag, not click

      if (downBoxId) {
        latestRef.current.onSelectBox(downBoxId);
        return;
      }

      const p = pickPoint(e.clientX, e.clientY, anchorZRef.current);
      if (p) latestRef.current.onPlace(p);
    };

    const animate = () => {
      if (disposed) return;
      rafId = requestAnimationFrame(animate);
      if (controls) controls.update();
    };

    viewer
      .addSplatScene(src, {
        format: FORMAT_TO_SCENE_FORMAT[format],
        showLoadingUI: false,
      })
      .then(() => {
        if (disposed) return;
        viewer.start();

        const dom = viewer.renderer.domElement;
        controls = new OrbitControls(viewer.camera, dom);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.target.set(0, 0, 0);
        // Apply the current placing mode right away: while placing, the right
        // button is reserved for vertical corner drags and must not pan the
        // camera (the `placing` effect above won't re-run for a value that was
        // already true when the controls were created).
        controls.mouseButtons = {
          ...controls.mouseButtons,
          RIGHT: latestRef.current.placing ? null : THREE.MOUSE.PAN,
        };
        controls.update();
        controlsRef.current = controls;

        dom.addEventListener("pointerdown", onPointerDown, { capture: true });
        dom.addEventListener("pointermove", onPointerMove, { capture: true });
        dom.addEventListener("pointerup", finishDrag, { capture: true });
        dom.addEventListener("pointercancel", finishDrag, { capture: true });
        dom.addEventListener("click", onClick, { capture: true });
        dom.addEventListener("contextmenu", onContextMenu, { capture: true });

        animate();
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      const dom = viewer.renderer?.domElement;
      if (dom) {
        dom.removeEventListener("pointerdown", onPointerDown, { capture: true } as any);
        dom.removeEventListener("pointermove", onPointerMove, { capture: true } as any);
        dom.removeEventListener("pointerup", finishDrag, { capture: true } as any);
        dom.removeEventListener("pointercancel", finishDrag, { capture: true } as any);
        dom.removeEventListener("click", onClick, { capture: true } as any);
        dom.removeEventListener("contextmenu", onContextMenu, { capture: true } as any);
      }
      if (controls) controls.dispose();
      // dispose() detaches the canvas from `rootElement`, then tries to remove
      // `rootElement` from document.body — which is not its real parent here,
      // so swallow that final error; all GPU/worker resources are freed before.
      try {
        void viewer.dispose().catch(() => {});
      } catch {}
      overlayRef.current = null;
    };
  }, [src, format]);

  // Update the bbox overlay incrementally: each box's visual is cached by id
  // and only rebuilt when its geometry/style actually changes, so a corner
  // drag rebuilds just the dragged box instead of the whole overlay.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const cache = overlayCacheRef.current;

    const seen = new Set<string>();
    boxes.forEach((box, i) => {
      seen.add(box.id);
      const active = box.id === activeId;
      const key = [
        box.min.join(","),
        box.max.join(","),
        i,
        active,
        handleRadius,
        lineWidth,
        opacity,
      ].join("|");
      const cached = cache.boxGroups.get(box.id);
      if (cached && cached.key === key) return;
      if (cached) {
        overlay.remove(cached.group);
        disposeObject(cached.group);
      }
      const group = new THREE.Group();
      buildBoxVisual(group, box, i, active, handleRadius, lineWidth, opacity);
      overlay.add(group);
      cache.boxGroups.set(box.id, { group, key });
    });

    // Drop visuals of boxes that no longer exist.
    for (const [id, { group }] of cache.boxGroups) {
      if (!seen.has(id)) {
        overlay.remove(group);
        disposeObject(group);
        cache.boxGroups.delete(id);
      }
    }

    // The draft anchor is transient: rebuild it on every change.
    if (draftRef.current) {
      overlay.remove(draftRef.current);
      disposeObject(draftRef.current);
      draftRef.current = null;
    }
    if (placing && draftMin) {
      const draft = new THREE.Mesh(
        new THREE.SphereGeometry(handleRadius, 20, 20),
        new THREE.MeshBasicMaterial({ color: colorForIndex(boxes.length) }),
      );
      draft.position.set(draftMin[0], draftMin[1], draftMin[2]);
      overlay.add(draft);
      draftRef.current = draft;
    }
  }, [boxes, activeId, placing, draftMin, handleRadius, lineWidth, opacity]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {loading && <div style={hintStyle}>Loading 3DGS…</div>}
      {error && (
        <div style={{ ...hintStyle, color: "#ff6b6b", background: "rgba(120,0,0,0.7)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

const hintStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: 14,
  pointerEvents: "none",
};
