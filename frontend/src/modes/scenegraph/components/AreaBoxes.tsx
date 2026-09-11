import { useMemo } from "react";
import * as THREE from "three";
import type { PreprocessedArea } from "../lib/types";

interface Props {
  area: PreprocessedArea;
  visible: boolean;
  selected: boolean;
}

const UNIT_BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

/**
 * AABB wireframe box positioned at area center, scaled to area dimensions.
 * Selected areas get an orange highlight; others use their assigned color.
 */
export function AreaBox({ area, visible, selected }: Props) {
  const { boxMin, boxMax, center } = area;

  const size: [number, number, number] = useMemo(
    () => [boxMax[0] - boxMin[0], boxMax[1] - boxMin[1], boxMax[2] - boxMin[2]],
    [boxMin, boxMax],
  );

  if (!visible) return null;

  return (
    <group position={center} scale={size}>
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          color={selected ? "#ff6600" : area.colorHex}
          transparent
          opacity={selected ? 0.12 : 0.03}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={UNIT_BOX_EDGES}>
        <lineBasicMaterial
          color={selected ? "#ff6600" : area.colorHex}
          transparent
          opacity={selected ? 0.9 : 0.35}
        />
      </lineSegments>
    </group>
  );
}
