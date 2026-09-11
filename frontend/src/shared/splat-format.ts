import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

/**
 * Splat scene formats the gaussian-splats-3d library can load directly.
 * Shared by the BBox mode (GaussianSplatViewer) and the SceneGraph mode
 * (GaussianSplatLayer).
 */
export type SplatFormat = "ply" | "splat" | "ksplat" | "spz";

/** Every cloud/splat asset format the tool can render (adds .pcd). */
export type CloudAssetFormat = SplatFormat | "pcd";

export const FORMAT_TO_SCENE_FORMAT: Record<SplatFormat, number> = {
  ply: GaussianSplats3D.SceneFormat.Ply,
  splat: GaussianSplats3D.SceneFormat.Splat,
  ksplat: GaussianSplats3D.SceneFormat.KSplat,
  spz: GaussianSplats3D.SceneFormat.Spz,
};

/** The splat scene format of a file name, or null for non-splat files. */
export function splatFormatOf(name: string): SplatFormat | null {
  const m = /\.(ply|splat|ksplat|spz)$/i.exec(name);
  return m ? (m[1]!.toLowerCase() as SplatFormat) : null;
}

/** The renderable cloud/splat format of a file name, or null if unsupported. */
export function detectCloudFormat(name: string): CloudAssetFormat | null {
  const m = /\.(pcd|ply|splat|ksplat|spz)$/i.exec(name);
  return m ? (m[1]!.toLowerCase() as CloudAssetFormat) : null;
}
