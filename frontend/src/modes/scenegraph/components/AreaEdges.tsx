import { useMemo } from "react";
import { Line } from "@react-three/drei";
import type { PreprocessedArea } from "../lib/types";

interface Props {
  areas: PreprocessedArea[];
  visible: boolean;
}

/** Lines between neighbor area centers (area connectivity graph). */
export function AreaEdges({ areas, visible }: Props) {
  if (!visible) return null;

  const centerMap = useMemo(() => {
    const m = new Map<number, [number, number, number]>();
    for (const a of areas) m.set(a.id, a.center);
    return m;
  }, [areas]);

  const edges = useMemo(() => {
    const drawn = new Set<string>();
    const result: [number, number, number][] = [];
    for (const a of areas) {
      for (const nid of a.neighborIds) {
        const from = centerMap.get(a.id);
        const to = centerMap.get(nid);
        if (!from || !to) continue;
        const key = [a.id, nid].sort().join("-");
        if (drawn.has(key)) continue;
        drawn.add(key);
        result.push(from as [number, number, number]);
        result.push(to as [number, number, number]);
      }
    }
    return result;
  }, [areas, centerMap]);

  // Format as pairs of points for individual Line segments
  const segments = useMemo(() => {
    const segs: [number, number, number][][] = [];
    for (let i = 0; i < edges.length; i += 2) {
      segs.push([edges[i], edges[i + 1]]);
    }
    return segs;
  }, [edges]);

  return (
    <>
      {segments.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color="#888888"
          lineWidth={0.5}
          transparent
          opacity={0.25}
        />
      ))}
    </>
  );
}
