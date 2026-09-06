import { useMemo } from "react";
import * as THREE from "three";
import type { Vec3 } from "../lib/bbox";
import { cornerPositions, boxEdges, centerOf, sizeOf } from "../lib/bbox";
import { CornerHandle } from "./CornerHandle";

interface Props {
  cornerMin: Vec3;
  cornerMax: Vec3;
  handleRadius: number;
  color: string;
  handleRefs: React.MutableRefObject<Array<THREE.Mesh | null>>;
}

/**
 * Renders an AABB derived entirely from `cornerMin` / `cornerMax`:
 * 12 edge lines, a semi-transparent fill and 8 draggable corner spheres.
 * Nothing here owns independent geometry state.
 */
export function BBoxLayer({ cornerMin, cornerMax, handleRadius, color, handleRefs }: Props) {
  const corners = cornerPositions(cornerMin, cornerMax);
  const edges = boxEdges();
  const center = centerOf(cornerMin, cornerMax);
  const size = sizeOf(cornerMin, cornerMax);

  const linePositions = useMemo(() => {
    const arr = new Float32Array(edges.length * 2 * 3);
    let o = 0;
    for (const [a, b] of edges) {
      const ca = corners[a]!;
      const cb = corners[b]!;
      arr[o++] = ca[0];
      arr[o++] = ca[1];
      arr[o++] = ca[2];
      arr[o++] = cb[0];
      arr[o++] = cb[1];
      arr[o++] = cb[2];
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cornerMin, cornerMax]);

  return (
    <group>
      {/* 12 edge wireframe */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[linePositions, 3] as [Float32Array, number]}
            count={edges.length * 2}
          />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </lineSegments>

      {/* Semi-transparent fill */}
      <mesh position={center}>
        <boxGeometry args={[size[0], size[1], size[2]]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.08}
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
