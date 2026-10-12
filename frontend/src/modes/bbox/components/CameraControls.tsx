import { forwardRef } from "react";
import { OrbitControls } from "@react-three/drei";

/**
 * Thin wrapper around drei's OrbitControls so the parent Scene can keep a ref
 * and disable it while a corner handle is being dragged.
 *
 * Zoom is disabled here: wheel navigation is the shared fly-style controller
 * (see shared/fly-camera-controllers.tsx), same as the other two modes.
 */
export const CameraControls = forwardRef<any>(function CameraControls(_props, ref) {
  return (
    <OrbitControls
      ref={ref}
      makeDefault
      enableDamping
      dampingFactor={0.1}
      enableZoom={false}
      rotateSpeed={1.5}
    />
  );
});
