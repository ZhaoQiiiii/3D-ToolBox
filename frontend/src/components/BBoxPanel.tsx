import { useEffect, useRef, useState } from "react";
import type { Vec3 } from "../lib/bbox";
import { round3 } from "../lib/bbox";

const SLIDER_RANGES: Record<"x" | "y" | "z", [number, number]> = {
  x: [-30.0, 50.0],
  y: [-30.0, 50.0],
  z: [-10.0, 20.0],
};
const SLIDER_RES = 0.05;

interface Props {
  cornerMin: Vec3 | null;
  cornerMax: Vec3 | null;
  center: Vec3 | null;
  size: Vec3 | null;
  pointSize: number;
  saveState: "idle" | "saving" | "saved" | "error";
  copied: boolean;
  cloudFiles: string[];
  selectedCloud: string;
  onSelectCloud: (name: string) => void;
  onSetMin: (v: Vec3) => void;
  onSetMax: (v: Vec3) => void;
  onReset: () => void;
  onSave: () => void;
  onCopy: () => void;
  onPointSize: (v: number) => void;
}

const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 10,
  background: "rgba(0,0,0,0.82)",
  color: "#ccc",
  fontFamily: "monospace",
  borderRadius: 8,
  padding: "14px 16px",
  width: 440,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  fontSize: 14,
};

function statusText(cornerMin: Vec3 | null, cornerMax: Vec3 | null): string {
  if (!cornerMin) return "① 在点云上点击，选择第一个角点";
  if (!cornerMax) return "② 在点云上点击，选择第二个角点";
  return "③ 已框定，可拖拽角点或数值微调";
}

function VecEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
}) {
  const setAxis = (axis: "x" | "y" | "z", n: number) => {
    const next: Vec3 = [...value];
    next[axis === "x" ? 0 : axis === "y" ? 1 : 2] = n;
    onChange(next);
  };

  const axes: Array<{ key: "x" | "y" | "z"; idx: number }> = [
    { key: "x", idx: 0 },
    { key: "y", idx: 1 },
    { key: "z", idx: 2 },
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: "#fff", fontWeight: 600, marginBottom: 2 }}>{label}</div>
      {axes.map(({ key, idx }) => {
        const [min, max] = SLIDER_RANGES[key];
        return (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}
          >
            <span style={{ width: 12, color: "#888" }}>{key}</span>
            <NumberField
              value={value[idx]!}
              step={SLIDER_RES}
              onCommit={(n) => setAxis(key, n)}
            />
            <input
              type="range"
              min={min}
              max={max}
              step={SLIDER_RES}
              value={value[idx]!}
              onChange={(e) => setAxis(key, Number(e.target.value))}
              style={{ flex: 1, accentColor: "#ff5252", height: 4 }}
            />
          </div>
        );
      })}
    </div>
  );
}

function NumberField({
  value,
  step,
  onCommit,
}: {
  value: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(round3(value)));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(round3(value)));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(round3(n));
    else setDraft(String(round3(value)));
  };

  return (
    <input
      type="number"
      step={step}
      value={draft}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focusedRef.current = false;
        commit();
        setDraft(String(round3(value)));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 88,
        background: "#1a1a2e",
        color: "#ddd",
        border: "1px solid #555",
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 12,
      }}
    />
  );
}

export function BBoxPanel({
  cornerMin,
  cornerMax,
  center,
  size,
  pointSize,
  saveState,
  copied,
  cloudFiles,
  selectedCloud,
  onSelectCloud,
  onSetMin,
  onSetMax,
  onReset,
  onSave,
  onCopy,
  onPointSize,
}: Props) {
  const cloudOptions = cloudFiles.includes(selectedCloud)
    ? cloudFiles
    : [selectedCloud, ...cloudFiles];

  return (
    <div data-overlay style={PANEL_STYLE}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>3D-BBox-Tool</div>
      <div style={{ color: "#ff5252", marginTop: 4, fontSize: 12 }}>
        {statusText(cornerMin, cornerMax)}
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ color: "#fff", fontWeight: 600, marginBottom: 2 }}>点云文件</div>
        <select
          value={selectedCloud}
          onChange={(e) => onSelectCloud(e.target.value)}
          style={{
            width: "100%",
            background: "#1a1a2e",
            color: "#ddd",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "4px 6px",
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          {cloudOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {cornerMin && (
        <VecEditor
          label="corner_min"
          value={cornerMin}
          onChange={onSetMin}
        />
      )}
      {cornerMax && (
        <VecEditor
          label="corner_max"
          value={cornerMax}
          onChange={onSetMax}
        />
      )}

      <div style={{ margin: "10px 0 4px", borderTop: "1px solid #333" }} />

      <div style={{ color: "#fff", fontWeight: 600, marginBottom: 4 }}>输出</div>
      {center && size ? (
        <>
          <div style={valueRowStyle}>
            center: {center[0].toFixed(3)}, {center[1].toFixed(3)}, {center[2].toFixed(3)}
          </div>
          <div style={valueRowStyle}>
            size: {size[0].toFixed(3)}, {size[1].toFixed(3)}, {size[2].toFixed(3)}
          </div>
        </>
      ) : (
        <div style={{ color: "#888" }}>（未框定）</div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button type="button" onClick={onCopy} style={btnStyle}>
          {copied ? "已复制" : "复制"}
        </button>
        <button type="button" onClick={onSave} style={btnStyle}>
          {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "保存"}
        </button>
        <button type="button" onClick={onReset} style={btnStyle}>
          重置
        </button>
      </div>

      <div style={{ margin: "10px 0 4px", borderTop: "1px solid #333" }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#888" }}>
        <span>点云大小</span>
        <span>{pointSize.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0.01}
        max={0.5}
        step={0.01}
        value={pointSize}
        onChange={(e) => onPointSize(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#3498db", height: 4 }}
      />
    </div>
  );
}

const valueRowStyle: React.CSSProperties = {
  background: "#111",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "6px 8px",
  color: "#7ee787",
  fontSize: 13,
  marginTop: 4,
};

const btnStyle: React.CSSProperties = {
  flex: 1,
  background: "#1a1a2e",
  color: "#ddd",
  border: "1px solid #555",
  borderRadius: 4,
  padding: "4px 0",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
};
