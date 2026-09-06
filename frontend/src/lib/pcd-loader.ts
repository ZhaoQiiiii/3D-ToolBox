/**
 * Generic PCD (Point Cloud Data) loader.
 *
 * Parses the header to locate x/y/z fields regardless of field order or
 * padding, and downsamples very large clouds uniformly so parsing + rendering
 * stays responsive in the browser.
 */

export interface PcdMeta {
  points: number;
  fields: string[];
  /** Byte offset of x, y, z within each point record. */
  xOff: number;
  yOff: number;
  zOff: number;
  /** Total bytes per point record (stride). */
  stride: number;
}

export interface PcdResult {
  positions: Float32Array;
  meta: PcdMeta;
}

export async function loadPcd(
  url: string,
  maxPoints: number = Infinity,
): Promise<PcdResult> {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`PCD load failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return parsePcdBuffer(buf, maxPoints);
}

export function parsePcdBuffer(
  buf: ArrayBuffer,
  maxPoints: number = Infinity,
): PcdResult {
  const view = new DataView(buf);
  const headerEnd = findHeaderEnd(view);
  const header = new TextDecoder().decode(new Uint8Array(buf, 0, headerEnd));
  const meta = parseHeader(header);
  const dataOffset = headerEnd + 1; // skip \n after "DATA binary"

  // Uniform downsampling: sample every `stride`-th point so huge clouds stay
  // within a bounded point count without favouring one spatial region.
  const stride = maxPoints < meta.points ? Math.ceil(meta.points / maxPoints) : 1;
  const sampled = Math.ceil(meta.points / stride);

  const positions = new Float32Array(sampled * 3);
  const le = isLittleEndian(view, dataOffset, meta.points, meta.stride, meta.xOff);

  for (let i = 0, o = 0; i < meta.points; i += stride, o++) {
    const base = dataOffset + i * meta.stride;
    positions[o * 3] = view.getFloat32(base + meta.xOff, le);
    positions[o * 3 + 1] = view.getFloat32(base + meta.yOff, le);
    positions[o * 3 + 2] = view.getFloat32(base + meta.zOff, le);
  }

  return { positions, meta: { ...meta, points: sampled } };
}

function findHeaderEnd(view: DataView): number {
  let text = "";
  for (let i = 0; i < Math.min(view.byteLength, 8192); i++) {
    text += String.fromCharCode(view.getUint8(i));
    if (text.includes("DATA binary\n")) return i;
  }
  throw new Error("Could not find PCD header end marker");
}

function parseHeader(header: string): PcdMeta {
  const lines = header.split("\n");

  let points = 0;
  const fieldNames: string[] = [];
  const sizes: number[] = [];
  const types: string[] = [];
  const counts: number[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const key = parts[0];
    if (key === "POINTS") points = parseInt(parts[1]!, 10);
    if (key === "FIELDS") fieldNames.push(...parts.slice(1));
    if (key === "SIZE") sizes.push(...parts.slice(1).map(Number));
    if (key === "TYPE") types.push(...parts.slice(1));
    if (key === "COUNT") counts.push(...parts.slice(1).map(Number));
  }

  if (points <= 0) throw new Error(`Invalid PCD point count: ${points}`);

  // Compute byte offsets for each named field
  const offsets = new Map<string, number>();
  let off = 0;
  for (let i = 0; i < fieldNames.length; i++) {
    offsets.set(fieldNames[i]!, off);
    const byteSize = (sizes[i] ?? 4) * (counts[i] ?? 1);
    off += byteSize;
  }
  const stride = off;

  const xOff = offsets.get("x");
  const yOff = offsets.get("y");
  const zOff = offsets.get("z");
  if (xOff === undefined || yOff === undefined || zOff === undefined) {
    throw new Error(`PCD missing x/y/z fields. Found: ${fieldNames.join(", ")}`);
  }

  return { points, fields: fieldNames, xOff, yOff, zOff, stride };
}

function isLittleEndian(
  view: DataView,
  offset: number,
  points: number,
  stride: number,
  xOff: number,
): boolean {
  if (points === 0) return true;
  const xLe = view.getFloat32(offset + xOff, true);
  // Heuristic: if the value is absurdly large, it's probably BE.
  if (!isFinite(xLe) || Math.abs(xLe) > 1e9) return false;
  return true;
}

// ---- PLY (binary_little_endian) ----

const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

interface PlyMeta {
  vertexCount: number;
  xOff: number;
  yOff: number;
  zOff: number;
  stride: number;
  dataOffset: number;
}

export async function loadPly(
  url: string,
  maxPoints: number = Infinity,
): Promise<PcdResult> {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`PLY load failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return parsePlyBuffer(buf, maxPoints);
}

