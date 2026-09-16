import { useMemo } from "react";
import type { PreprocessedArea, PreprocessedPoly } from "../lib/types";

interface Props {
  areas: PreprocessedArea[];
  effectivePolys: PreprocessedPoly[];
  selectedArea: number | null;
}

function buildWireframe(areaPolys: PreprocessedPoly[]): Float32Array[] {
  const wf: Float32Array[] = [];
  for (const p of areaPolys) {
    if (p.edgeIndices.length === 0) continue;
    const w = new Float32Array(p.edgeIndices.length * 3);
    for (let k = 0; k < p.edgeIndices.length; k += 2) {
      const a = p.edgeIndices[k] * 3, b = p.edgeIndices[k + 1] * 3, d = k * 3;
      w[d] = p.positions[a]; w[d + 1] = p.positions[a + 1]; w[d + 2] = p.positions[a + 2];
      w[d + 3] = p.positions[b]; w[d + 4] = p.positions[b + 1]; w[d + 5] = p.positions[b + 2];
    }
    wf.push(w);
  }
  return wf;
}

/** Merged per-area poly wireframe (the poly vertex points were dropped). */
export function PolyhedraAll({ areas, effectivePolys, selectedArea }: Props) {
  const groups = useMemo(() => {
    const areaById = new Map(areas.map((a) => [a.id, a]));
    const areaGroups = areas.map((area) => {
      const areaPolys = effectivePolys.filter((p) => p.areaId === area.id || (p.areaId === 0xffffffff && selectedArea === area.id));
      return {
        areaId: area.id,
        colorHex: area.colorHex,
        wireframeVerts: buildWireframe(areaPolys),
      };
    });

    // Polys whose area was deleted (metadata only) keep rendering as a
    // neutral gray group so the user still sees the retained topology.
    const orphanPolys = effectivePolys.filter(
      (p) => p.areaId !== 0xffffffff && !areaById.has(p.areaId),
    );
    if (orphanPolys.length === 0) return areaGroups;
    return [
      ...areaGroups,
      {
        areaId: -1,
        colorHex: "#888888",
        wireframeVerts: buildWireframe(orphanPolys),
      },
    ];
  }, [areas, effectivePolys, selectedArea]);

  return (
    <>
      {groups.map((g) => {
        const dimmed = selectedArea !== null && selectedArea !== g.areaId;
        return (
          <group key={g.areaId}>
            {g.wireframeVerts.map((wv, wi) => (
              <lineSegments key={wi} visible={!dimmed}>
                <bufferGeometry>
                  <bufferAttribute attach="attributes-position" args={[wv, 3] as [Float32Array, number]} count={wv.length / 3} />
                </bufferGeometry>
                <lineBasicMaterial color={g.colorHex} transparent opacity={0.3} />
              </lineSegments>
            ))}
          </group>
        );
      })}
    </>
  );
}
