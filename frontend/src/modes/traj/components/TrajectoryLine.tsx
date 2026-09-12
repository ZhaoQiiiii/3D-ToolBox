import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { TrajPoint } from "../lib/traj-types";

const TRAJ_COLOR = "#1677ff";

interface Props {
  points: TrajPoint[];
  offset: [number, number, number];
  yawDeg: number;
  playIndex: number;
  onGrabStart: (e: ThreeEvent<PointerEvent>) => void;
}

/**
 * Renders a pi3_local trajectory inside the Z-up local frame:
 * blue polyline, per-point yaw cones, green start ring, red end marker and
 * an orange playhead sphere. An invisible grab box around the whole
 * trajectory lets the user drag it (buttons/planes handled by the parent).
 */
export function TrajectoryLine({
  points,
  offset,
  yawDeg,
  playIndex,
  onGrabStart,
}: Props) {
  const linePoints = useMemo(
    () => points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    [points],
  );

  // Bounding box of the raw (unplaced) trajectory for the grab volume.
  const { center, size } = useMemo(() => {
    const box = new THREE.Box3();
    for (const p of points) {
      box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
    }
    return {
      center: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
    };
  }, [points]);

  if (points.length === 0) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const play = points[Math.min(playIndex, points.length - 1)]!;

  return (
    <group position={offset} rotation={[0, 0, (yawDeg * Math.PI) / 180]}>
      {/* Invisible but raycastable grab volume spanning the trajectory. */}
      <mesh position={center} onPointerDown={onGrabStart}>
        <boxGeometry
          args={[
            Math.max(size.x, 0.3),
            Math.max(size.y, 0.3),
            Math.max(size.z, 0.3),
          ]}
        />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {points.length >= 2 && (
        <Line points={linePoints} color={TRAJ_COLOR} lineWidth={2} />
      )}

      {/* Per-point yaw cones (pi3_local: yaw rotates about local Z). */}
      {points.map((p, i) => (
        <group key={i} position={[p.x, p.y, p.z]} rotation={[0, 0, p.yaw_rad]}>
          <mesh rotation={[0, 0, -Math.PI / 2]}>
            <coneGeometry args={[0.03, 0.1, 8]} />
            <meshBasicMaterial color={TRAJ_COLOR} />
          </mesh>
        </group>
      ))}

      {/* Start: green ring on the local floor (XY plane). */}
      <mesh position={[start.x, start.y, start.z]}>
        <ringGeometry args={[0.1, 0.14, 24]} />
        <meshBasicMaterial color="#52c41a" side={THREE.DoubleSide} />
      </mesh>

      {/* End: red wireframe square (mirrors the HTML report's endpoint box). */}
      <mesh position={[end.x, end.y, end.z]}>
        <boxGeometry args={[0.16, 0.16, 0.02]} />
        <meshBasicMaterial color="#f5222d" wireframe />
      </mesh>

      {/* Playhead: orange sphere at the active point. */}
      <mesh position={[play.x, play.y, play.z]}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshBasicMaterial color="#fa8c16" />
      </mesh>
    </group>
  );
}
