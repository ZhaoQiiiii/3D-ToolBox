import * as THREE from "three";
import type { Vec3 } from "../lib/bbox";
import { cornerPositions, boxEdges, centerOf, sizeOf } from "../lib/bbox";
import { CornerHandle } from "./CornerHandle";

interface Props {
  cornerMin: Vec3;
  cornerMax: Vec3;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  color: string;
  handleRefs: React.MutableRefObject<Array<THREE.Mesh | null>>;
}

const UP = new THREE.Vector3(0, 1, 0);

/** A single box edge rendered as a cylinder so `lineWidth` is a real, visible thickness. */
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
  const a = new THREE.Vector3(start[0], start[1], start[2]);
  const b = new THREE.Vector3(end[0], end[1], end[2]);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a);
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
 * Renders an AABB derived entirely from `cornerMin` / `cornerMax`:
 * 12 edge cylinders, a semi-transparent fill and 8 draggable corner spheres.
 * Nothing here owns independent geometry state.
 */
export function BBoxLayer({
  cornerMin,
  cornerMax,
  handleRadius,
  lineWidth,
  opacity,
  color,
  handleRefs,
}: Props) {
  const corners = cornerPositions(cornerMin, cornerMax);
  const edges = boxEdges();
  const center = centerOf(cornerMin, cornerMax);
  const size = sizeOf(cornerMin, cornerMax);
  const radius = Math.max(0.0005, lineWidth / 2);

  return (
    <group>
      {edges.map(([a, b], i) => (
        <EdgeCylinder
          key={i}
          start={corners[a]!}
          end={corners[b]!}
          radius={radius}
          color={color}
        />
      ))}

      {/* Semi-transparent fill */}
      <mesh position={center}>
        <boxGeometry args={[size[0], size[1], size[2]]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* 8 draggable corner spheres */}
      {corners.map((c, i) => (
        <CornerHandle
          key={i}
          position={c}
          radius={handleRadius}
          color={color}
          index={i}
          handleRefs={handleRefs}
        />
      ))}
    </group>
  );
}
