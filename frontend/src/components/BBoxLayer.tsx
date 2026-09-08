import * as THREE from "three";
import type { DragEntry, Vec3 } from "../lib/bbox";
import { cornerPositions, boxEdges, centerOf, sizeOf } from "../lib/bbox";
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
}

const UP = new THREE.Vector3(0, 1, 0);

/** A visible box edge (thin cylinder, display only). */
function EdgeCylinder({
  start,
  end,
  radius,
  color,
}: {
  start: Vec3;
  end: Vec3;
  radius: number;
  color: string;
}) {
  const av = new THREE.Vector3(start[0], start[1], start[2]);
  const bv = new THREE.Vector3(end[0], end[1], end[2]);
  const mid = av.clone().add(bv).multiplyScalar(0.5);
  const dir = bv.clone().sub(av);
  const length = dir.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());

  return (
    <mesh position={mid} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius, length, 8]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

/**
 * Renders a single labelled AABB: 12 edge cylinders, a semi-transparent fill
 * (visual only) and 8 draggable corner spheres.
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
}: Props) {
  const corners = cornerPositions(min, max);
  const edges = boxEdges();
  const radius = Math.max(0.0005, lineWidth / 2);
  const center = centerOf(min, max);
  const size = sizeOf(min, max);

  const edgeColor = active ? color : "#7a7a7a";
  const handleColor = active ? color : "#9a9a9a";
  const fillOpacity = active ? opacity : opacity * 0.55;

  return (
    <group>
      {edges.map(([a, b], i) => (
        <EdgeCylinder
          key={i}
          start={corners[a]!}
          end={corners[b]!}
          radius={radius}
          color={edgeColor}
        />
      ))}

      <mesh position={center}>
        <boxGeometry args={[size[0], size[1], size[2]]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

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
