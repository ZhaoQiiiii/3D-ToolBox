import { forwardRef } from "react";
import * as THREE from "three";

interface Props {
  positions: Float32Array | null;
  pointSize: number;
  colorHex?: string;
}

/**
 * Renders a single point-cloud layer. bbox_picker only needs one scene-level
 * cloud, so this is a minimal subset of scenegraph_editor's PointCloudLayer.
 */
export const PointCloudView = forwardRef<THREE.Points, Props>(
  function PointCloudView({ positions, pointSize, colorHex = "#aaccff" }, ref) {
    if (!positions || positions.length === 0) return null;
    const count = positions.length / 3;

    return (
      <points ref={ref}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3] as [Float32Array, number]}
            count={count}
          />
        </bufferGeometry>
        <pointsMaterial
          color={colorHex}
          size={pointSize}
          sizeAttenuation
          transparent
          opacity={0.85}
          depthTest
        />
      </points>
    );
  },
);
