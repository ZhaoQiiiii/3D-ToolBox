/** One sampled pose along a worldmodel-generated trajectory (pi3_local frame). */
export interface TrajPoint {
  x: number;
  y: number;
  z: number;
  yaw_rad: number;
}

export interface TrajectoryData {
  planner: string;
  points: TrajPoint[];
}

/** A browsable step_* directory. */
export interface TrajStep {
  name: string;
  path: string;
  hasTrajectory: boolean;
  hasVideo: boolean;
}

/** Result of GET /api/traj-browse (smart by directory level). */
export interface TrajBrowseResult {
  kind: "step" | "flight" | "dir";
  path: string;
  /** kind === "step" */
  step?: TrajStep;
  /** kind === "flight" | "dir" */
  steps?: TrajStep[];
  /** kind === "dir" */
  flights?: { name: string; path: string }[];
}

/** The subset of prompt.json shown in the info panel. */
export interface PromptInfo {
  task_type?: string;
  target_description?: string;
  original_goal?: string;
}

/** The subset of result.json shown in the info panel (scale calibration). */
export interface ResultInfo {
  wm_task_type?: string;
  status?: string;
  session_tag?: string;
}
