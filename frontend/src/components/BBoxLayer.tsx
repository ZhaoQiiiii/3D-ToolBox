import * as THREE from "three";
import { useCallback } from "react";
import type { Axis, DragEntry, Vec3 } from "../lib/bbox";
import {
  cornerPositions,
  boxEdges,
  centerOf,
  sizeOf,
  edgePairs,
  facePairs,
  CENTER_PAIRS,
  upsertDragEntry,
} from "../lib/bbox";
import { CornerHandle } from "./CornerHandle";

interface Props {
  boxId: string;
  min: Vec3;
  max: Vec3;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  color: string;
  active: boolean;
  dragRefs: React.MutableRefObject<DragEntry[]>;
  boxBodyRefs: React.MutableRefObject<{ boxId: string; mesh: THREE.Mesh }[]>;
}

const UP = new THREE.Vector3(0, 1, 0);

const FACES: Array<{ axis: Axis; side: 0 | 1 }> = [
  { axis: 0, side: 0 },
  { axis: 0, side: 1 },
  { axis: 1, side: 0 },
  { axis: 1, side: 1 },
  { axis: 2, side: 0 },
  { axis: 2, side: 1 },
];

/** A single box edge: a visible thin cylinder plus a thicker invisible pick cylinder. */
function EdgeCylinder({
  boxId,
  a,
  b,
  start,
  end,
  radius,
  color,
  dragRefs,
}: {
  boxId: string;
  a: number;
  b: number;
  start: Vec3;
  end: Vec3;
  radius: number;
  color: string;
  dragRefs: React.MutableRefObject<DragEntry[]>;
}) {
  const av = new THREE.Vector3(start[0], start[1], start[2]);
  const bv = new THREE.Vector3(end[0], end[1], end[2]);
  const mid = av.clone().add(bv).multiplyScalar(0.5);
  const dir = bv.clone().sub(av);
  const length = dir.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());

  const key = `${boxId}:edge:${a}-${b}`;
  const setRef = useCallback(
    (el: THREE.Mesh | null) => {
      upsertDragEntry(dragRefs.current, key, { boxId, kind: "edge", pairs: edgePairs(a, b) }, el);
    },
    [boxId, a, b, dragRefs, key],
  );

  const pickRadius = Math.max(0.05, radius * 4);

  return (
    <group>
      <mesh position={mid} quaternion={quaternion}>
        <cylinderGeometry args={[radius, radius, length, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh ref={setRef} position={mid} quaternion={quaternion} visible={false}>
        <cylinderGeometry args={[pickRadius, pickRadius, length, 6]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}

/** An invisible face plane used purely for dragging the box along one axis. */
function FacePlane({
  boxId,
  axis,
  side,
  min,
  max,
  dragRefs,
}: {
  boxId: string;
  axis: Axis;
  side: 0 | 1;
  min: Vec3;
  max: Vec3;
  dragRefs: React.MutableRefObject<DragEntry[]>;
}) {
  const size = sizeOf(min, max);
  const center = centerOf(min, max);

  let position: Vec3;
  let rotation: [number, number, number];
  let w: number;
  let h: number;

  if (axis === 0) {
    position = [side === 0 ? min[0] : max[0], center[1], center[2]];
    rotation = [0, side === 0 ? -Math.PI / 2 : Math.PI / 2, 0];
    w = size[2];
    h = size[1];
  } else if (axis === 1) {
    position = [center[0], side === 0 ? min[1] : max[1], center[2]];
    rotation = [side === 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0];
    w = size[0];
    h = size[2];
  } else {
    position = [center[0], center[1], side === 0 ? min[2] : max[2]];
    rotation = [0, 0, side === 0 ? Math.PI : 0];
    w = size[0];
    h = size[1];
  }

  const key = `${boxId}:face:${axis}:${side}`;
  const setRef = useCallback(
    (el: THREE.Mesh | null) => {
      upsertDragEntry(dragRefs.current, key, { boxId, kind: "face", pairs: facePairs(axis, side) }, el);
    },
    [boxId, axis, side, dragRefs, key],
  );

  return (
    <mesh ref={setRef} position={position} rotation={rotation} visible={false}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial side={THREE.DoubleSide} />
    </mesh>
  );
}

/** A small sphere at the box center used to translate the whole box. */
function CenterHandle({
  boxId,
  position,
  radius,
  color,
  dragRefs,
}: {
  boxId: string;
  position: Vec3;
  radius: number;
  color: string;
  dragRefs: React.MutableRefObject<DragEntry[]>;
}) {
  const key = `${boxId}:center`;
  const setRef = useCallback(
    (el: THREE.Mesh | null) => {
      upsertDragEntry(dragRefs.current, key, { boxId, kind: "center", pairs: CENTER_PAIRS }, el);
    },
    [boxId, dragRefs, key],
  );

  return (
    <mesh ref={setRef} position={position}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

/**
 * Renders a single labelled AABB derived entirely from `min` / `max`:
 * 12 edge cylinders, a semi-transparent fill, 6 face drag planes, a center
 * translation handle and 8 draggable corner spheres.
 */
export function BBoxLayer({
  boxId,
  min,
  max,
  handleRadius,
  lineWidth,
  opacity,
  color,
  active,
  dragRefs,
  boxBodyRefs,
}: Props) {
  const corners = cornerPositions(min, max);
  const edges = boxEdges();
  const center = centerOf(min, max);
  const size = sizeOf(min, max);
  const radius = Math.max(0.0005, lineWidth / 2);

  const edgeColor = active ? color : "#7a7a7a";
  const handleColor = active ? color : "#9a9a9a";
  const fillOpacity = active ? opacity : opacity * 0.55;
  const centerRadius = Math.max(handleRadius * 0.7, 0.04);

  const setBodyRef = useCallback(
    (el: THREE.Mesh | null) => {
      const list = boxBodyRefs.current;
      const idx = list.findIndex((x) => x.boxId === boxId);
      if (el) {
        const entry = { boxId, mesh: el };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      } else if (idx >= 0) {
        list.splice(idx, 1);
      }
    },
    [boxId, boxBodyRefs],
  );

  return (
    <group>
      {edges.map(([a, b], i) => (
        <EdgeCylinder
          key={i}
          boxId={boxId}
          a={a}
          b={b}
          start={corners[a]!}
          end={corners[b]!}
          radius={radius}
          color={edgeColor}
          dragRefs={dragRefs}
        />
      ))}

      {/* Semi-transparent fill; also the click target for selecting the box. */}
      <mesh ref={setBodyRef} position={center}>
        <boxGeometry args={[size[0], size[1], size[2]]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Invisible face drag planes. */}
      {FACES.map((f) => (
        <FacePlane
          key={`${f.axis}-${f.side}`}
          boxId={boxId}
          axis={f.axis}
          side={f.side}
          min={min}
          max={max}
          dragRefs={dragRefs}
        />
      ))}

      {/* Center translation handle. */}
      <CenterHandle
        boxId={boxId}
        position={center}
        radius={centerRadius}
        color={handleColor}
        dragRefs={dragRefs}
      />

      {/* 8 draggable corner spheres. */}
      {corners.map((c, i) => (
        <CornerHandle
          key={i}
          boxId={boxId}
          corner={i}
          position={c}
          radius={handleRadius}
          color={handleColor}
          dragRefs={dragRefs}
        />
      ))}
    </group>
  );
}