export function parsePlyBuffer(
  buf: ArrayBuffer,
  maxPoints: number = Infinity,
): PcdResult {
  const meta = readPlyHeader(new Uint8Array(buf));
  const view = new DataView(buf);

  const stride = maxPoints < meta.vertexCount
    ? Math.ceil(meta.vertexCount / maxPoints)
    : 1;
  const sampled = Math.ceil(meta.vertexCount / stride);

  const positions = new Float32Array(sampled * 3);
  for (let i = 0, o = 0; i < meta.vertexCount; i += stride, o++) {
    const base = meta.dataOffset + i * meta.stride;
    positions[o * 3] = view.getFloat32(base + meta.xOff, true);
    positions[o * 3 + 1] = view.getFloat32(base + meta.yOff, true);
    positions[o * 3 + 2] = view.getFloat32(base + meta.zOff, true);
  }

  return {
    positions,
    meta: {
      points: sampled,
      fields: ["x", "y", "z"],
      xOff: meta.xOff,
      yOff: meta.yOff,
      zOff: meta.zOff,
      stride: meta.stride,
    },
  };
}

function readPlyHeader(bytes: Uint8Array): PlyMeta {
  const marker = "end_header";
  let markerEnd = -1;
  for (let i = 0; i + marker.length <= bytes.length; i++) {
    let ok = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      markerEnd = i + marker.length;
      break;
    }
  }
  if (markerEnd < 0) throw new Error("Could not find PLY end_header marker");

  const headerText = new TextDecoder().decode(bytes.subarray(0, markerEnd));
  let dataOffset = markerEnd;
  while (
    dataOffset < bytes.length &&
    (bytes[dataOffset] === 0x0a || bytes[dataOffset] === 0x0d)
  ) {
    dataOffset++;
  }

  let vertexCount = 0;
  const props: { name: string; type: string; size: number }[] = [];
  for (const rawLine of headerText.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length === 0) continue;
    if (parts[0] === "element" && parts[1] === "vertex") {
      vertexCount = parseInt(parts[2]!, 10);
    } else if (parts[0] === "property" && parts[1] === "list") {
      throw new Error("PLY list properties are not supported");
    } else if (parts[0] === "property") {
      const type = parts[1]!;
      const name = parts[2]!;
      const size = PLY_TYPE_SIZE[type];
      if (size === undefined) {
        throw new Error(`Unsupported PLY property type: ${type}`);
      }
      props.push({ name, type, size });
    }
  }

  if (vertexCount <= 0) throw new Error(`Invalid PLY vertex count: ${vertexCount}`);

  const offsets = new Map<string, number>();
  let off = 0;
  for (const p of props) {
    offsets.set(p.name, off);
    off += p.size;
  }
  const stride = off;

  const xOff = offsets.get("x");
  const yOff = offsets.get("y");
  const zOff = offsets.get("z");
  if (xOff === undefined || yOff === undefined || zOff === undefined) {
    throw new Error(
      `PLY missing x/y/z properties. Found: ${props.map((p) => p.name).join(", ")}`,
    );
  }

  return { vertexCount, xOff, yOff, zOff, stride, dataOffset };
}
