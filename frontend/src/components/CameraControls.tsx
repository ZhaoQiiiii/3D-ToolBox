import { forwardRef } from "react";
import { OrbitControls } from "@react-three/drei";

/**
 * Thin wrapper around drei's OrbitControls so the parent Scene can keep a ref
 * and disable it while a corner handle is being dragged.
 */
export const CameraControls = forwardRef<any>(function CameraControls(_props, ref) {
  return (
    <OrbitControls
      ref={ref}
      enableDamping
      dampingFactor={0.1}
      maxDistance={400}
      minDistance={1}
    />
  );
});
