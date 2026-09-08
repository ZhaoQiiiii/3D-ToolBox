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
  const { end: headerEnd, dataKind } = findDataLine(view);
  const header = new TextDecoder().decode(new Uint8Array(buf, 0, headerEnd));
  const meta = parseHeader(header);
  const dataOffset = headerEnd + 1; // skip \n after "DATA …"

  // Guard against truncated files: never read past the buffer.
  const available = Math.floor((view.byteLength - dataOffset) / meta.stride);
  const pointCount = Math.min(meta.points, available);
  if (pointCount <= 0) throw new Error("PCD data section is empty or truncated");

  const le = dataKind === "binary_big_endian" ? false : detectLittleEndian(view, dataOffset, pointCount, meta);

  // Uniform downsampling: sample every `stride`-th point so huge clouds stay
  // within a bounded point count without favouring one spatial region.
  const stride = maxPoints < pointCount ? Math.ceil(pointCount / maxPoints) : 1;

  const out: number[] = [];
  for (let i = 0; i < pointCount; i += stride) {
    const base = dataOffset + i * meta.stride;
    const x = view.getFloat32(base + meta.xOff, le);
    const y = view.getFloat32(base + meta.yOff, le);
    const z = view.getFloat32(base + meta.zOff, le);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      out.push(x, y, z);
    }
  }

  return {
    positions: new Float32Array(out),
    meta: { ...meta, points: out.length / 3 },
  };
}

/** Locate the `DATA …` line; returns its end offset and the declared kind. */
function findDataLine(view: DataView): { end: number; dataKind: string } {
  const limit = Math.min(view.byteLength, 8192);
  const text = new TextDecoder().decode(new Uint8Array(view.buffer, 0, limit));
  const m = /(?:^|\n)DATA[ \t]+([a-z_]+)[ \t\r]*(?=\n)/i.exec(text);
  if (!m) throw new Error("Could not find PCD DATA line");
  const dataKind = m[1]!.toLowerCase();
  if (dataKind === "ascii") {
    throw new Error("ASCII PCD is not supported (binary only)");
  }
  if (dataKind !== "binary" && dataKind !== "binary_big_endian") {
    throw new Error(`Unsupported PCD DATA type: ${dataKind}`);
  }
  // m[0] ends right before the terminating \n, so this is its index.
  return { end: m.index + m[0].length, dataKind };
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

  // x/y/z must be 32-bit floats; other layouts would silently read garbage.
  for (const name of ["x", "y", "z"]) {
    const i = fieldNames.indexOf(name);
    const type = types[i];
    const size = sizes[i] ?? 4;
    if (type !== "F" || size !== 4) {
      throw new Error(
        `PCD field '${name}' must be a 32-bit float (got type '${type}', size ${size})`,
      );
    }
  }

  return { points, fields: fieldNames, xOff, yOff, zOff, stride };
}

/**
 * `DATA binary` does not declare endianness (it is the writer's native order).
 * Sample the first few points in both readings: byte-swapped float32s almost
 * always come out non-finite or absurdly large, so pick the sane side.
 */
function detectLittleEndian(
  view: DataView,
  offset: number,
  points: number,
  meta: PcdMeta,
): boolean {
  const n = Math.min(points, 8);
  let leOk = true;
  let beOk = true;
  for (let i = 0; i < n; i++) {
    const base = offset + i * meta.stride;
    for (const off of [meta.xOff, meta.yOff, meta.zOff]) {
      const le = view.getFloat32(base + off, true);
      const be = view.getFloat32(base + off, false);
      if (!Number.isFinite(le) || Math.abs(le) > 1e6) leOk = false;
      if (!Number.isFinite(be) || Math.abs(be) > 1e6) beOk = false;
    }
  }
  if (leOk) return true;
  if (beOk) return false;
  return true; // both look broken; default to LE
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
  /** true when x/y/z are float64 instead of float32 */
  isDouble: boolean;
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

  // Guard against truncated files.
  const available = Math.floor((view.byteLength - meta.dataOffset) / meta.stride);
  const vertexCount = Math.min(meta.vertexCount, available);
  if (vertexCount <= 0) throw new Error("PLY data section is empty or truncated");

  const stride = maxPoints < vertexCount ? Math.ceil(vertexCount / maxPoints) : 1;

  const readCoord = (base: number, off: number): number =>
    meta.isDouble ? view.getFloat64(base + off, true) : view.getFloat32(base + off, true);

  const out: number[] = [];
  for (let i = 0; i < vertexCount; i += stride) {
    const base = meta.dataOffset + i * meta.stride;
    const x = readCoord(base, meta.xOff);
    const y = readCoord(base, meta.yOff);
    const z = readCoord(base, meta.zOff);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      out.push(x, y, z);
    }
  }

  return {
    positions: new Float32Array(out),
    meta: {
      points: out.length / 3,
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
  let format = "";
  const props: { name: string; type: string; size: number }[] = [];
  for (const rawLine of headerText.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length === 0) continue;
    if (parts[0] === "format") {
      format = (parts[1] ?? "").toLowerCase();
    } else if (parts[0] === "element" && parts[1] === "vertex") {
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

  // Only binary_little_endian is supported; anything else would silently
  // produce garbage coordinates (ASCII, big-endian).
  if (format !== "binary_little_endian") {
    throw new Error(
      `Unsupported PLY format: ${format || "(missing format line)"} — only binary_little_endian`,
    );
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

  const coordSizes = props
    .filter((p) => p.name === "x" || p.name === "y" || p.name === "z")
    .map((p) => p.size);
  if (new Set(coordSizes).size > 1) {
    throw new Error("PLY x/y/z must share the same type (float or double)");
  }
  const isDouble = coordSizes[0] === 8;

  return { vertexCount, xOff, yOff, zOff, isDouble, stride, dataOffset };
}
