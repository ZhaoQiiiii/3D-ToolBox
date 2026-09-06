import * as THREE from "three";
import type { Vec3 } from "../lib/bbox";

interface Props {
  position: Vec3;
  radius: number;
  color: string;
  index: number;
  handleRefs: React.MutableRefObject<Array<THREE.Mesh | null>>;
}

/**
 * A single draggable corner sphere. The mesh is registered into
 * `handleRefs.current[index]` so the parent Picker can raycast against it and
 * map a drag back to the matching corner component of corner_min/corner_max.
 */
export function CornerHandle({ position, radius, color, index, handleRefs }: Props) {
  return (
    <mesh
      ref={(el) => {
        handleRefs.current[index] = el;
      }}
      position={position}
    >
      <sphereGeometry args={[radius, 20, 20]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}
