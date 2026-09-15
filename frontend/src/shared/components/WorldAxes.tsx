import { useMemo } from "react";

const CONE_RADIUS = 0.08;
const CONE_LENGTH = 0.22;

/**
 * ROS-convention world axes: X=red, Y=green, Z=blue, with arrow cones.
 * Replaces the default Three.js axesHelper. Shared by all three modes; each
 * mode renders it inside its Z-up→Y-up scene group so it tracks the scene's
 * local frame. `length` sets the axis-line length (the arrow cones stay a
 * fixed size as direction markers).
 */
export function WorldAxes({ length = 4 }: { length?: number }) {
  const xGeo = useMemo(() => new Float32Array([0, 0, 0, length, 0, 0]), [length]);
  const yGeo = useMemo(() => new Float32Array([0, 0, 0, 0, length, 0]), [length]);
  const zGeo = useMemo(() => new Float32Array([0, 0, 0, 0, 0, length]), [length]);

  return (
    <group>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[xGeo, 3] as [Float32Array, number]} count={2} />
        </bufferGeometry>
        <lineBasicMaterial color="#ff3333" />
      </lineSegments>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[yGeo, 3] as [Float32Array, number]} count={2} />
        </bufferGeometry>
        <lineBasicMaterial color="#33ff33" />
      </lineSegments>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[zGeo, 3] as [Float32Array, number]} count={2} />
        </bufferGeometry>
        <lineBasicMaterial color="#3388ff" />
      </lineSegments>

      <mesh position={[length, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[CONE_RADIUS, CONE_LENGTH, 6]} />
        <meshBasicMaterial color="#ff3333" />
      </mesh>
      <mesh position={[0, length, 0]}>
        <coneGeometry args={[CONE_RADIUS, CONE_LENGTH, 6]} />
        <meshBasicMaterial color="#33ff33" />
      </mesh>
      <mesh position={[0, 0, length]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[CONE_RADIUS, CONE_LENGTH, 6]} />
        <meshBasicMaterial color="#3388ff" />
      </mesh>
    </group>
  );
}