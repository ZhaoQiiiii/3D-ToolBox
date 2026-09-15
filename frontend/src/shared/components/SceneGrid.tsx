/**
 * Shared scene grid, driven by `size` (the gridHelper's overall extent).
 *
 * GridHelper's cell size = size / divisions, so to make the "栅格尺度"
 * slider actually change the CELL spacing (not just extend the grid's
 * footprint while every cell stays 1 unit wide) we fix the division count
 * and let `size` vary. `key={size}` forces React/R3F to rebuild the helper
 * on every size change — GridHelper has no setter for its size, so relying
 * on `args` diffing alone is fragile.
 */
const GRID_DIVISIONS = 40;

export function SceneGrid({
  size,
  colorCenter = "#333",
  colorGrid = "#222",
}: {
  size: number;
  colorCenter?: string;
  colorGrid?: string;
}) {
  return (
    <gridHelper
      key={size}
      args={[size, GRID_DIVISIONS, colorCenter, colorGrid]}
    />
  );
}