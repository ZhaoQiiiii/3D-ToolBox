import { useMemo } from "react";
import type { PreprocessedArea } from "../lib/types";

interface Props {
  areas: PreprocessedArea[];
  visible: boolean;
}

/** Small spheres at area centers for orientation. */
export function AreaCenters({ areas, visible }: Props) {
  if (!visible) return null;

  return (
    <>
      {areas.map((area) => (
        <mesh key={area.id} position={area.center}>
          <sphereGeometry args={[0.08, 8, 6]} />
          <meshBasicMaterial color={area.colorHex} transparent opacity={0.6} />
        </mesh>
      ))}
    </>
  );
}
