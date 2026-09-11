import { useMemo } from "react";

const X_PTS = new Float32Array([0, 0, 0, 4, 0, 0]);
const Y_PTS = new Float32Array([0, 0, 0, 0, 4, 0]);
const Z_PTS = new Float32Array([0, 0, 0, 0, 0, 4]);

/**
 * ROS-convention world axes: X=red, Y=green, Z=blue, length=4, with arrow cones.
 * Replaces the default Three.js axesHelper.
 */
export function WorldAxes() {
  const xGeo = useMemo(() => new Float32Array(X_PTS), []);
  const yGeo = useMemo(() => new Float32Array(Y_PTS), []);
  const zGeo = useMemo(() => new Float32Array(Z_PTS), []);

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

      <mesh position={[4, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.12, 0.35, 6]} />
        <meshBasicMaterial color="#ff3333" />
      </mesh>
      <mesh position={[0, 4, 0]}>
        <coneGeometry args={[0.12, 0.35, 6]} />
        <meshBasicMaterial color="#33ff33" />
      </mesh>
      <mesh position={[0, 0, 4]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.12, 0.35, 6]} />
        <meshBasicMaterial color="#3388ff" />
      </mesh>
    </group>
  );
}
